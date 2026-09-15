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
import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockSelect } = vi.hoisted(() => ({ mockSelect: vi.fn() }))
vi.mock('../db/client.ts', () => ({ db: { select: mockSelect } }))

import {
  EndpointKeyUnavailableError,
  redactSecret,
  scrubSecret,
} from './endpoint-key-errors.ts'
import {
  clearResolvedKeyCache,
  invalidateResolvedKeysFor,
  MirroredEndpointSource,
  resolvedKeyCacheSize,
  sweepResolvedKeyCache,
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

  it('takes the key and nothing else — the row is what the client declared', async () => {
    queueRows([row({ baseUrl: 'https://declared.example', model: 'text-embedding-3-small' })])
    const fetchImpl = resolverAnswering(200, {
      apiKey: KEY,
      baseUrl: 'https://declared.example',
      model: 'text-embedding-3-small',
      provider: 'openai',
    })
    const endpoint = await new MirroredEndpointSource('pc-1', RESOLVER, {
      fetchImpl,
    }).embedding({ endpointId: 'ep-search-1' })
    expect(endpoint.apiKey).toBe(KEY)
    expect(endpoint.baseUrl).toBe('https://declared.example')
    expect(endpoint.modelName).toBe('text-embedding-3-small')
  })
})

describe('the resolver is believed about the key and nothing else', () => {
  /**
   * The regression this describe exists for.
   *
   * `resolved.model ?? row.model` read as a sensible freshness rule and was a
   * silent corruption: the KB's partition has a vector column sized to the
   * dimension the client declared when it pushed the row, so a resolver
   * answering with a different model embeds the next chunks into a different
   * space in the same table — at a width that may well fit, and that nothing
   * downstream can detect.
   */
  it('refuses an embedding endpoint whose resolver names another model', async () => {
    queueRows([row({ model: 'text-embedding-3-small', dimension: 1536 })])
    const fetchImpl = resolverAnswering(200, {
      apiKey: KEY,
      model: 'text-embedding-3-large',
      provider: 'openai',
    })
    const source = new MirroredEndpointSource('pc-1', RESOLVER, { fetchImpl })
    await expect(source.embedding({ endpointId: 'ep-search-1' })).rejects.toMatchObject({
      name: 'EndpointKeyUnavailableError',
      reason: 'model-mismatch',
      retryable: false,
      endpointId: 'ep-search-1',
    })
  })

  it('refuses an embedding endpoint whose resolver names another provider', async () => {
    queueRows([row({ provider: 'openai' })])
    const fetchImpl = resolverAnswering(200, { apiKey: KEY, provider: 'voyage' })
    const source = new MirroredEndpointSource('pc-1', RESOLVER, { fetchImpl })
    await expect(source.embedding({ endpointId: 'ep-search-1' })).rejects.toMatchObject({
      reason: 'model-mismatch',
      retryable: false,
    })
  })

  it("ignores a resolver's baseUrl and keeps the row's", async () => {
    // A base URL does not move the embedding space on its own, and moving a
    // deployment behind a new URL is a thing clients legitimately do. So: the
    // row's value, a warning, and the job runs.
    queueRows([row({ baseUrl: 'https://declared.example' })])
    const fetchImpl = resolverAnswering(200, {
      apiKey: KEY,
      baseUrl: 'https://somewhere-else.example',
      model: 'text-embedding-3-small',
      provider: 'openai',
    })
    const endpoint = await new MirroredEndpointSource('pc-1', RESOLVER, {
      fetchImpl,
    }).embedding({ endpointId: 'ep-search-1' })
    expect(endpoint.baseUrl).toBe('https://declared.example')
    expect(endpoint.apiKey).toBe(KEY)
  })

  it("ignores an inference resolver's model rather than refusing it", async () => {
    // Keyword extraction has no partition to corrupt.
    queueRows([row({ kind: 'inference', dimension: null, model: 'mistral-small' })])
    const fetchImpl = resolverAnswering(200, { apiKey: KEY, model: 'mistral-large' })
    const endpoint = await new MirroredEndpointSource('pc-1', RESOLVER, {
      fetchImpl,
    }).inference({ endpointId: 'ep-search-1' })
    expect(endpoint?.modelName).toBe('mistral-small')
    expect(endpoint?.apiKey).toBe(KEY)
  })
})

