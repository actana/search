/**
 * `MirroredEndpointSource`: the TTL, the never-store rule, the redaction, and
 * the four resolver failures (ADR 0004, ADR 0010).
 *
 * The invariant this suite is really about is the last one. A provider key is
 * the most valuable thing that passes through this module, and the way it
 * escapes is never a `console.log` somebody wrote on purpose — it is a resolver
 * that answered something unexpected and an error message that helpfully
 * included the body. So: a case that resolves a real key and then asserts on the
 * thrown error's `message` *and* `stack`.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockSelect } = vi.hoisted(() => ({ mockSelect: vi.fn() }))
vi.mock('../db/client.ts', () => ({ db: { select: mockSelect } }))

import {
  EndpointKeyUnavailableError,
  redactSecret,
  scrubSecret,
} from './endpoint-key-errors.ts'
import {
  clearResolvedKeyCache,
  MirroredEndpointSource,
  resolvedKeyCacheSize,
  type FetchLike,
} from './mirrored-endpoint-source.ts'

const KEY = 'sk-live-do-not-log-me-0123456789'
const RESOLVER = {
  resolverUrl: 'https://studio.example/api/search/resolve-endpoint',
  resolverKey: 'internal-secret-abcdefghij',
}

/** One mirrored embedding row, as `model_endpoint` holds it. */
function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ep-search-1',
    pairedClientId: 'pc-1',
    kind: 'embedding',
    provider: 'openai',
    template: 'openai',
    model: 'text-embedding-3-small',
    dimension: 1536,
    baseUrl: null,
    keyCiphertext: null,
    source: 'mirrored',
    externalId: 'ws-endpoint-7',
    label: null,
    config: {},
    ...overrides,
  }
}

/** Queue the rows the next `db.select().from().where().limit()` resolves to. */
function queueRows(rows: unknown[]) {
  mockSelect.mockReturnValueOnce({
    from: () => ({ where: () => ({ limit: () => Promise.resolve(rows) }) }),
  })
}

/** A resolver that answers `body` with `status`, counting its calls. */
function resolverAnswering(status: number, body: unknown): FetchLike & { calls: number } {
  const impl: FetchLike & { calls: number } = Object.assign(
    async (): Promise<Response> => {
      impl.calls += 1
      return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      })
    },
    { calls: 0 }
  )
  return impl
}

beforeEach(() => {
  vi.clearAllMocks()
  clearResolvedKeyCache()
})
afterEach(() => {
  clearResolvedKeyCache()
})

describe('resolving a key', () => {
  it('asks the resolver with x-api-key and the declared scope as workspaceId', async () => {
    const seen: { url?: string; init?: RequestInit } = {}
    const fetchImpl: FetchLike = async (url, init) => {
      seen.url = url
      seen.init = init
      return new Response(JSON.stringify({ apiKey: KEY, provider: 'openai' }), { status: 200 })
    }
    queueRows([row()])
    const source = new MirroredEndpointSource(
      'pc-1',
      { ...RESOLVER, resolverScope: 'workspace-42' },
      { fetchImpl }
    )

    const endpoint = await source.embedding({ endpointId: 'ep-search-1' })

    expect(endpoint.apiKey).toBe(KEY)
    expect(endpoint.dimensions).toBe(1536)
    expect(seen.url).toBe(RESOLVER.resolverUrl)
    expect((seen.init?.headers as Record<string, string>)['x-api-key']).toBe(
      RESOLVER.resolverKey
    )
    expect(JSON.parse(String(seen.init?.body))).toEqual({
      workspaceId: 'workspace-42',
      externalId: 'ws-endpoint-7',
    })
  })

  it('falls back to the paired client id when no scope was declared', async () => {
    let body = ''
    const fetchImpl: FetchLike = async (_url, init) => {
      body = String(init.body)
      return new Response(JSON.stringify({ apiKey: KEY }), { status: 200 })
    }
    queueRows([row()])
    await new MirroredEndpointSource('pc-1', RESOLVER, { fetchImpl }).embedding({
      endpointId: 'ep-search-1',
    })
    expect(JSON.parse(body).workspaceId).toBe('pc-1')
  })

  it("prefers the resolver's baseUrl and model over the mirrored row's", async () => {
    queueRows([row({ baseUrl: 'https://stale.example', model: 'stale-model' })])
    const fetchImpl = resolverAnswering(200, {
      apiKey: KEY,
      baseUrl: 'https://live.example',
      model: 'text-embedding-3-large',
      provider: 'openai',
    })
    const endpoint = await new MirroredEndpointSource('pc-1', RESOLVER, {
      fetchImpl,
    }).embedding({ endpointId: 'ep-search-1' })
    expect(endpoint.baseUrl).toBe('https://live.example')
    expect(endpoint.modelName).toBe('text-embedding-3-large')
  })
})

