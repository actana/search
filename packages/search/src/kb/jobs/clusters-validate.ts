/**
 * Background job: re-validate (and optionally re-fit) clusters for a KB.
 *
 * Enqueued from the document worker after a KB's ingestion queue drains
 * and the chunks-grown threshold (`max(500, 0.2 × last-fit-size)`) is
 * crossed.
 */

import { db } from '../../db/client.ts'
import { document, kbCluster, knowledgeBase, qualified } from '../../db/schema.ts'
import { createLogger } from '@actana/search-shared/log'
import { and, eq, sql } from 'drizzle-orm'
import { generateId } from '@actana/search-shared/short-id'
import { runClustering, validateK } from '../clustering.ts'
import { clearKbClusteringActive, markKbClusteringActive } from '../locks.ts'
import { kbPartitionRef } from '../partition.ts'

const logger = createLogger('kb/jobs/clusters-validate')

/** Canonical BullMQ job name. */
export const clustersValidateJobName = 'kb.clusters.validate' as const

/** Stream-batch size when loading embeddings out of the partition table. */
const STREAM_BATCH = 5000

/**
 * Handler entry point. Loads all embeddings from the KB partition, runs
 * `validateK` against the current k, and either:
 * - rewrites `kb_cluster` + per-row `cluster_id` (k changed), or
 * - just bumps the KB's clusters-updated-at + silhouette (k unchanged).
 *
 * On any failure the job marks every document that was waiting on
 * clustering as `failed` so the UI surfaces the problem instead of
 * silently leaving docs stuck.
 */
export async function handleClustersValidate(args: { kbId: string }): Promise<void> {
  const { kbId } = args
  /**
   * Flip the clustering-active flag so the UI can render its progress
   * banner. The flag is TTL-protected (30 min) so a crash won't leave it
   * stuck, but the `finally` clears it on the happy path.
   */
  await markKbClusteringActive(kbId)
  try {
    await runClustersValidate(args)
    await advanceClusteringDocs(kbId)
  } catch (err) {
    const message = extractDbErrorMessage(err)
    logger.error('clusters-validate: job failed', { kbId, message })
    await failClusteringDocs(kbId, message)
    throw err
  } finally {
    await clearKbClusteringActive(kbId)
  }
}

