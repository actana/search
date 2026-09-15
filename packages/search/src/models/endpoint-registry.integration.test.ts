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

import { eq, inArray } from 'drizzle-orm'
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

    /**
     * The three properties `PUT /v1/endpoints` needs from the local path, and
     * the reason this function is an upsert at all.
     *
     * The route is declarative: a client sends the set of endpoints it wants to
     * exist, on pairing and again on every edit, and anything left out is
     * reconciled away. An insert-only local path meant the second push created
     * a second row and the reconciliation then reaped the first — which is a
     * KB's `embedding_endpoint_id` pointing at a row that has gone. So: the
     * same `externalId` is the same row; a push that says nothing about the key
     * leaves the sealed ciphertext where it is; and a push that carries one
     * replaces it.
     */
    it('upserts a local endpoint on its externalId, and keeps the key when told nothing', async () => {
      const externalId = `${PREFIX}-local-ext`
      const first = await registry.createLocalEndpoint(
        CLIENT,
        {
          externalId,
          kind: 'embedding',
          provider: 'openai',
          template: 'openai',
          model: 'text-embedding-3-small',
          dimensions: 1536,
          label: 'first',
        },
        'sk-first-0123456789abcdef',
      )
      expect(first.externalId).toBe(externalId)
      expect(first.hasKey).toBe(true)

      // The second push: new metadata, and `null` for the key — which is what
      // the route passes when the declaration carried no `apiKey`.
      const second = await registry.createLocalEndpoint(
        CLIENT,
        {
          externalId,
          kind: 'embedding',
          provider: 'openai',
          template: 'openai',
          model: 'text-embedding-3-large',
          dimensions: 1536,
          label: 'renamed',
        },
        null,
      )
      expect(second.id).toBe(first.id)
      expect(second.model).toBe('text-embedding-3-large')
      expect(second.label).toBe('renamed')
      expect(second.hasKey).toBe(true)

      // One row, and the original ciphertext, byte for byte.
      const rows = await db
        .select()
        .from(modelEndpoint)
        .where(eq(modelEndpoint.externalId, externalId))
      expect(rows).toHaveLength(1)
      expect((await decryptSecret(rows[0]!.keyCiphertext!)).decrypted).toBe(
        'sk-first-0123456789abcdef',
      )

      // And a push that does carry one replaces it.
      await registry.createLocalEndpoint(
        CLIENT,
        {
          externalId,
          kind: 'embedding',
          provider: 'openai',
          template: 'openai',
          model: 'text-embedding-3-large',
          dimensions: 1536,
        },
        'sk-rotated-0123456789abcdef',
      )
      const [rotated] = await db
        .select()
        .from(modelEndpoint)
        .where(eq(modelEndpoint.externalId, externalId))
      expect((await decryptSecret(rotated!.keyCiphertext!)).decrypted).toBe(
        'sk-rotated-0123456789abcdef',
      )
    })

    it('leaves a row with no externalId out of the upsert, so two are two rows', async () => {
      // The admin socket's path, which predates the route. Unreconciled by
      // construction: nothing can address it by a client-side id, so nothing
      // upserts onto it and the route's reconciliation never reaps it.
      const one = await registry.createLocalEndpoint(
        CLIENT,
        { kind: 'inference', provider: 'openai', template: 'openai', model: 'gpt-4o-mini' },
        'sk-anon-1-0123456789',
      )
      const two = await registry.createLocalEndpoint(
        CLIENT,
        { kind: 'inference', provider: 'openai', template: 'openai', model: 'gpt-4o-mini' },
        'sk-anon-2-0123456789',
      )
      expect(one.externalId).toBeNull()
      expect(two.externalId).toBeNull()
      expect(two.id).not.toBe(one.id)
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

  describe('the resolver URL goes through the SSRF guard at declaration', () => {
    /**
     * `http(s)` was the whole of the check, which accepted the instance's own
     * metadata service and the operator's internal network — reachable from
     * inside the deployment and from nowhere else, and dialled with an internal
     * credential in a header. Refusing here is what makes it a `400` to the
     * client that asked rather than a failed job three days later.
     */
    const refused = [
      'http://localhost:9000/resolve-endpoint',
      'http://127.0.0.1:9000/resolve-endpoint',
      'http://169.254.169.254/latest/meta-data/',
      'https://10.0.0.5/resolve-endpoint',
      'https://192.168.1.10/resolve-endpoint',
      'http://studio.example/resolve-endpoint',
      'https://studio.example:5432/resolve-endpoint',
    ]

    for (const resolverUrl of refused) {
      it(`refuses ${resolverUrl}`, async () => {
        await expect(
          registry.setEndpointSource(CLIENT, {
            kind: 'mirrored',
            resolverUrl,
            resolverKey: RESOLVER_KEY,
          }),
        ).rejects.toThrow(/resolverUrl/)
      })
    }

    it('admits loopback when SEARCH_ALLOW_LOCAL_FETCH is set — one machine, one host', async () => {
      process.env.SEARCH_ALLOW_LOCAL_FETCH = '1'
      try {
        const summary = await registry.setEndpointSource(CLIENT, {
          kind: 'mirrored',
          resolverUrl: 'http://127.0.0.1:3000/api/search/resolve-endpoint',
          resolverKey: RESOLVER_KEY,
        })
        expect(summary).toMatchObject({
          kind: 'mirrored',
          resolverUrl: 'http://127.0.0.1:3000/api/search/resolve-endpoint',
        })
      } finally {
        delete process.env.SEARCH_ALLOW_LOCAL_FETCH
      }
    })

    it('writes nothing when the URL is refused', async () => {
      // The loopback declaration above is still what the column holds: a
      // refusal happens before the `UPDATE`.
      const declaration = await registry.getEndpointSourceDeclaration(CLIENT)
      expect(declaration).toMatchObject({ kind: 'mirrored' })
      await expect(
        registry.setEndpointSource(CLIENT, {
          kind: 'mirrored',
          resolverUrl: 'https://10.0.0.5/resolve-endpoint',
          resolverKey: RESOLVER_KEY,
        }),
      ).rejects.toThrow(/resolverUrl/)
      expect(await registry.getEndpointSourceDeclaration(CLIENT)).toEqual(declaration)
    })
  })

  describe('a sealed credential that will not open', () => {
    it('is a terminal typed failure rather than a cipher error', async () => {
      // A rotated `SEARCH_ENCRYPTION_KEY`, in the only shape a test can make
      // one: a ciphertext this key did not seal. Untyped it reaches the worker
      // as "this job failed" and burns five attempts against a ciphertext that
      // will not open on the fifth either (ADR 0010 D7).
      await expect(
        registry.openResolver(CLIENT, {
          kind: 'mirrored',
          resolverUrl: 'https://studio.example/api/search/resolve-endpoint',
          resolverKeyCiphertext: `${'0'.repeat(32)}:deadbeef:${'1'.repeat(32)}`,
          resolverScope: null,
        }),
      ).rejects.toMatchObject({
        name: 'EndpointKeyUnavailableError',
        reason: 'decrypt-failed',
        retryable: false,
        pairedClientId: CLIENT,
      })
    })
  })

  describe('a write invalidates that client’s resolved keys', () => {
    it('drops the cached key when the source is re-declared', async () => {
      const mirrored = await import('./mirrored-endpoint-source.ts')
      mirrored.clearResolvedKeyCache()

      const [pushed] = await registry.upsertMirroredEndpoints(CLIENT, [
        {
          externalId: `${PREFIX}-cache-endpoint`,
          kind: 'embedding',
          provider: 'openai',
          template: 'openai',
          model: 'text-embedding-3-small',
          dimensions: 1536,
        },
      ])

      const source = new mirrored.MirroredEndpointSource(
        CLIENT,
        { resolverUrl: 'https://studio.example/api/search/resolve-endpoint', resolverKey: 'x' },
        {
          fetchImpl: async () =>
            new Response(
              JSON.stringify({
                apiKey: 'sk-live-cached-for-a-minute',
                provider: 'openai',
                model: 'text-embedding-3-small',
              }),
              { status: 200 },
            ),
        },
      )
      await source.embedding({ endpointId: pushed!.id })
      expect(mirrored.resolvedKeyCacheSize()).toBe(1)

      // The declaration changes. A minute of serving keys fetched under the old
      // one is not a long time and is still the wrong answer to "I have just
      // revoked that".
      await registry.setEndpointSource(CLIENT, {
        kind: 'mirrored',
        resolverUrl: 'https://studio.example/api/search/resolve-endpoint',
        resolverKey: `${RESOLVER_KEY}-rotated`,
      })
      expect(mirrored.resolvedKeyCacheSize()).toBe(0)
    })

    it('drops it when the endpoint is deleted, and when the catalog is re-pushed', async () => {
      const mirrored = await import('./mirrored-endpoint-source.ts')
      const push = async () =>
        (
          await registry.upsertMirroredEndpoints(CLIENT, [
            {
              externalId: `${PREFIX}-cache-endpoint-2`,
              kind: 'embedding',
              provider: 'openai',
              template: 'openai',
              model: 'text-embedding-3-small',
              dimensions: 1536,
            },
          ])
        )[0]!
      const pushed = await push()
      const source = new mirrored.MirroredEndpointSource(
        CLIENT,
        { resolverUrl: 'https://studio.example/api/search/resolve-endpoint', resolverKey: 'x' },
        {
          fetchImpl: async () =>
            new Response(
              JSON.stringify({
                apiKey: 'sk-live-cached-for-a-minute',
                provider: 'openai',
                model: 'text-embedding-3-small',
              }),
              { status: 200 },
            ),
        },
      )

      await source.embedding({ endpointId: pushed.id })
      expect(mirrored.resolvedKeyCacheSize()).toBe(1)
      await push()
      expect(mirrored.resolvedKeyCacheSize()).toBe(0)

      await source.embedding({ endpointId: pushed.id })
      expect(mirrored.resolvedKeyCacheSize()).toBe(1)
      expect(await registry.deleteEndpoint(CLIENT, pushed.id)).toBe(true)
      expect(mirrored.resolvedKeyCacheSize()).toBe(0)
    })
  })

  describe('one client’s endpoint id does not resolve for another', () => {
    it('is refused by the source layer, not only by the route', async () => {
      // Two clients, one endpoint id. The route is the primary check — a caller
      // may only name a KB its certificate owns (ADR 0003) — and this is the
      // second thing standing between an id that got past it and somebody
      // else's key.
      const OTHER = `${PREFIX}-other-client`
      await db.insert(pairedClient).values({
        id: OTHER,
        label: `${PREFIX} other`,
        certSerial: `${PREFIX}-other-serial`,
        certFingerprint: `${PREFIX}-other-fingerprint`,
        scope: 'admin',
        status: 'active',
        createdAt: new Date(),
      })
      try {
        const mine = await registry.createLocalEndpoint(
          CLIENT,
          {
            kind: 'embedding',
            provider: 'openai',
            template: 'openai',
            model: 'text-embedding-3-small',
            dimensions: 1536,
          },
          'sk-live-mine-and-nobody-elses',
        )

        const { RoutingEndpointSource } = await import('./routing-endpoint-source.ts')
        const routing = new RoutingEndpointSource()

        // The owner gets it.
        await expect(
          routing.embedding({ endpointId: mine.id, pairedClientId: CLIENT }),
        ).resolves.toMatchObject({ id: mine.id })

        // The other client does not, and is told so terminally.
        await expect(
          routing.embedding({ endpointId: mine.id, pairedClientId: OTHER }),
        ).rejects.toMatchObject({
          name: 'EndpointKeyUnavailableError',
          reason: 'client-mismatch',
          retryable: false,
        })
      } finally {
        await db.delete(pairedClient).where(eq(pairedClient.id, OTHER)).catch(() => {})
      }
    })
  })
  /**
   * The blocker, at both layers. `config` is a `z.record(z.unknown())` on the
   * wire and `PUT /v1/endpoints` passes it through, so
   * `config.apiKeyEndpointId` was a free choice of any endpoint id in the
   * instance — and an id is a public value, answered by that very route. Client
   * B could declare an endpoint keyed on client A's, bind a KB to it, and embed
   * a corpus with A's sealed key, with nothing in either client's view of the
   * instance to show it.
   */
  describe('a key link may only name this client’s own endpoint', () => {
    const LINKER = `${PREFIX}-linker`
    const KEYHOLDER = `${PREFIX}-keyholder`
    let foreignEndpointId: string

    beforeAll(async () => {
      await db.insert(pairedClient).values(
        [LINKER, KEYHOLDER].map((id, i) => ({
          id,
          label: `${PREFIX} ${id}`,
          certSerial: `${PREFIX}-serial-link-${i}`,
          certFingerprint: `${PREFIX}-fingerprint-link-${i}`,
          scope: 'admin' as const,
          status: 'active' as const,
          createdAt: new Date(),
        })),
      )
      const held = await registry.createLocalEndpoint(
        KEYHOLDER,
        {
          kind: 'embedding',
          provider: 'openai',
          template: 'openai',
          model: 'text-embedding-3-small',
          dimensions: 1536,
          label: 'the key somebody else paid for',
        },
        'sk-the-other-clients-key-0123456789',
      )
      foreignEndpointId = held.id
    }, 60_000)

    afterAll(async () => {
      await db
        .delete(pairedClient)
        .where(inArray(pairedClient.id, [LINKER, KEYHOLDER]))
        .catch(() => {})
    })

    it('refuses the declaration at the route, naming the id', async () => {
      const { applyEndpointDeclaration } = await import('../api/routes/endpoints.ts')
      const refused = await applyEndpointDeclaration(LINKER, {
        source: { kind: 'local' },
        endpoints: [
          {
            externalId: 'borrowed',
            kind: 'inference',
            provider: 'openai',
            model: 'gpt-4o-mini',
            label: 'borrowed',
            config: { apiKeyEndpointId: foreignEndpointId },
          },
        ],
      })
        .then(() => null)
        .catch((err: unknown) => err as Error & { status?: number })

      expect(refused?.message).toMatch(/not one of your endpoints/)
      // A statement about the request, so a 400 rather than the router's
      // catch-all 500.
      expect(refused?.status).toBe(400)
      // And nothing written.
      expect(await registry.listEndpoints(LINKER)).toEqual([])
    })

    /**
     * The same check, order-independent (the fix round's NIT #1) — **and the
     * link actually leading to the key afterwards** (the follow-up round's
     * SHOULD-FIX #1).
     *
     * Two things used to be wrong here and only the first was fixed. The
     * linkable set was grown *as* the write loop created rows, so a body whose
     * first endpoint was keyed on its second was refused and the same body in
     * the other order was accepted — a declaration answered by the order the
     * client happened to serialise it in. Both halves are now collected before
     * the first row is written, and the endpoint below names a sibling that
     * comes *after* it in the body.
     *
     * The acceptance was then only half an answer. `externalId` was stored in
     * `config.apiKeyEndpointId` exactly as it arrived, and nothing reads it
     * that way: `resolveEndpointApiKey` selects `model_endpoint.id`, which
     * `createLocalEndpoint` mints from `generateId()`. So the borrower was
     * written `hasKey: false` and resolved to an empty key — a `200` that
     * failed on the first embed, minutes later, in a job. The last three
     * assertions are that it resolves.
     */
    it('accepts a link to an endpoint the same body declares later, and it resolves', async () => {
      const { applyEndpointDeclaration } = await import('../api/routes/endpoints.ts')
      const { resolveEndpointApiKey } = await import('./endpoint-api-key.ts')
      const KEY = 'sk-mine-and-declared-here-0123456789'
      const written = await applyEndpointDeclaration(LINKER, {
        source: { kind: 'local' },
        endpoints: [
          {
            externalId: 'the-borrower',
            kind: 'inference',
            provider: 'openai',
            model: 'gpt-4o-mini',
            label: 'keyed on the one below it',
            config: { apiKeyEndpointId: 'the-keyholder' },
          },
          {
            externalId: 'the-keyholder',
            kind: 'embedding',
            provider: 'openai',
            template: 'openai',
            model: 'text-embedding-3-small',
            dimensions: 1536,
            label: 'the key this client does own',
            apiKey: KEY,
          },
        ],
      })
      expect(written.map((row) => row.externalId).sort()).toEqual([
        'the-borrower',
        'the-keyholder',
      ])

      const idOf = new Map(written.map((row) => [row.externalId, row.id]))
      const listed = await registry.listEndpoints(LINKER)
      const borrower = listed.find((row) => row.externalId === 'the-borrower')!
      const keyholder = listed.find((row) => row.externalId === 'the-keyholder')!

      // The stored link is Search's id for the sibling, not the spelling the
      // client sent — which is the only form the resolver's `WHERE id = …` can
      // find.
      expect(borrower.config).toEqual({ apiKeyEndpointId: idOf.get('the-keyholder') })
      expect(idOf.get('the-keyholder')).toBe(keyholder.id)
      // And therefore a reported key rather than the `hasKey: false` that
      // an untranslated link produced.
      expect(borrower.hasKey).toBe(true)
      expect(
        await resolveEndpointApiKey({
          keyCiphertext: null,
          config: borrower.config,
          pairedClientId: LINKER,
        }),
      ).toBe(KEY)

      // And a link to an id that is neither owned nor declared is still refused.
      await expect(
        applyEndpointDeclaration(LINKER, {
          source: { kind: 'local' },
          endpoints: [
            {
              externalId: 'the-borrower',
              kind: 'inference',
              provider: 'openai',
              model: 'gpt-4o-mini',
              label: 'keyed on nothing at all',
              config: { apiKeyEndpointId: `${foreignEndpointId}` },
            },
          ],
        }),
      ).rejects.toThrow(/not one of your endpoints/)

      // This client's catalog is a fixture the tests around it count, so this
      // one hands it back the way it found it.
      await db.delete(modelEndpoint).where(eq(modelEndpoint.pairedClientId, LINKER))
    })

    /**
     * The other two spellings a client will actually send.
     *
     * A link to an endpoint that already exists may be written as Search's id
     * — which is what a client that read `GET /v1/endpoints` and pushed it
     * back sends — or as that endpoint's own `externalId`, which is what a
     * client holding only its own catalog has. Both are accepted and both end
     * up stored as the id, and a re-push of an already-translated body must
     * leave it exactly where it is rather than re-resolve it.
     */
    it('translates a link to an endpoint that already exists, by either spelling', async () => {
      const { applyEndpointDeclaration } = await import('../api/routes/endpoints.ts')
      const holder = {
        externalId: 'the-standing-keyholder',
        kind: 'embedding' as const,
        provider: 'openai',
        template: 'openai',
        model: 'text-embedding-3-small',
        dimensions: 1536,
        label: 'declared first, on its own',
        apiKey: 'sk-standing-and-shared-0123456789',
      }
      const first = await applyEndpointDeclaration(LINKER, {
        source: { kind: 'local' },
        endpoints: [holder],
      })
      const holderId = first[0]!.id

      // Spelling one: the sibling's `externalId`, for a row that already has a
      // Search id of its own.
      const byExternalId = await applyEndpointDeclaration(LINKER, {
        source: { kind: 'local' },
        endpoints: [
          holder,
          {
            externalId: 'the-late-borrower',
            kind: 'inference',
            provider: 'openai',
            model: 'gpt-4o-mini',
            label: 'keyed on a row that was already there',
            config: { apiKeyEndpointId: holder.externalId },
          },
        ],
      })
      const borrowerId = byExternalId.find((row) => row.externalId === 'the-late-borrower')!.id
      const readBack = async (id: string) =>
        (await registry.listEndpoints(LINKER)).find((row) => row.id === id)!
      expect((await readBack(borrowerId)).config).toEqual({ apiKeyEndpointId: holderId })
      expect((await readBack(borrowerId)).hasKey).toBe(true)

      // Spelling two: Search's id, which the same body must not re-resolve.
      await applyEndpointDeclaration(LINKER, {
        source: { kind: 'local' },
        endpoints: [
          holder,
          {
            externalId: 'the-late-borrower',
            kind: 'inference',
            provider: 'openai',
            model: 'gpt-4o-mini',
            label: 'keyed on a row that was already there',
            config: { apiKeyEndpointId: holderId },
          },
        ],
      })
      expect((await readBack(borrowerId)).config).toEqual({ apiKeyEndpointId: holderId })
      expect((await readBack(borrowerId)).hasKey).toBe(true)

      await db.delete(modelEndpoint).where(eq(modelEndpoint.pairedClientId, LINKER))
    })

    it('refuses to resolve one that was planted underneath the route', async () => {
      // The row as it would exist if it had been written before this check
      // existed — or by anything other than the route.
      const planted = `${PREFIX}-planted`
      const now = new Date()
      await db.insert(modelEndpoint).values({
        id: planted,
        pairedClientId: LINKER,
        kind: 'inference',
        provider: 'openai',
        template: 'openai',
        model: 'gpt-4o-mini',
        keyCiphertext: null,
        source: 'local',
        config: { apiKeyEndpointId: foreignEndpointId },
        createdAt: now,
        updatedAt: now,
      })

      const { LocalEndpointSource } = await import('./local-endpoint-source.ts')
      await expect(
        new LocalEndpointSource().inference({ endpointId: planted }),
      ).rejects.toMatchObject({
        name: 'EndpointKeyUnavailableError',
        reason: 'client-mismatch',
        retryable: false,
      })

      // And a listing does not claim a key it cannot produce. `hasKey` used to
      // be the mere presence of `config.apiKeyEndpointId`.
      const listed = await registry.listEndpoints(LINKER)
      expect(listed).toHaveLength(1)
      expect(listed[0]).toMatchObject({ id: planted, hasKey: false })

      await db.delete(modelEndpoint).where(eq(modelEndpoint.id, planted))
    })

    it('still follows a link to one of the client’s own endpoints', async () => {
      // The feature, unchanged: two endpoints of one client sharing a key.
      const owner = await registry.createLocalEndpoint(
        LINKER,
        {
          externalId: 'own-key',
          kind: 'inference',
          provider: 'openai',
          template: 'openai',
          model: 'gpt-4o',
          label: 'the one with the key',
        },
        'sk-my-own-key-0123456789',
      )
      const borrower = await registry.createLocalEndpoint(
        LINKER,
        {
          externalId: 'shares-it',
          kind: 'inference',
          provider: 'openai',
          template: 'openai',
          model: 'gpt-4o-mini',
          label: 'shares it',
          config: { apiKeyEndpointId: owner.id },
        },
        null,
      )
      expect(borrower.hasKey).toBe(true)

      const { LocalEndpointSource } = await import('./local-endpoint-source.ts')
      const resolved = await new LocalEndpointSource().inference({ endpointId: borrower.id })
      expect(resolved?.apiKey).toBe('sk-my-own-key-0123456789')

      await db
        .delete(modelEndpoint)
        .where(inArray(modelEndpoint.id, [owner.id, borrower.id]))
    })
  })

  /**
   * `PUT /v1/endpoints` is one declaration, and it used to be applied as a
   * source write that committed, then a row per endpoint, then a
   * reconciliation. A refusal partway through left a client with a new source,
   * some of its endpoints written and the rest missing — a state no retry of
   * the same body would produce.
   */
  describe('a declaration is applied whole, or not at all', () => {
    const SUBJECT = `${PREFIX}-atomic`

    beforeAll(async () => {
      await db.insert(pairedClient).values({
        id: SUBJECT,
        label: `${PREFIX} atomic`,
        certSerial: `${PREFIX}-serial-atomic`,
        certFingerprint: `${PREFIX}-fingerprint-atomic`,
        scope: 'admin',
        status: 'active',
        createdAt: new Date(),
      })
    }, 60_000)

    afterAll(async () => {
      await db.delete(pairedClient).where(eq(pairedClient.id, SUBJECT)).catch(() => {})
    })

    it('leaves the previous declaration intact when a later row is refused', async () => {
      const { applyEndpointDeclaration } = await import('../api/routes/endpoints.ts')

      // The declaration that stands.
      const first = await applyEndpointDeclaration(SUBJECT, {
        source: { kind: 'local' },
        endpoints: [
          {
            externalId: 'keeper',
            kind: 'embedding',
            provider: 'openai',
            template: 'openai',
            model: 'text-embedding-3-small',
            dimensions: 1536,
            label: 'keeper',
            apiKey: 'sk-keeper-0123456789',
          },
        ],
      })
      expect(first).toHaveLength(1)

      // And the one that is refused on its second row: a new source, a new
      // endpoint, and then a link to an endpoint this client does not own.
      await expect(
        applyEndpointDeclaration(SUBJECT, {
          source: {
            kind: 'mirrored',
            resolverUrl: 'https://studio.example/api/search/resolve-endpoint',
            resolverKey: RESOLVER_KEY,
          },
          endpoints: [
            {
              externalId: 'newcomer',
              kind: 'inference',
              provider: 'openai',
              model: 'gpt-4o',
              label: 'newcomer',
            },
            {
              externalId: 'the-bad-row',
              kind: 'inference',
              provider: 'openai',
              model: 'gpt-4o-mini',
              label: 'the bad row',
              config: { apiKeyEndpointId: 'ep-belonging-to-nobody' },
            },
          ],
        }),
      ).rejects.toThrow(/not one of your endpoints/)

      // Exactly what was there before: one endpoint, still keyed, and the
      // source still `local` — the source write rolled back with the rest.
      const after = await registry.listEndpoints(SUBJECT)
      expect(after).toHaveLength(1)
      expect(after[0]).toMatchObject({ externalId: 'keeper', hasKey: true })
      expect(await registry.getEndpointSourceDeclaration(SUBJECT)).toEqual({ kind: 'local' })
    })
  })
})
