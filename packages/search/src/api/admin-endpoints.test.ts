/**
 * The two `/admin/endpoints` routes (TASK-005).
 *
 * They exist because a standalone instance has to be given an embedding key
 * before it can ingest anything, and `PUT /v1/endpoints` — the authenticated
 * way — lands with TASK-004. The header of `admin-server.ts` says so and marks
 * them for removal.
 *
 * What is asserted here is the part that does *not* go away: the refusals. An
 * embedding endpoint with no dimension is a partition that cannot be created; a
 * client left unnamed on an instance with two paired clients is a provider key
 * registered against the wrong one, which is not a mistake the next command
 * would reveal. And nothing on the way out carries a key.
 *
 * The server is started on a real Unix socket with the registry injected, so
 * this suite needs no database.
 *
 * @vitest-environment node
 */
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  startAdminServer,
  type AdminEndpointPort,
  type AdminServer,
  type LocalEndpointDraft,
} from './admin-server.ts'
import type { PairingRevocations } from '../pairing/pairing-revocation.ts'
import type { SearchPairingStore } from '../pairing/pairing-store.ts'

type Client = { id: string; revokedAt: number | null }

let dir: string
let socketPath: string
let admin: AdminServer | undefined
let clients: Client[]
let created: Array<{ clientId: string; input: LocalEndpointDraft; apiKey: string }>

const KEY = 'sk-registered-0123456789abcdef'

const endpoints: AdminEndpointPort = {
  listEndpoints: async (clientId) => [
    {
      id: 'ep-1',
      externalId: null,
      kind: 'embedding',
      provider: 'openai',
      template: 'openai',
      model: 'text-embedding-3-small',
      dimensions: 1536,
      baseUrl: null,
      label: clientId,
      source: 'local',
      hasKey: true,
      createdAt: '2026-09-15T12:00:00.000Z',
      updatedAt: '2026-09-15T12:00:00.000Z',
    },
  ],
  createLocalEndpoint: async (clientId, input, apiKey) => {
    created.push({ clientId, input, apiKey })
    return {
      id: 'ep-new',
      externalId: null,
      ...input,
      source: 'local',
      // What the real registry returns: whether there is a key, never the key.
      hasKey: true,
      createdAt: '2026-09-15T12:00:00.000Z',
      updatedAt: '2026-09-15T12:00:00.000Z',
    }
  },
}

/** One request on the socket, the way the CLI's `AdminClient` makes them. */
function call(
  method: 'GET' | 'POST',
  route: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const payload = body === undefined ? '' : JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath,
        path: route,
        method,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : undefined })
        })
      },
    )
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

async function start(): Promise<void> {
  admin = await startAdminServer({
    store: { listClients: async () => clients } as unknown as SearchPairingStore,
    revocations: { refresh: async () => {} } as unknown as PairingRevocations,
    socketPath,
    bearerSecret: 'a'.repeat(64),
    caFingerprint: 'AA:BB',
    endpoint: 'https://localhost:7443',
    audit: () => {},
    endpoints,
  })
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'actana-search-adminep-'))
  socketPath = path.join(dir, 'admin.sock')
  clients = [{ id: 'pc-1', revokedAt: null }]
  created = []
})

