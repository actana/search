/**
 * @vitest-environment node
 *
 * The chunk transaction's replace-before-insert, against a live Postgres
 * (TASK-005 merge review, finding 1 and 2).
 *
 * `ingestDocument` inserts every chunk of a document into the KB's partition
 * with no `(document_id, chunk_index)` uniqueness to fall back on, so a second
 * run of one job used to *add* a second copy of every chunk: the document row
 * said N and the partition held 2N. The job layer's delete could not close that
 * on its own — it commits before the embedding even starts, so a run that is
 * still working writes its chunks after the delete has finished looking — and
 * the fix is therefore two statements at the top of the engine's own
 * transaction: `pg_advisory_xact_lock(hashtext(documentId))`, then a delete of
 * the document's chunks and the `embedding_keyword` links over them, with the
 * `kb_keyword.usage_count` decrement those links are counted in.
 *
 * Three tests, one per claim:
 *
 *   1. **A writer that is inside the transaction when the engine arrives.** A
 *      transaction of this suite's own takes the same advisory lock, inserts a
 *      chunk row for the document and *stays open*. The engine must wait for it
 *      — asserted, not assumed — and must then replace what it committed, so
 *      the partition holds N rows and not N+1.
 *   2. **Two live runs of one job.** Both `ingestDocument` calls are held at
 *      the embedding seam until both have arrived, so they enter their
 *      transactions together the way a re-queued attempt and the attempt that
 *      lost its lock do. Exactly N rows.
 *   3. **The `usage_count` the links were counted in.** A keyword attached to
 *      the chunks of a run comes back down when those chunks are replaced,
 *      clamped at zero — the count `listKbKeywords` orders by and the query
 *      menu is built from.
 *
 * Its own KB per test, so each can count rows without seeing another's.
 *
 * Gated on `SEARCH_TEST_DATABASE_URL`; without it the whole suite skips.
 *
 *     SEARCH_TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/search_test_b \
 *       pnpm --filter @actana/search-core test
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.unmock('../db/client.ts')
vi.unmock('drizzle-orm')

const { arrivals } = vi.hoisted(() => ({
  /** One resolver per embedding call the barrier below is holding. */
  arrivals: { waiting: [] as Array<() => void>, hold: 0 },
}))

/**
 * Embedding seam — the deterministic hash n-gram embedder, plus the barrier
 * test 2 needs.
 *
 * `arrivals.hold` is how many callers must arrive before any of them is let
 * through. It is zero for every other test, which makes the mock the plain
 * embedder.
 */
vi.mock('../models/embedding.ts', async () => {
  const { HASH_NGRAM_DIMS, hashNgramEmbedMany, hashNgramTokenCount } = await import(
    '@actana/search-shared/testing/hash-ngram-embedder'
  )
  return {
    executeWorkspaceEmbedding: vi.fn(
      async ({
        endpoint,
        input,
      }: {
        endpoint: { modelName?: string | null }
        input: string | string[]
      }) => {
        if (arrivals.hold > 0) {
          await new Promise<void>((resolve) => {
            arrivals.waiting.push(resolve)
            if (arrivals.waiting.length >= arrivals.hold) {
              const waiting = arrivals.waiting.splice(0)
              arrivals.hold = 0
              for (const release of waiting) release()
            }
          })
        }
        const tokens = hashNgramTokenCount(input)
        return {
          embeddings: hashNgramEmbedMany(input),
          model: endpoint.modelName ?? 'hash-ngram',
          dimensions: HASH_NGRAM_DIMS,
          usage: { promptTokens: tokens, totalTokens: tokens },
        }
      }
    ),
  }
})

/** No Redis: the follow-on jobs ingest enqueues are recorded, not dispatched. */
vi.mock('../queue/index.ts', () => ({
  QUEUE_NAMES: { knowledge: 'search-knowledge' },
  JOB_TYPE_ATTEMPTS: {},
  getQueue: () => ({ add: async () => ({ id: 'queued' }) }),
  getJobQueue: async () => ({ enqueue: async () => 'recorded' }),
}))

