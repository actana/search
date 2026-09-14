/**
 * @vitest-environment node
 *
 * The worker, for real: a live Redis, a live pgvector Postgres, and a
 * `kb.ingest.document` job that goes in one end and comes out as chunks with
 * vectors in a KB's partition (ADR 0006, ADR 0010).
 *
 * Two cases, and the second is the one this task is about:
 *
 *   1. **A local endpoint.** The job is enqueued, the worker picks it up, the
 *      document is ingested and `document.ingested` is announced. Every line is
 *      production code except the embedder, which is the deterministic hash
 *      n-gram one behind `SEARCH_TEST_EMBEDDING=hash-ngram` — the same seam the
 *      behaviour-freeze fixture uses (ADR 0005), so there is no key and no
 *      network in this suite.
 *
 *   2. **A mirrored endpoint whose resolver is not answering.** This is the
 *      whole chain: migration 0002's `paired_client.endpoint_source`,
 *      `setEndpointSource`, the routing source reading the row, the mirrored
 *      source dialling a resolver that is not there, the typed
 *      `EndpointKeyUnavailableError`, and the worker retrying rather than
 *      poisoning the queue. The job exhausts its two attempts and lands in
 *      `failed` with a reason that names the resolver — and, asserted
 *      explicitly, with **no key anywhere in it**.
 *
 * **Its own queue prefix.** `search-test-b`, so this suite cannot see, consume
 * or obliterate the jobs of a dev instance or of a sibling checkout on the same
 * Redis. That prefix being settable is what makes that possible
 * (`SEARCH_QUEUE_PREFIX`).
 *
 * Gated on `SEARCH_TEST_DATABASE_URL`; without it the whole suite skips.
 *
 *     SEARCH_TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/search_test_b \
 *       pnpm --filter @actana/search-core test
 */

import { Queue } from 'bullmq'
import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { HASH_NGRAM_DIMS } from '@actana/search-shared/testing/hash-ngram-embedder'
import { generateShortId } from '@actana/search-shared/short-id'
import { resetConfig } from './config.ts'
import { db } from './db/client.ts'
import { document, knowledgeBase, modelEndpoint, pairedClient } from './db/schema.ts'
import { runMigrations } from './db/migrate.ts'
import { dropKbPartition, provisionKbPartition } from './kb/ddl.ts'
import { kbPartitionRef } from './kb/partition.ts'
import {
  closeQueue,
  getJobQueue,
  getQueueConnection,
  QUEUE_NAME,
  queuePrefix,
} from './queue/index.ts'
import { clearSearchEventListeners, onSearchEvent } from './events.ts'
import { setEndpointSource } from './models/endpoint-registry.ts'
import { clearResolvedKeyCache } from './models/mirrored-endpoint-source.ts'
import { startWorkers, type SearchWorkers } from './worker.ts'

const TEST_DATABASE_URL = process.env.SEARCH_TEST_DATABASE_URL

/**
 * Set before anything reads the configuration, and before `resetConfig()` drops
 * the memoised parse.
 *
 * Safe at module scope despite the static imports above: nothing in this
 * package calls `config()` while a module is being evaluated — the parse is
 * lazy precisely so that it cannot — so the first read of any of these happens
 * inside a test, long after these three lines.
 */
process.env.SEARCH_QUEUE_PREFIX = 'search-test-b'
process.env.SEARCH_TEST_EMBEDDING = 'hash-ngram'
if (TEST_DATABASE_URL) process.env.SEARCH_DATABASE_URL = TEST_DATABASE_URL
resetConfig()

const describeDb = TEST_DATABASE_URL ? describe : describe.skip

/** Unique per run, so a re-run against a dirty database is clean. */
const RUN = generateShortId(8)
const PREFIX = `searchwk-${RUN}`
const ids = {
  client: `${PREFIX}-client`,
  owner: `${PREFIX}-owner`,
  localEndpoint: `${PREFIX}-ep-local`,
  mirroredEndpoint: `${PREFIX}-ep-mirrored`,
  kbLocal: `${PREFIX}-kb-local`,
  kbMirrored: `${PREFIX}-kb-mirrored`,
}