afterEach(async () => {
  await admin?.close()
  admin = undefined
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('POST /admin/endpoints', () => {
  beforeEach(start)

  it('registers a local endpoint against the only paired client', async () => {
    const res = await call('POST', '/admin/endpoints', {
      kind: 'embedding',
      provider: 'openai',
      model: 'text-embedding-3-small',
      dimensions: 1536,
      apiKey: KEY,
    })
    expect(res.status).toBe(200)
    expect(created).toEqual([
      {
        clientId: 'pc-1',
        input: expect.objectContaining({
          kind: 'embedding',
          provider: 'openai',
          // Defaulted to the provider's own name, which is right for every
          // first-party template in the catalog.
          template: 'openai',
          model: 'text-embedding-3-small',
          dimensions: 1536,
        }),
        apiKey: KEY,
      },
    ])
    // The response carries `hasKey`, and not the key.
    expect(res.body.endpoint.hasKey).toBe(true)
    expect(JSON.stringify(res.body)).not.toContain(KEY)
  })

  it('keeps an explicit template', async () => {
    await call('POST', '/admin/endpoints', {
      kind: 'inference',
      provider: 'google',
      template: 'google-genai',
      model: 'gemini-2.0-flash',
      apiKey: KEY,
    })
    expect(created[0]!.input.template).toBe('google-genai')
    // Forbidden for this kind by the table's check constraint.
    expect(created[0]!.input.dimensions).toBeNull()
  })

  it('refuses an embedding endpoint with no dimension', async () => {
    const res = await call('POST', '/admin/endpoints', {
      kind: 'embedding',
      provider: 'openai',
      model: 'm',
      apiKey: KEY,
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/needs `dimensions`|dimensions/)
    expect(created).toHaveLength(0)
  })

  it('refuses a kind that is neither, a missing provider and a missing key', async () => {
    expect((await call('POST', '/admin/endpoints', { kind: 'reranking' })).status).toBe(400)
    expect(
      (await call('POST', '/admin/endpoints', { kind: 'inference', apiKey: KEY })).status,
    ).toBe(400)
    expect(
      (await call('POST', '/admin/endpoints', { kind: 'inference', provider: 'openai' })).status,
    ).toBe(400)
    expect(created).toHaveLength(0)
  })

  it('refuses to guess when two clients are paired', async () => {
    clients = [
      { id: 'pc-1', revokedAt: null },
      { id: 'pc-2', revokedAt: null },
    ]
    const res = await call('POST', '/admin/endpoints', {
      kind: 'inference',
      provider: 'openai',
      model: 'm',
      apiKey: KEY,
    })
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('ambiguous-client')
    expect(res.body.error).toContain('--client')
    expect(created).toHaveLength(0)
  })

  it('takes the named client when there are two', async () => {
    clients = [
      { id: 'pc-1', revokedAt: null },
      { id: 'pc-2', revokedAt: null },
    ]
    const res = await call('POST', '/admin/endpoints', {
      pairedClientId: 'pc-2',
      kind: 'inference',
      provider: 'openai',
      model: 'm',
      apiKey: KEY,
    })
    expect(res.status).toBe(200)
    expect(created[0]!.clientId).toBe('pc-2')
  })

  it('refuses a client that is not paired, and one that has been revoked', async () => {
    clients = [{ id: 'pc-1', revokedAt: 1 }]
    const res = await call('POST', '/admin/endpoints', {
      pairedClientId: 'pc-1',
      kind: 'inference',
      provider: 'openai',
      model: 'm',
      apiKey: KEY,
    })
    // A revoked client is not an active one, so a request that *names* it is
    // answered as a name that is not there rather than as "nothing is paired":
    // the operator has a specific id in hand and is owed a specific answer.
    expect(res.status).toBe(404)
    expect(res.body.error).toContain('pc-1')
  })

  it('says so when nothing is paired at all', async () => {
    clients = []
    const res = await call('POST', '/admin/endpoints', {
      kind: 'inference',
      provider: 'openai',
      model: 'm',
      apiKey: KEY,
    })
    expect(res.status).toBe(409)
    expect(res.body.error).toContain('pair new')
  })

  it('does not put the body in the message when the registry throws', async () => {
    const boom: AdminEndpointPort = {
      listEndpoints: endpoints.listEndpoints,
      createLocalEndpoint: async () => {
        throw new Error('SEARCH_ENCRYPTION_KEY must be set to a 64-character hex string')
      },
    }
    await admin!.close()
    admin = await startAdminServer({
      store: { listClients: async () => clients } as unknown as SearchPairingStore,
      revocations: { refresh: async () => {} } as unknown as PairingRevocations,
      socketPath,
      bearerSecret: 'a'.repeat(64),
      caFingerprint: 'AA:BB',
      endpoint: 'https://localhost:7443',
      audit: () => {},
      endpoints: boom,
    })
    const res = await call('POST', '/admin/endpoints', {
      kind: 'inference',
      provider: 'openai',
      model: 'm',
      apiKey: KEY,
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('SEARCH_ENCRYPTION_KEY')
    expect(JSON.stringify(res.body)).not.toContain(KEY)
  })
})

describe('GET /admin/endpoints', () => {
  beforeEach(start)

  it('lists the only paired client with no flag', async () => {
    const res = await call('GET', '/admin/endpoints')
    expect(res.status).toBe(200)
    expect(res.body.pairedClientId).toBe('pc-1')
    expect(res.body.endpoints).toHaveLength(1)
  })

  it('takes ?client= when more than one is paired', async () => {
    clients = [
      { id: 'pc-1', revokedAt: null },
      { id: 'pc-2', revokedAt: null },
    ]
    expect((await call('GET', '/admin/endpoints')).status).toBe(400)
    const res = await call('GET', '/admin/endpoints?client=pc-2')
    expect(res.status).toBe(200)
    expect(res.body.pairedClientId).toBe('pc-2')
  })

  it('404s a client that is not there', async () => {
    const res = await call('GET', '/admin/endpoints?client=ghost')
    expect(res.status).toBe(404)
  })
})