describe('an endpoint row of another paired client', () => {
  it('is refused, terminally, rather than resolved', async () => {
    // Defence in depth behind the route's own check: the row is selected by id
    // alone, so this is the second thing between one client's endpoint id and
    // another client's key.
    queueRows([row({ pairedClientId: 'pc-1' })])
    const fetchImpl = resolverAnswering(200, { apiKey: KEY })
    const source = new MirroredEndpointSource('pc-1', RESOLVER, { fetchImpl })
    await expect(
      source.embedding({ endpointId: 'ep-search-1', pairedClientId: 'pc-2' })
    ).rejects.toMatchObject({
      name: 'EndpointKeyUnavailableError',
      reason: 'client-mismatch',
      retryable: false,
    })
    expect(fetchImpl.calls).toBe(0)
  })

  it('is resolved when the binding names the row owner', async () => {
    queueRows([row({ pairedClientId: 'pc-1' })])
    const fetchImpl = resolverAnswering(200, { apiKey: KEY })
    const source = new MirroredEndpointSource('pc-1', RESOLVER, { fetchImpl })
    const endpoint = await source.embedding({
      endpointId: 'ep-search-1',
      pairedClientId: 'pc-1',
    })
    expect(endpoint.apiKey).toBe(KEY)
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

describe('the resolver URL is refused before it is dialled', () => {
  /**
   * The guard's static half, which is what makes a bad *declaration* terminal
   * rather than five failed attempts. The injected fetch is a witness: it must
   * never be called.
   *
   * `SEARCH_ALLOW_LOCAL_FETCH` is deliberately not set in this describe. It is
   * the switch a single-machine deployment sets, and it is off by default.
   */
  const cases: Array<{ name: string; url: string }> = [
    { name: 'loopback by name', url: 'http://localhost:9000/resolve-endpoint' },
    { name: 'loopback by address', url: 'http://127.0.0.1:9000/resolve-endpoint' },
    { name: 'the link-local metadata service', url: 'http://169.254.169.254/latest/meta-data/' },
    { name: 'a private range', url: 'https://10.0.0.5/resolve-endpoint' },
    { name: 'plain http to a public host', url: 'http://studio.example/resolve-endpoint' },
    { name: 'a blocked port', url: 'https://studio.example:6379/resolve-endpoint' },
  ]

  for (const c of cases) {
    it(`refuses ${c.name}, without asking`, async () => {
      queueRows([row()])
      const fetchImpl = resolverAnswering(200, { apiKey: KEY })
      const source = new MirroredEndpointSource(
        'pc-1',
        { ...RESOLVER, resolverUrl: c.url },
        { fetchImpl }
      )
      await expect(source.embedding({ endpointId: 'ep-search-1' })).rejects.toMatchObject({
        name: 'EndpointKeyUnavailableError',
        reason: 'refused',
        retryable: false,
      })
      expect(fetchImpl.calls).toBe(0)
      expect(resolvedKeyCacheSize()).toBe(0)
    })
  }

  it('allows loopback once SEARCH_ALLOW_LOCAL_FETCH is set', async () => {
    process.env.SEARCH_ALLOW_LOCAL_FETCH = '1'
    try {
      queueRows([row()])
      const fetchImpl = resolverAnswering(200, { apiKey: KEY })
      const source = new MirroredEndpointSource(
        'pc-1',
        { ...RESOLVER, resolverUrl: 'http://127.0.0.1:9000/resolve-endpoint' },
        { fetchImpl }
      )
      await expect(source.embedding({ endpointId: 'ep-search-1' })).resolves.toMatchObject({
        apiKey: KEY,
      })
    } finally {
      delete process.env.SEARCH_ALLOW_LOCAL_FETCH
    }
  })
})

describe('the real call, through secureFetch', () => {
  /**
   * No injected fetch: these drive the production path — the guard, the pinned
   * connection, the refused redirect and the byte cap — against real loopback
   * listeners. `SEARCH_ALLOW_LOCAL_FETCH` is what admits loopback, and it is
   * the same switch a single-machine deployment sets.
   */
  let resolver: http.Server
  let victim: http.Server
  let resolverUrl = ''
  let victimOrigin = ''
  let victimHits = 0
  let answer: (req: http.IncomingMessage, res: http.ServerResponse) => void = (_req, res) =>
    res.end()
  let seenApiKey: string | undefined

  const listen = async (server: http.Server): Promise<number> => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    return (server.address() as AddressInfo).port
  }

  beforeAll(async () => {
    process.env.SEARCH_ALLOW_LOCAL_FETCH = '1'
    resolver = http.createServer((req, res) => {
      seenApiKey = req.headers['x-api-key'] as string | undefined
      answer(req, res)
    })
    victim = http.createServer((req, res) => {
      victimHits += 1
      // If this ever runs, the credential has been handed to a second host.
      seenApiKey = req.headers['x-api-key'] as string | undefined
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ apiKey: 'whatever-you-like' }))
    })
    resolverUrl = `http://127.0.0.1:${await listen(resolver)}/resolve-endpoint`
    victimOrigin = `http://127.0.0.1:${await listen(victim)}`
  })

  afterAll(async () => {
    delete process.env.SEARCH_ALLOW_LOCAL_FETCH
    await new Promise<void>((resolve) => resolver.close(() => resolve()))
    await new Promise<void>((resolve) => victim.close(() => resolve()))
  })

  beforeEach(() => {
    victimHits = 0
    seenApiKey = undefined
  })

  it('resolves a key over the guarded path, sending the credential once', async () => {
    answer = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ apiKey: KEY, provider: 'openai', model: 'text-embedding-3-small' }))
    }
    queueRows([row()])
    const endpoint = await new MirroredEndpointSource('pc-1', {
      ...RESOLVER,
      resolverUrl,
    }).embedding({ endpointId: 'ep-search-1' })
    expect(endpoint.apiKey).toBe(KEY)
    expect(seenApiKey).toBe(RESOLVER.resolverKey)
  })

  it('refuses a redirect instead of re-sending the credential to another host', async () => {
    // The finding, reproduced: Node follows a 307 to another origin and carries
    // both the `x-api-key` header and the POST body with it.
    answer = (_req, res) => {
      res.writeHead(307, { location: `${victimOrigin}/resolve-endpoint` })
      res.end()
    }
    queueRows([row()])
    const source = new MirroredEndpointSource('pc-1', { ...RESOLVER, resolverUrl })
    await expect(source.embedding({ endpointId: 'ep-search-1' })).rejects.toMatchObject({
      name: 'EndpointKeyUnavailableError',
      reason: 'refused',
      retryable: false,
    })
    expect(victimHits).toBe(0)
    expect(seenApiKey).toBe(RESOLVER.resolverKey)
  })

  it('refuses an answer larger than the cap rather than parsing it', async () => {
    answer = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      // A well-formed resolution, followed by a kilobyte of padding.
      res.end(JSON.stringify({ apiKey: KEY, padding: 'x'.repeat(4096) }))
    }
    queueRows([row()])
    const source = new MirroredEndpointSource(
      'pc-1',
      { ...RESOLVER, resolverUrl },
      { maxResponseBytes: 256 }
    )
    const err = await source
      .embedding({ endpointId: 'ep-search-1' })
      .then(() => null)
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(EndpointKeyUnavailableError)
    expect((err as EndpointKeyUnavailableError).reason).toBe('malformed')
    expect((err as Error).message).toMatch(/256 bytes/)
    // And nothing was cached, so the next job asks again.
    expect(resolvedKeyCacheSize()).toBe(0)
  })
})

