/**
 * @vitest-environment node
 *
 * The endpoint registry against a live Postgres — the functions
 * `PUT /v1/endpoints` calls (TASK-004).
 *
 * These are asserted against a real database rather than a mocked one because
 * every interesting property here *is* the database: the partial unique index
 * that makes a push an upsert, the check constraint that refuses an embedding
 * endpoint with no dimension, the cascade that takes endpoints with a paired
 * client, and the jsonb column migration 0002 added.
 *
 * And two invariants that are the point of the module:
 *
 *   * **No function here returns a key.** A listing reports `hasKey`.
 *   * **A mirrored row has no key to return.** A push over a local row strips
 *     the ciphertext, because two sources for one endpoint is the ambiguity
 *     this module exists not to have.
 *
 * Gated on `SEARCH_TEST_DATABASE_URL`.
 */

import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { generateShortId } from '@actana/search-shared/short-id'
import { resetConfig } from '../config.ts'

const TEST_DATABASE_URL = process.env.SEARCH_TEST_DATABASE_URL
if (TEST_DATABASE_URL) process.env.SEARCH_DATABASE_URL = TEST_DATABASE_URL
// A real 32-byte key: `createLocalEndpoint` and `setEndpointSource` both seal.
process.env.SEARCH_ENCRYPTION_KEY = 'a'.repeat(64)
resetConfig()

const { db } = await import('../db/client.ts')
const { modelEndpoint, pairedClient } = await import('../db/schema.ts')
const { runMigrations } = await import('../db/migrate.ts')
const registry = await import('./endpoint-registry.ts')
const { decryptSecret } = await import('../core/security/encryption.ts')

const describeDb = TEST_DATABASE_URL ? describe : describe.skip

const PREFIX = `searchreg-${generateShortId(8)}`
const CLIENT = `${PREFIX}-client`
const RESOLVER_KEY = 'internal-secret-abcdefghijklmnop'