async function runClustersValidate(args: { kbId: string }): Promise<void> {
  const { kbId } = args
  const [kb] = await db.select().from(knowledgeBase).where(eq(knowledgeBase.id, kbId)).limit(1)
  if (!kb) {
    logger.warn('clusters-validate: kb not found', { kbId })
    return
  }
  const currentK = kb.kmeansK ?? 8
  // lifted: `kbPartitionName` -> `kbPartitionRef`, which returns the qualified
  // `"search"."<table>"` identifier. The SQL below is otherwise byte-identical;
  // only the identifier token changed. See `kb/partition.ts` for why a bare name
  // is dangerous on a database shared with Studio.
  const partitionTable = kbPartitionRef(kbId)

  const vectors: number[][] = []
  const ids: string[] = []
  let offset = 0
  while (true) {
    const result = (await db.execute(
      sql.raw(
        `SELECT id, embedding::text AS embedding FROM ${partitionTable} ORDER BY id LIMIT ${STREAM_BATCH} OFFSET ${offset}`
      )
    )) as
      | { rows?: Array<{ id: string; embedding: string }> }
      | Array<{ id: string; embedding: string }>
    const rows = Array.isArray(result) ? result : (result.rows ?? [])
    if (rows.length === 0) break
    for (const row of rows) {
      const arr = parsePgVector(row.embedding)
      if (arr) {
        ids.push(row.id)
        vectors.push(arr)
      }
    }
    if (rows.length < STREAM_BATCH) break
    offset += rows.length
  }

  if (vectors.length === 0) {
    logger.info('clusters-validate: no vectors', { kbId })
    return
  }
  if (vectors.length < 2) {
    logger.info('clusters-validate: fewer than 2 vectors, skipping', {
      kbId,
      vectors: vectors.length,
    })
    return
  }

  const upperK = Math.max(2, Math.min(currentK, Math.floor(vectors.length / 2) || 2))
  const effectiveK = Math.min(currentK, upperK)
  const candidates = Array.from(
    new Set([
      Math.max(2, effectiveK - 2),
      effectiveK,
      Math.min(vectors.length, effectiveK + 2),
      Math.min(vectors.length, effectiveK + 4),
    ])
  )
  const validation = validateK(vectors, effectiveK, { candidates })
  const recommendedK = validation.recommendedK

  /**
   * Skip the full re-fit only when k is unchanged AND the KB is large enough
   * that re-writing every cluster_id is expensive. For small KBs we always
   * re-fit so newly-ingested chunks immediately pick up cluster assignments.
   */
  const SMALL_KB_FULL_REFIT_LIMIT = 200
  if (recommendedK === currentK && vectors.length > SMALL_KB_FULL_REFIT_LIMIT) {
    await db
      .update(knowledgeBase)
      .set({ kmeansUpdatedAt: new Date(), kmeansSilhouette: validation.silhouette })
      .where(eq(knowledgeBase.id, kbId))
    logger.info('clusters-validate: k unchanged', { kbId, k: currentK })
    return
  }

  const fit = runClustering(vectors, recommendedK)

  /**
   * Guard against NaN/Infinity slipping into the jsonb column. Clustering
   * shouldn't produce these for non-degenerate inputs, but a single bad
   * centroid would make the bulk insert fail with an opaque error.
   */
  for (let i = 0; i < fit.centroids.length; i++) {
    const c = fit.centroids[i]
    for (let j = 0; j < c.length; j++) {
      if (!Number.isFinite(c[j])) {
        throw new Error(
          `clusters-validate: centroid ${i} contains non-finite value at index ${j} (${c[j]})`
        )
      }
    }
  }

  await db.transaction(async (tx) => {
    /**
     * Serialize per-KB persistence. The clusters-validate job is
     * deferred until the per-KB ingestion queue drains, but a manual
     * re-cluster trigger from the API can race with a queue-drain-fired
     * job. The row-level lock here makes the late arriver wait for the
     * in-flight persist; it then re-DELETEs the freshly-written rows
     * and INSERTs its own, so the last writer wins instead of crashing
     * on the `(kb_id, cluster_id)` unique constraint.
     */
    await tx.execute(sql`SELECT 1 FROM ${sql.raw(qualified('knowledge_base'))} WHERE id = ${kbId} FOR UPDATE`)

    await tx.delete(kbCluster).where(eq(kbCluster.kbId, kbId))

    /**
     * Insert per-row using an explicit `::jsonb` cast on a stringified
     * centroid. Drizzle's batched values() for jsonb columns has caused
     * opaque insert failures here; the explicit cast removes the
     * serialization ambiguity and a per-row loop means any future row
     * that does fail produces an error message pointing at exactly one
     * cluster instead of one giant param dump.
     */
    for (let i = 0; i < fit.centroids.length; i++) {
      const centroid = fit.centroids[i]
      const size = fit.assignments.filter((a) => a === i).length
      try {
        await tx.execute(sql`
          INSERT INTO ${sql.raw(qualified('kb_cluster'))} (id, kb_id, cluster_id, centroid, size, inertia)
          VALUES (
            ${generateId()},
            ${kbId},
            ${i},
            ${JSON.stringify(centroid)}::jsonb,
            ${size},
            NULL
          )
        `)
      } catch (err) {
        throw new Error(
          `clusters-validate: failed to insert cluster ${i} (size=${size}, dim=${centroid.length}): ${extractDbErrorMessage(err)}`
        )
      }
    }

    // Batch-update partition cluster_id in groups of 5000.
    const BATCH = 5000
    for (let start = 0; start < ids.length; start += BATCH) {
      const slice = ids.slice(start, start + BATCH)
      const assignSlice = fit.assignments.slice(start, start + BATCH)
      for (let i = 0; i < slice.length; i++) {
        await tx.execute(sql`
          UPDATE ${sql.raw(partitionTable)}
          SET cluster_id = ${assignSlice[i]}
          WHERE id = ${slice[i]}
        `)
      }
    }
    await tx
      .update(knowledgeBase)
      .set({
        kmeansK: recommendedK,
        kmeansSilhouette: validation.silhouette,
        kmeansUpdatedAt: new Date(),
      })
      .where(eq(knowledgeBase.id, kbId))
  })

  logger.info('clusters-validate: rewrote clusters', { kbId, oldK: currentK, newK: recommendedK })
}

/**
 * Try to surface the most informative message from a database error.
 * Drizzle wraps the driver error as the `cause`; pg-node puts the
 * server message there with extra fields (`detail`, `hint`, `code`).
 */
function extractDbErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    type PgErr = { message?: unknown; detail?: unknown; hint?: unknown; code?: unknown }
    const cause = (err as { cause?: unknown }).cause
    if (cause && typeof cause === 'object') {
      const c = cause as PgErr
      const parts = [
        typeof c.message === 'string' ? c.message : '',
        typeof c.detail === 'string' ? `detail: ${c.detail}` : '',
        typeof c.hint === 'string' ? `hint: ${c.hint}` : '',
        typeof c.code === 'string' ? `code: ${c.code}` : '',
      ].filter(Boolean)
      if (parts.length > 0) return parts.join(' | ')
    }
    return err.message
  }
  return String(err)
}

/**
 * On clustering success: advance every document in this KB that's been
 * waiting at the `clustering` phase. If the KB has an inference
 * endpoint configured we move them to `keywording` and enqueue the
 * per-chunk keyword job; otherwise we jump straight to `completed`.
 */
async function advanceClusteringDocs(kbId: string): Promise<void> {
  const { getJobQueue } = await import('../../queue/index.ts')
  const { keywordsExtractJobName } = await import('./keywords-extract.ts')

  const docs = await db
    .select({ id: document.id })
    .from(document)
    .where(and(eq(document.knowledgeBaseId, kbId), eq(document.processingStatus, 'clustering')))
  if (docs.length === 0) return

  const [kbRow] = await db
    .select({ inferenceEndpointId: knowledgeBase.inferenceEndpointId })
    .from(knowledgeBase)
    .where(eq(knowledgeBase.id, kbId))
    .limit(1)
  const kbHasInferenceEndpoint = Boolean(kbRow?.inferenceEndpointId)

  if (!kbHasInferenceEndpoint) {
    await db
      .update(document)
      .set({
        processingStatus: 'completed',
        processingError: null,
        processingCompletedAt: new Date(),
      })
      .where(and(eq(document.knowledgeBaseId, kbId), eq(document.processingStatus, 'clustering')))
    logger.info('clusters-validate: docs completed (no inference endpoint)', {
      kbId,
      count: docs.length,
    })
    return
  }

  await db
    .update(document)
    .set({ processingStatus: 'keywording', processingError: null })
    .where(and(eq(document.knowledgeBaseId, kbId), eq(document.processingStatus, 'clustering')))

  let queue
  try {
    queue = await getJobQueue()
  } catch (err) {
    logger.error('clusters-validate: failed to acquire job queue', {
      kbId,
      err: err instanceof Error ? err.message : String(err),
    })
    return
  }

  for (const doc of docs) {
    try {
      await queue.enqueue(keywordsExtractJobName, {
        documentId: doc.id,
        knowledgeBaseId: kbId,
      })
    } catch (err) {
      logger.warn('clusters-validate: failed to enqueue keyword job; marking doc completed', {
        kbId,
        documentId: doc.id,
        err: err instanceof Error ? err.message : String(err),
      })
      await db
        .update(document)
        .set({ processingStatus: 'completed', processingCompletedAt: new Date() })
        .where(eq(document.id, doc.id))
    }
  }
  logger.info('clusters-validate: advanced docs to keywording', { kbId, count: docs.length })
}

/**
 * On clustering failure: mark every doc that was waiting on clustering
 * as `failed` with the underlying error so the UI surfaces the real
 * cause instead of stranding the doc.
 */
async function failClusteringDocs(kbId: string, message: string): Promise<void> {
  try {
    await db
      .update(document)
      .set({
        processingStatus: 'failed',
        processingError: `Clustering failed: ${message}`,
        processingCompletedAt: new Date(),
      })
      .where(and(eq(document.knowledgeBaseId, kbId), eq(document.processingStatus, 'clustering')))
  } catch (err) {
    logger.warn('clusters-validate: failed to mark clustering docs as failed', {
      kbId,
      err: err instanceof Error ? err.message : String(err),
    })
  }
}

/** Parses a pgvector text literal `[1,2,3]` into a JS number[]. */
function parsePgVector(s: string): number[] | null {
  if (typeof s !== 'string') return null
  const trimmed = s.trim()
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return null
  const inner = trimmed.slice(1, -1)
  if (inner.length === 0) return []
  const parts = inner.split(',')
  const out: number[] = []
  for (const p of parts) {
    const n = Number(p)
    if (!Number.isFinite(n)) return null
    out.push(n)
  }
  return out
}