/**
 * A resolver URL nothing is listening on.
 *
 * Port 1 on loopback: reserved, never bound, and refused immediately rather
 * than after a timeout — so the suite exercises the `unreachable` path in
 * milliseconds instead of waiting out a ten-second budget.
 */
const DEAD_RESOLVER = 'http://127.0.0.1:1/resolve-endpoint'
/** The credential that must never appear in a log, an error or a job record. */
const RESOLVER_KEY = 'internal-secret-never-in-a-message'

let workers: SearchWorkers
let inspector: Queue

/** Wait for `check` to hold, or fail with what it last saw. */
async function until<T>(
  what: string,
  check: () => Promise<T | null>,
  timeoutMs = 25_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let last: unknown
  while (Date.now() < deadline) {
    try {
      const value = await check()
      if (value !== null && value !== undefined) return value
    } catch (err) {
      last = err
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(
    `timed out waiting for ${what}${last ? `: ${last instanceof Error ? last.message : String(last)}` : ''}`
  )
}

describeDb('the worker, end to end', () => {
  beforeAll(async () => {
    await runMigrations({ url: TEST_DATABASE_URL! })

    const now = new Date()
    await db.insert(pairedClient).values({
      id: ids.client,
      label: `${PREFIX} client`,
      certSerial: `${PREFIX}-serial`,
      certFingerprint: `${PREFIX}-fingerprint`,
      scope: 'admin',
      status: 'active',
      createdAt: now,
    })

    await db.insert(modelEndpoint).values([
      {
        id: ids.localEndpoint,
        pairedClientId: ids.client,
        kind: 'embedding',
        provider: 'fixture',
        template: 'fixture-hash-ngram',
        model: 'hash-ngram-256',
        dimension: HASH_NGRAM_DIMS,
        // No ciphertext: the deterministic embedder answers before any key is
        // read, which is what lets this suite run with no credential at all.
        keyCiphertext: null,
        source: 'local',
        config: {},
        createdAt: now,
        updatedAt: now,
      },
      {
        id: ids.mirroredEndpoint,
        pairedClientId: ids.client,
        kind: 'embedding',
        provider: 'openai',
        template: 'openai',
        model: 'text-embedding-3-small',
        dimension: HASH_NGRAM_DIMS,
        keyCiphertext: null,
        source: 'mirrored',
        externalId: `${PREFIX}-external`,
        config: {},
        createdAt: now,
        updatedAt: now,
      },
    ])

    for (const [kbId, endpointId] of [
      [ids.kbLocal, ids.localEndpoint],
      [ids.kbMirrored, ids.mirroredEndpoint],
    ] as const) {
      await db.insert(knowledgeBase).values({
        id: kbId,
        ownerId: ids.owner,
        pairedClientId: ids.client,
        name: `${PREFIX} ${kbId.endsWith('local') ? 'local' : 'mirrored'}`,
        embeddingModel: 'hash-ngram-256',
        embeddingDimension: HASH_NGRAM_DIMS,
        embeddingEndpointId: endpointId,
        kmeansK: 8,
        language: 'english',
        createdAt: now,
        updatedAt: now,
      })
      await provisionKbPartition({ kbId, dim: HASH_NGRAM_DIMS, language: 'english' })
    }

    // The declaration migration 0002 added. This is the row the routing source
    // reads to decide that the mirrored endpoint's key comes from a resolver.
    await setEndpointSource(ids.client, {
      kind: 'mirrored',
      resolverUrl: DEAD_RESOLVER,
      resolverKey: RESOLVER_KEY,
      resolverScope: 'workspace-under-test',
    })

    inspector = new Queue(QUEUE_NAME, {
      connection: getQueueConnection(),
      prefix: queuePrefix(),
    })
    // A previous run that was killed rather than stopped would otherwise leave
    // its jobs on this prefix for this one to pick up.
    await inspector.obliterate({ force: true })

    workers = await startWorkers({ concurrency: 2, repeatable: false })
  }, 120_000)

  afterAll(async () => {
    clearSearchEventListeners()
    clearResolvedKeyCache()
    await workers?.close()
    try {
      await inspector?.obliterate({ force: true })
    } catch {
      /* the connection may already be closed by the worker's shutdown */
    }
    await inspector?.close().catch(() => {})
    for (const kbId of [ids.kbLocal, ids.kbMirrored]) {
      await dropKbPartition({ kbId }).catch(() => {})
    }
    // `paired_client` cascades to endpoints, KBs, documents and chunks.
    await db.delete(pairedClient).where(eq(pairedClient.id, ids.client)).catch(() => {})
    await closeQueue().catch(() => {})
  }, 120_000)

  it('processes a kb.ingest.document job into chunks with vectors', async () => {
    const announced: unknown[] = []
    const off = onSearchEvent((event) => announced.push(event))

    const queue = await getJobQueue()
    await queue.enqueue('kb.ingest.document', {
      knowledgeBaseId: ids.kbLocal,
      filename: 'parental-leave.md',
      text:
        '# Parental leave\n\n' +
        'Employees are entitled to sixteen weeks of paid parental leave. ' +
        'Leave must be requested at least thirty days in advance through the people team. ' +
        'Unused leave does not carry across calendar years.\n',
      pairedClientId: ids.client,
    })

    const row = await until('the document to be written', async () => {
      const rows = await db
        .select({ id: document.id, chunkCount: document.chunkCount })
        .from(document)
        .where(eq(document.knowledgeBaseId, ids.kbLocal))
        .limit(1)
      return rows[0] && rows[0].chunkCount > 0 ? rows[0] : null
    })

    expect(row.chunkCount).toBeGreaterThan(0)

    /**
     * The chunks landed in the KB's own partition, with vectors — which is
     * where a query reads them from.
     *
     * The shared `embedding` table is deliberately *not* asserted: this is the
     * synchronous `ingestDocument` path, which writes the partition directly.
     * Staging chunks in `embedding` with a NULL vector is the fan-out path's
     * resume ledger (`planDocumentEmbedding`), and a test that demanded rows in
     * both would be asserting a pipeline this job does not use.
     */
    const partition = kbPartitionRef(ids.kbLocal)
    const counted = (await db.execute(
      sql.raw(
        `SELECT count(*)::int AS c FROM ${partition} ` +
          `WHERE document_id = '${row.id}' AND embedding IS NOT NULL`
      )
    )) as unknown as Array<{ c: number }> | { rows?: Array<{ c: number }> }
    const inPartition = Array.isArray(counted)
      ? Number(counted[0]?.c ?? 0)
      : Number(counted.rows?.[0]?.c ?? 0)
    expect(inPartition).toBe(row.chunkCount)

    expect(announced).toContainEqual(
      expect.objectContaining({
        type: 'document.ingested',
        knowledgeBaseId: ids.kbLocal,
        documentId: row.id,
        pairedClientId: ids.client,
      })
    )
    off()
  }, 90_000)

  it('retries and then cleanly fails a job whose endpoint key cannot be resolved', async () => {
    const queue = await getJobQueue()
    const jobId = `${PREFIX}-mirrored-job`
    await queue.enqueue(
      'kb.ingest.document',
      {
        knowledgeBaseId: ids.kbMirrored,
        filename: 'unreachable.md',
        text: 'This document is bound to an endpoint whose resolver is not answering.',
      },
      // Two attempts rather than the default three: the point is the *shape* of
      // the failure, and each extra attempt is another second of backoff.
      { jobId, maxAttempts: 2 }
    )

    const failed = await until('the job to exhaust its attempts', async () => {
      const job = await inspector.getJob(jobId)
      if (!job) return null
      const state = await job.getState()
      return state === 'failed' ? job : null
    })

    // It was retried rather than given up on after one go.
    expect(failed.attemptsMade).toBe(2)
    // And the reason is the typed one, naming the resolver by origin.
    expect(failed.failedReason).toMatch(/resolver/i)
    expect(failed.failedReason).toContain('http://127.0.0.1:1')

    // The invariant the whole task turns on: not the resolver credential, not
    // anywhere in what the queue kept about this failure.
    expect(JSON.stringify(failed)).not.toContain(RESOLVER_KEY)
    expect(failed.stacktrace?.join('\n') ?? '').not.toContain(RESOLVER_KEY)
  }, 90_000)
})