import { eq, inArray, sql } from 'drizzle-orm'
import { generateId, generateShortId } from '@actana/search-shared/short-id'
import {
  HASH_NGRAM_DIMS,
  hashNgramEmbed,
} from '@actana/search-shared/testing/hash-ngram-embedder'
import { resetConfig } from '../config.ts'
import { db } from '../db/client.ts'
import { runMigrations } from '../db/migrate.ts'
import {
  document,
  embedding,
  embeddingKeyword,
  kbKeyword,
  knowledgeBase,
  modelEndpoint,
  pairedClient,
} from '../db/schema.ts'
import { dropKbPartition, provisionKbPartition } from './ddl.ts'
import { ingestDocument } from './ingest.ts'
import { attachKeywordToChunk, upsertKbKeyword } from './keywords/index.ts'
import { kbPartitionRef } from './partition.ts'

const TEST_DATABASE_URL = process.env.SEARCH_TEST_DATABASE_URL
const describeDb = TEST_DATABASE_URL ? describe : describe.skip

const RUN = generateShortId(8)
const PREFIX = `searchreplace-${RUN}`

const ids = {
  client: `${PREFIX}-client`,
  endpoint: `${PREFIX}-ep`,
  /** One KB per test — see the header. */
  kbHeld: `${PREFIX}-kb-held`,
  kbLive: `${PREFIX}-kb-live`,
  kbKeywords: `${PREFIX}-kb-keywords`,
}
const KB_IDS = [ids.kbHeld, ids.kbLive, ids.kbKeywords]

/** Enough text to chunk into more than one row. */
const TEXT =
  '# Expenses\n\nBook travel through the agent, and economy on anything under six hours.\n\n' +
  'Receipts go in within thirty days. The per-diem is on the intranet and it changes yearly.\n\n' +
  'Anything over five hundred needs a manager on the request before it is booked.\n'

/** Rows in a KB's partition for one document. */
async function countChunks(kbId: string, documentId: string): Promise<number> {
  const res = (await db.execute(
    sql`SELECT count(*)::int AS c FROM ${sql.raw(kbPartitionRef(kbId))} WHERE document_id = ${documentId}`
  )) as { rows?: Array<{ c: number }> } | Array<{ c: number }>
  const rows = Array.isArray(res) ? res : (res.rows ?? [])
  return Number(rows[0]?.c ?? 0)
}