describe('the cache is bounded and can be invalidated', () => {
  it('drops one client’s entries and leaves another’s', async () => {
    const fetchImpl = resolverAnswering(200, { apiKey: KEY })
    queueRows([row()])
    await new MirroredEndpointSource('pc-1', RESOLVER, { fetchImpl }).embedding({
      endpointId: 'ep-search-1',
    })
    queueRows([row({ pairedClientId: 'pc-2' })])
    await new MirroredEndpointSource('pc-2', RESOLVER, { fetchImpl }).embedding({
      endpointId: 'ep-search-1',
    })
    expect(resolvedKeyCacheSize()).toBe(2)

    expect(invalidateResolvedKeysFor('pc-1')).toBe(1)
    expect(resolvedKeyCacheSize()).toBe(1)

    // pc-1 asks again and the resolver is called a third time; pc-2's entry is
    // still good, so it is not.
    queueRows([row()])
    await new MirroredEndpointSource('pc-1', RESOLVER, { fetchImpl }).embedding({
      endpointId: 'ep-search-1',
    })
    expect(fetchImpl.calls).toBe(3)
  })

  it('sweeps expired entries on insert rather than waiting to be read', async () => {
    // Forty endpoints resolved once each and never looked at again: without the
    // sweep every one of them is a live provider key held for the life of the
    // process, because the lazy TTL check only runs on a read that never comes.
    const fetchImpl = resolverAnswering(200, { apiKey: KEY })
    let clock = 1_000
    for (let i = 0; i < 5; i += 1) {
      queueRows([row({ externalId: `ws-endpoint-${i}` })])
      await new MirroredEndpointSource('pc-1', RESOLVER, {
        fetchImpl,
        now: () => clock,
      }).embedding({ endpointId: 'ep-search-1' })
    }
    expect(resolvedKeyCacheSize()).toBe(5)

    clock += 60_001
    queueRows([row({ externalId: 'ws-endpoint-new' })])
    await new MirroredEndpointSource('pc-1', RESOLVER, {
      fetchImpl,
      now: () => clock,
    }).embedding({ endpointId: 'ep-search-1' })

    // The five that expired went on the insert of the sixth.
    expect(resolvedKeyCacheSize()).toBe(1)
  })

  it('reports what a direct sweep dropped', () => {
    expect(sweepResolvedKeyCache(Date.now())).toBe(0)
  })
})