describeDb('the endpoint registry', () => {
  beforeAll(async () => {
    await runMigrations({ url: TEST_DATABASE_URL! })
    await db.insert(pairedClient).values({
      id: CLIENT,
      label: `${PREFIX} client`,
      certSerial: `${PREFIX}-serial`,
      certFingerprint: `${PREFIX}-fingerprint`,
      scope: 'admin',
      status: 'active',
      createdAt: new Date(),
    })
  }, 120_000)

  afterAll(async () => {
    // Cascades to `model_endpoint`.
    await db.delete(pairedClient).where(eq(pairedClient.id, CLIENT)).catch(() => {})
  })

  describe('the source declaration', () => {
    it('reads a client that has declared nothing as local', async () => {
      expect(await registry.getEndpointSourceDeclaration(CLIENT)).toEqual({ kind: 'local' })
      expect(await registry.getEndpointSourceSummary(CLIENT)).toEqual({ kind: 'local' })
      const source = await registry.getEndpointSourceFor(CLIENT)
      expect(source.constructor.name).toBe('LocalEndpointSource')
    })

    it('seals the resolver credential rather than storing it', async () => {
      const summary = await registry.setEndpointSource(CLIENT, {
        kind: 'mirrored',
        resolverUrl: 'https://studio.example/api/search/resolve-endpoint',
        resolverKey: RESOLVER_KEY,
        resolverScope: 'workspace-42',
      })
      expect(summary).toEqual({
        kind: 'mirrored',
        resolverUrl: 'https://studio.example/api/search/resolve-endpoint',
        resolverScope: 'workspace-42',
      })
      // The summary a route may return carries no credential, sealed or not.
      expect(JSON.stringify(summary)).not.toContain(RESOLVER_KEY)

      const [row] = await db
        .select({ endpointSource: pairedClient.endpointSource })
        .from(pairedClient)
        .where(eq(pairedClient.id, CLIENT))
      const stored = row!.endpointSource as Record<string, string>
      expect(JSON.stringify(stored)).not.toContain(RESOLVER_KEY)
      expect(stored.resolverKeyCiphertext).toMatch(/^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/)
      // …and it is the same credential, recoverable only with the instance key.
      expect((await decryptSecret(stored.resolverKeyCiphertext!)).decrypted).toBe(RESOLVER_KEY)
    })

    it('hands a mirrored client a mirrored source, with the scope it declared', async () => {
      const source = await registry.getEndpointSourceFor(CLIENT)
      expect(source.constructor.name).toBe('MirroredEndpointSource')
      const resolver = await registry.openResolver(
        CLIENT,
        await registry.getEndpointSourceDeclaration(CLIENT),
      )
      expect(resolver.resolverScope).toBe('workspace-42')
      expect(resolver.resolverKey).toBe(RESOLVER_KEY)
    })

    it('refuses a resolver url that is not one, before writing anything', async () => {
      await expect(
        registry.setEndpointSource(CLIENT, {
          kind: 'mirrored',
          resolverUrl: 'not a url',
          resolverKey: RESOLVER_KEY,
        }),
      ).rejects.toThrow(/is not a resolver URL/)
      await expect(
        registry.setEndpointSource(CLIENT, {
          kind: 'mirrored',
          resolverUrl: 'file:///etc/passwd',
          resolverKey: RESOLVER_KEY,
        }),
      ).rejects.toThrow(/reached over http/)
      await expect(
        registry.setEndpointSource(CLIENT, {
          kind: 'mirrored',
          resolverUrl: 'https://studio.example/x',
          resolverKey: '',
        }),
      ).rejects.toThrow(/needs a resolverKey/)
      // Still the declaration from the successful call above.
      expect((await registry.getEndpointSourceDeclaration(CLIENT)).kind).toBe('mirrored')
    })

    it('refuses to declare a source for a client that is not paired', async () => {
      await expect(
        registry.setEndpointSource('no-such-client', { kind: 'local' }),
      ).rejects.toThrow(/no paired client/)
    })

    it('goes back to local', async () => {
      await registry.setEndpointSource(CLIENT, { kind: 'local' })
      expect(await registry.getEndpointSourceDeclaration(CLIENT)).toEqual({ kind: 'local' })
      await expect(
        registry.openResolver(CLIENT, { kind: 'local' }),
      ).rejects.toMatchObject({ reason: 'not-configured', retryable: false })
    })
  })

  describe('createLocalEndpoint', () => {
    it('seals the key and does not hand it back', async () => {
      const endpoint = await registry.createLocalEndpoint(
        CLIENT,
        {
          kind: 'embedding',
          provider: 'openai',
          template: 'openai',
          model: 'text-embedding-3-small',
          dimensions: 1536,
          label: 'primary',
        },
        'sk-local-0123456789abcdef',
      )
      expect(endpoint).toMatchObject({
        kind: 'embedding',
        provider: 'openai',
        dimensions: 1536,
        source: 'local',
        hasKey: true,
        externalId: null,
      })
      expect(JSON.stringify(endpoint)).not.toContain('sk-local')

      const [row] = await db
        .select()
        .from(modelEndpoint)
        .where(eq(modelEndpoint.id, endpoint.id))
      expect(row!.keyCiphertext).not.toBe('sk-local-0123456789abcdef')
      expect((await decryptSecret(row!.keyCiphertext!)).decrypted).toBe(
        'sk-local-0123456789abcdef',
      )
    })

    it('refuses an embedding endpoint with no dimension, and an endpoint with no key', async () => {
      await expect(
        registry.createLocalEndpoint(
          CLIENT,
          { kind: 'embedding', provider: 'openai', template: 'openai', model: 'm' },
          'sk-x-0123456789',
        ),
      ).rejects.toThrow(/needs a dimension/)
      await expect(
        registry.createLocalEndpoint(
          CLIENT,
          { kind: 'inference', provider: 'openai', template: 'openai', model: 'm' },
          '',
        ),
      ).rejects.toThrow(/needs an API key/)
    })

    it('leaves the dimension null on an inference endpoint, as the check demands', async () => {
      const endpoint = await registry.createLocalEndpoint(
        CLIENT,
        {
          kind: 'inference',
          provider: 'openai',
          template: 'openai',
          model: 'gpt-4o-mini',
          // Passed and ignored: the check constraint forbids it for this kind,
          // so the registry drops it rather than letting Postgres refuse.
          dimensions: 1536,
        },
        'sk-inference-0123456789',
      )
      expect(endpoint.dimensions).toBeNull()
    })
  })

  describe('upsertMirroredEndpoints', () => {
    const externalId = `${PREFIX}-ext-1`

    it('returns the id map the pushing client stores', async () => {
      const mapped = await registry.upsertMirroredEndpoints(CLIENT, [
        {
          externalId,
          kind: 'embedding',
          provider: 'openai',
          template: 'openai',
          model: 'text-embedding-3-small',
          dimensions: 1536,
        },
      ])
      expect(mapped).toEqual([{ id: expect.any(String), externalId }])
    })

    it('upserts on (client, externalId) rather than piling up rows', async () => {
      const first = await registry.upsertMirroredEndpoints(CLIENT, [
        {
          externalId,
          kind: 'embedding',
          provider: 'openai',
          template: 'openai',
          model: 'text-embedding-3-small',
          dimensions: 1536,
        },
      ])
      const second = await registry.upsertMirroredEndpoints(CLIENT, [
        {
          externalId,
          kind: 'embedding',
          provider: 'openai',
          template: 'openai',
          // The client changed the model. Same row.
          model: 'text-embedding-3-large',
          dimensions: 3072,
        },
      ])
      expect(second[0]!.id).toBe(first[0]!.id)

      const rows = await db
        .select()
        .from(modelEndpoint)
        .where(eq(modelEndpoint.externalId, externalId))
      expect(rows).toHaveLength(1)
      expect(rows[0]!.model).toBe('text-embedding-3-large')
      expect(rows[0]!.dimension).toBe(3072)
    })

    it('never writes a key, and strips one a row used to have', async () => {
      // A row that was local, with a sealed key…
      const local = await registry.createLocalEndpoint(
        CLIENT,
        {
          kind: 'embedding',
          provider: 'voyage',
          template: 'voyage',
          model: 'voyage-3',
          dimensions: 1024,
        },
        'sk-was-local-0123456789',
      )
      await db
        .update(modelEndpoint)
        .set({ externalId: `${PREFIX}-ext-2` })
        .where(eq(modelEndpoint.id, local.id))

      // …becomes a mirror when the client pushes it.
      await registry.upsertMirroredEndpoints(CLIENT, [
        {
          externalId: `${PREFIX}-ext-2`,
          kind: 'embedding',
          provider: 'voyage',
          template: 'voyage',
          model: 'voyage-3',
          dimensions: 1024,
        },
      ])
      const [row] = await db.select().from(modelEndpoint).where(eq(modelEndpoint.id, local.id))
      expect(row!.source).toBe('mirrored')
      expect(row!.keyCiphertext).toBeNull()
    })

    it('refuses a push with no external id — the resolver would have nothing to ask about', async () => {
      await expect(
        registry.upsertMirroredEndpoints(CLIENT, [
          {
            externalId: '  ',
            kind: 'embedding',
            provider: 'openai',
            template: 'openai',
            dimensions: 8,
          },
        ]),
      ).rejects.toThrow(/needs an externalId/)
    })
  })

  describe('listEndpoints and deleteEndpoint', () => {
    it('lists the endpoints of one client and never a key', async () => {
      const endpoints = await registry.listEndpoints(CLIENT)
      expect(endpoints.length).toBeGreaterThan(0)
      const json = JSON.stringify(endpoints)
      expect(json).not.toContain('sk-')
      expect(json).not.toContain(RESOLVER_KEY)
      for (const endpoint of endpoints) {
        expect(endpoint).not.toHaveProperty('keyCiphertext')
        expect(typeof endpoint.hasKey).toBe('boolean')
      }
      // A mirrored row's key is always one resolver call away.
      expect(endpoints.filter((e) => e.source === 'mirrored').every((e) => e.hasKey)).toBe(true)
    })

    it('deletes one this client owns and refuses one it does not', async () => {
      const [first] = await registry.listEndpoints(CLIENT)
      expect(await registry.deleteEndpoint(CLIENT, first!.id)).toBe(true)
      expect(await registry.deleteEndpoint(CLIENT, first!.id)).toBe(false)
      expect(await registry.deleteEndpoint('some-other-client', first!.id)).toBe(false)
    })
  })
})