/** The chunk ids a run left in a KB's partition. */
async function chunkIds(kbId: string, documentId: string): Promise<string[]> {
  const res = (await db.execute(
    sql`SELECT id FROM ${sql.raw(kbPartitionRef(kbId))} WHERE document_id = ${documentId} ORDER BY chunk_index`
  )) as { rows?: Array<{ id: string }> } | Array<{ id: string }>
  const rows = Array.isArray(res) ? res : (res.rows ?? [])
  return rows.map((row) => row.id)
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describeDb('ingest replaces a previous run of the same document', () => {
  beforeAll(async () => {
    process.env.SEARCH_DATABASE_URL = TEST_DATABASE_URL as string
    resetConfig()
    await runMigrations({ url: TEST_DATABASE_URL as string })

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
    await db.insert(modelEndpoint).values({
      id: ids.endpoint,
      pairedClientId: ids.client,
      provider: 'fixture',
      keyCiphertext: null,
      template: 'fixture-hash-ngram',
      model: 'hash-ngram-256',
      kind: 'embedding',
      dimension: HASH_NGRAM_DIMS,
      source: 'local',
      config: {},
      createdAt: now,
      updatedAt: now,
    })
    for (const kbId of KB_IDS) {
      await db.insert(knowledgeBase).values({
        id: kbId,
        ownerId: `${PREFIX}-owner`,
        pairedClientId: ids.client,
        name: kbId,
        embeddingModel: 'hash-ngram-256',
        embeddingDimension: HASH_NGRAM_DIMS,
        embeddingEndpointId: ids.endpoint,
        // No inference endpoint: keyword extraction is a soft skip, and this
        // suite attaches the keywords it cares about itself.
        inferenceEndpointId: null,
        /**
         * A small chunk size, so this suite's short corpus becomes several
         * chunks: "N and not 2N" is a weak claim when N is 1, and the keyword
         * test needs two chunks to count one keyword twice.
         */
        chunkingConfig: { method: 'recursive', chunkSize: 40, minSize: 10, maxSize: 60, overlap: 0 },
        kmeansK: 8,
        language: 'english',
        createdAt: now,
        updatedAt: now,
      })
      await provisionKbPartition({ kbId, dim: HASH_NGRAM_DIMS, language: 'english' })
    }
  }, 120_000)

  afterAll(async () => {
    for (const kbId of KB_IDS) {
      await db.delete(document).where(eq(document.knowledgeBaseId, kbId))
      await dropKbPartition({ kbId })
    }
    await db.delete(knowledgeBase).where(inArray(knowledgeBase.id, KB_IDS))
    await db.delete(modelEndpoint).where(eq(modelEndpoint.id, ids.endpoint))
    await db.delete(pairedClient).where(eq(pairedClient.id, ids.client))
  }, 60_000)

  it('waits for a writer that is still in its transaction, and replaces what it wrote', async () => {
    const documentId = `${PREFIX}-doc-held`
    const partition = kbPartitionRef(ids.kbHeld)

    /**
     * The other run, as a transaction this test owns: it takes the same
     * advisory lock the engine takes, writes one chunk row for the document,
     * and then sits there — which is precisely the state a worker that is
     * mid-transaction is in when a re-queued attempt starts up beside it.
     */
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    const stale = generateId()
    let holderReady!: () => void
    const ready = new Promise<void>((resolve) => (holderReady = resolve))
    const holder = db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${documentId}))`)
      await tx.execute(sql`
        INSERT INTO ${sql.raw(partition)}
          (id, kb_id, document_id, chunk_index, content, cluster_id, metadata, embedding)
        VALUES (
          ${stale}, ${ids.kbHeld}, ${documentId}, 0, 'a chunk the other run wrote', NULL,
          '{}'::jsonb, ${`[${hashNgramEmbed('a chunk the other run wrote').join(',')}]`}::vector
        )
      `)
      holderReady()
      await held
    })
    await ready

    const run = ingestDocument({
      kbId: ids.kbHeld,
      documentId,
      text: TEXT,
      filename: 'expenses.md',
      includedInKb: true,
    })
    let settled = false
    void run.then(
      () => (settled = true),
      () => (settled = true)
    )

    /**
     * The engine cannot have finished while the lock is held. Two seconds is
     * far more than this KB's chunk-and-embed takes — the embedder is in
     * process — so a `settled` run here is a run that walked straight past the
     * other writer.
     */
    await sleep(2_000)
    expect(settled).toBe(false)

    release()
    await holder
    const result = await run

    // The holder's row committed, and the run that waited replaced it.
    expect(await countChunks(ids.kbHeld, documentId)).toBe(result.chunkCount)
    expect(await chunkIds(ids.kbHeld, documentId)).not.toContain(stale)
    const [row] = await db
      .select({ chunkCount: document.chunkCount })
      .from(document)
      .where(eq(document.id, documentId))
    expect(row?.chunkCount).toBe(result.chunkCount)
  }, 120_000)

  it('leaves N chunks and not 2N when two live runs of one job overlap', async () => {
    const documentId = `${PREFIX}-doc-live`

    /**
     * Both runs are held at the embedding seam until both have arrived, so
     * neither can be finished before the other starts: they go into their
     * transactions together.
     */
    arrivals.hold = 2
    const payload = {
      kbId: ids.kbLive,
      documentId,
      text: TEXT,
      filename: 'expenses.md',
      includedInKb: true,
    }
    const [first, second] = await Promise.all([ingestDocument(payload), ingestDocument(payload)])

    expect(first.chunkCount).toBeGreaterThan(1)
    expect(second.chunkCount).toBe(first.chunkCount)
    // One copy of the corpus, not two.
    expect(await countChunks(ids.kbLive, documentId)).toBe(first.chunkCount)
  }, 120_000)

  it('takes the usage_count of the keywords whose links it removes back down', async () => {
    const documentId = `${PREFIX}-doc-keywords`
    const payload = {
      kbId: ids.kbKeywords,
      documentId,
      text: TEXT,
      filename: 'expenses.md',
      includedInKb: true,
    }
    const first = await ingestDocument(payload)
    const chunks = await chunkIds(ids.kbKeywords, documentId)
    expect(first.chunkCount).toBeGreaterThan(1)
    expect(chunks.length).toBe(first.chunkCount)

    /**
     * `embedding_keyword.embedding_id` carries a foreign key to
     * `search.embedding`, so the links this test attaches need a row there
     * under the *partition's* chunk id — which is exactly the case the delete
     * is written for: a partition id and an `embedding` id come out of the same
     * generator, so the links go by the ids actually removed rather than on the
     * assumption that the two stores can never share one.
     */
    const now = new Date()
    await db.insert(embedding).values(
      chunks.map((id, index) => ({
        id,
        knowledgeBaseId: ids.kbKeywords,
        documentId,
        chunkIndex: index,
        chunkHash: `${id}-hash`,
        content: `chunk ${index}`,
        contentLength: 8,
        tokenCount: 2,
        embedding: hashNgramEmbed(`chunk ${index}`),
        embeddingModel: 'hash-ngram-256',
        startOffset: 0,
        endOffset: 8,
        enabled: true,
        createdAt: now,
        updatedAt: now,
      }))
    )

    /** Counted on two chunks, so its count has somewhere to fall from. */
    const counted = await upsertKbKeyword({
      kbId: ids.kbKeywords,
      displayLabel: 'Per-diem',
      createdByUserId: null,
    })
    /** Counted on one chunk, with the count already at zero: the clamp. */
    const clamped = await upsertKbKeyword({
      kbId: ids.kbKeywords,
      displayLabel: 'Receipts',
      createdByUserId: null,
    })
    expect(counted && clamped).toBeTruthy()
    await attachKeywordToChunk({
      embeddingId: chunks[0]!,
      kbKeywordId: counted!.id,
      source: 'llm',
    })
    await attachKeywordToChunk({
      embeddingId: chunks[1]!,
      kbKeywordId: counted!.id,
      source: 'llm',
    })
    await attachKeywordToChunk({
      embeddingId: chunks[0]!,
      kbKeywordId: clamped!.id,
      source: 'manual',
    })
    await db
      .update(kbKeyword)
      .set({ usageCount: 0 })
      .where(eq(kbKeyword.id, clamped!.id))

    const before = await db
      .select({ id: kbKeyword.id, usageCount: kbKeyword.usageCount })
      .from(kbKeyword)
      .where(inArray(kbKeyword.id, [counted!.id, clamped!.id]))
    expect(new Map(before.map((r) => [r.id, r.usageCount])).get(counted!.id)).toBe(2)

    // The re-run: same document, same text, a new set of chunk ids.
    await ingestDocument(payload)

    // The links went with the chunks they hung off…
    const links = await db
      .select({ embeddingId: embeddingKeyword.embeddingId })
      .from(embeddingKeyword)
      .where(inArray(embeddingKeyword.embeddingId, chunks))
    expect(links).toEqual([])
    // …and so did the count they were counted in, clamped at zero.
    const after = await db
      .select({ id: kbKeyword.id, usageCount: kbKeyword.usageCount })
      .from(kbKeyword)
      .where(inArray(kbKeyword.id, [counted!.id, clamped!.id]))
    const counts = new Map(after.map((r) => [r.id, r.usageCount]))
    expect(counts.get(counted!.id)).toBe(0)
    expect(counts.get(clamped!.id)).toBe(0)
  }, 120_000)
})