describe('the sixty-second cache', () => {
  it('resolves once for repeated jobs on the same endpoint', async () => {
    const fetchImpl = resolverAnswering(200, { apiKey: KEY })
    let clock = 1_000
    const source = new MirroredEndpointSource('pc-1', RESOLVER, {
      fetchImpl,
      now: () => clock,
    })

    queueRows([row()])
    await source.embedding({ endpointId: 'ep-search-1' })
    queueRows([row()])
    await source.embedding({ endpointId: 'ep-search-1' })
    clock += 59_000
    queueRows([row()])
    await source.embedding({ endpointId: 'ep-search-1' })

    expect(fetchImpl.calls).toBe(1)
    expect(resolvedKeyCacheSize()).toBe(1)
  })

  it('resolves again once the entry is older than the TTL', async () => {
    const fetchImpl = resolverAnswering(200, { apiKey: KEY })
    let clock = 1_000
    const source = new MirroredEndpointSource('pc-1', RESOLVER, {
      fetchImpl,
      now: () => clock,
    })
    queueRows([row()])
    await source.embedding({ endpointId: 'ep-search-1' })
    clock += 60_001
    queueRows([row()])
    await source.embedding({ endpointId: 'ep-search-1' })
    expect(fetchImpl.calls).toBe(2)
  })

  it('does not hand one client a key cached for another', async () => {
    const fetchImpl = resolverAnswering(200, { apiKey: KEY })
    queueRows([row()])
    await new MirroredEndpointSource('pc-1', RESOLVER, { fetchImpl }).embedding({
      endpointId: 'ep-search-1',
    })
    queueRows([row({ pairedClientId: 'pc-2' })])
    await new MirroredEndpointSource('pc-2', RESOLVER, { fetchImpl }).embedding({
      endpointId: 'ep-search-1',
    })
    expect(fetchImpl.calls).toBe(2)
    expect(resolvedKeyCacheSize()).toBe(2)
  })

  it('collapses concurrent misses into one resolver call', async () => {
    let calls = 0
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const fetchImpl: FetchLike = async () => {
      calls += 1
      await gate
      return new Response(JSON.stringify({ apiKey: KEY }), { status: 200 })
    }
    const source = new MirroredEndpointSource('pc-1', RESOLVER, { fetchImpl })
    queueRows([row()])
    queueRows([row()])
    queueRows([row()])
    const all = Promise.all([
      source.embedding({ endpointId: 'ep-search-1' }),
      source.embedding({ endpointId: 'ep-search-1' }),
      source.embedding({ endpointId: 'ep-search-1' }),
    ])
    release?.()
    const resolved = await all
    expect(calls).toBe(1)
    expect(resolved.every((e) => e.apiKey === KEY)).toBe(true)
  })

  it('never writes a key to the endpoint row', async () => {
    // The row object the source was handed is the one the table would hold.
    // Nothing in this module may put the resolved key on it.
    const mirrored = row()
    queueRows([mirrored])
    const fetchImpl = resolverAnswering(200, { apiKey: KEY })
    await new MirroredEndpointSource('pc-1', RESOLVER, { fetchImpl }).embedding({
      endpointId: 'ep-search-1',
    })
    expect(mirrored.keyCiphertext).toBeNull()
    expect(JSON.stringify(mirrored)).not.toContain(KEY)
  })
})

describe('resolver failures are typed', () => {
  const cases: Array<{
    name: string
    status: number
    body: unknown
    reason: string
    retryable: boolean
  }> = [
    {
      name: '404 — the client forgot the endpoint',
      status: 404,
      body: { error: 'not found' },
      reason: 'unknown-endpoint',
      retryable: false,
    },
    {
      name: '401 — the internal credential is stale',
      status: 401,
      body: { error: 'nope' },
      reason: 'unauthorized',
      retryable: true,
    },
    {
      name: '500 — the client is having a bad day',
      status: 500,
      body: { error: 'boom' },
      reason: 'resolver-error',
      retryable: true,
    },
    {
      name: '200 without an apiKey',
      status: 200,
      body: { provider: 'openai' },
      reason: 'malformed',
      retryable: true,
    },
    {
      name: '200 that is not JSON',
      status: 200,
      body: 'not json at all',
      reason: 'malformed',
      retryable: true,
    },
  ]

  for (const c of cases) {
    it(c.name, async () => {
      queueRows([row()])
      const fetchImpl = resolverAnswering(c.status, c.body)
      const source = new MirroredEndpointSource('pc-1', RESOLVER, { fetchImpl })
      const err = await source
        .embedding({ endpointId: 'ep-search-1' })
        .then(() => null)
        .catch((e: unknown) => e)
      expect(err).toBeInstanceOf(EndpointKeyUnavailableError)
      const typed = err as EndpointKeyUnavailableError
      expect(typed.reason).toBe(c.reason)
      expect(typed.retryable).toBe(c.retryable)
      expect(typed.externalId).toBe('ws-endpoint-7')
      expect(typed.pairedClientId).toBe('pc-1')
      // A failed resolution is not cached: the next job must try again.
      expect(resolvedKeyCacheSize()).toBe(0)
    })
  }

  it('reports a timeout as a retryable timeout', async () => {
    queueRows([row()])
    const fetchImpl: FetchLike = async () => {
      const err = new Error('The operation was aborted due to timeout')
      err.name = 'TimeoutError'
      throw err
    }
    const source = new MirroredEndpointSource('pc-1', RESOLVER, { fetchImpl, timeoutMs: 5 })
    await expect(source.embedding({ endpointId: 'ep-search-1' })).rejects.toMatchObject({
      name: 'EndpointKeyUnavailableError',
      reason: 'timeout',
      retryable: true,
    })
  })

  it('reports an unreachable resolver as retryable', async () => {
    queueRows([row()])
    const fetchImpl: FetchLike = async () => {
      throw new Error('connect ECONNREFUSED 10.0.0.1:443')
    }
    const source = new MirroredEndpointSource('pc-1', RESOLVER, { fetchImpl })
    await expect(source.embedding({ endpointId: 'ep-search-1' })).rejects.toMatchObject({
      reason: 'unreachable',
      retryable: true,
    })
  })

  it('refuses a mirrored row with no external id, and does not retry it', async () => {
    queueRows([row({ externalId: null })])
    const fetchImpl = resolverAnswering(200, { apiKey: KEY })
    const source = new MirroredEndpointSource('pc-1', RESOLVER, { fetchImpl })
    await expect(source.embedding({ endpointId: 'ep-search-1' })).rejects.toMatchObject({
      reason: 'not-mirrored',
      retryable: false,
    })
    expect(fetchImpl.calls).toBe(0)
  })
})

describe('nothing that is thrown carries the key', () => {
  it('keeps a resolved key out of an error message and stack', async () => {
    // The resolver answers 200 *with a live key* and then the endpoint turns
    // out to be the wrong kind — the shape of failure most likely to have a
    // body in scope when it builds its message.
    queueRows([row({ kind: 'inference' })])
    const fetchImpl = resolverAnswering(200, { apiKey: KEY })
    const source = new MirroredEndpointSource('pc-1', RESOLVER, { fetchImpl })

    const err = await source
      .embedding({ endpointId: 'ep-search-1' })
      .then(() => null)
      .catch((e: unknown) => e)

    expect(err).toBeInstanceOf(Error)
    const thrown = err as Error
    expect(thrown.message).not.toContain(KEY)
    expect(thrown.stack ?? '').not.toContain(KEY)
    expect(JSON.stringify(thrown, Object.getOwnPropertyNames(thrown))).not.toContain(KEY)
  })

  it('never puts the resolver credential in a message either', async () => {
    queueRows([row()])
    const fetchImpl: FetchLike = async () => {
      throw new Error(`upstream said x-api-key=${RESOLVER.resolverKey} was wrong`)
    }
    const source = new MirroredEndpointSource('pc-1', RESOLVER, { fetchImpl })
    const err = (await source
      .embedding({ endpointId: 'ep-search-1' })
      .catch((e: unknown) => e)) as Error
    expect(err.message).not.toContain(RESOLVER.resolverKey)
    expect(err.stack ?? '').not.toContain(RESOLVER.resolverKey)
  })

  it('names the resolver by origin only, never by full URL', async () => {
    queueRows([row()])
    const fetchImpl = resolverAnswering(503, { error: 'unavailable' })
    const source = new MirroredEndpointSource(
      'pc-1',
      { ...RESOLVER, resolverUrl: 'https://studio.example/resolve?token=leak-me-please' },
      { fetchImpl }
    )
    const err = (await source
      .embedding({ endpointId: 'ep-search-1' })
      .catch((e: unknown) => e)) as Error
    expect(err.message).toContain('https://studio.example')
    expect(err.message).not.toContain('leak-me-please')
  })
})

describe('the redaction helpers', () => {
  it('replaces every occurrence of a secret', () => {
    expect(redactSecret(`a ${KEY} b ${KEY}`, KEY)).toBe('a [redacted] b [redacted]')
  })

  it('leaves a short or absent secret alone rather than shredding the text', () => {
    expect(redactSecret('a very ordinary sentence', 'a')).toBe('a very ordinary sentence')
    expect(redactSecret('unchanged', null)).toBe('unchanged')
    expect(redactSecret('unchanged', '')).toBe('unchanged')
  })

  it('scrubs an error in place and hands the same instance back', () => {
    const err = new EndpointKeyUnavailableError(`boom ${KEY}`, { reason: 'malformed' })
    const scrubbed = scrubSecret(err, KEY)
    expect(scrubbed).toBe(err)
    expect(scrubbed.message).toBe('boom [redacted]')
    expect(scrubbed).toBeInstanceOf(EndpointKeyUnavailableError)
  })
})
