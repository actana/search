/**
 * Drain-aware clustering trigger.
 *
 * The clustering job (`kb.clusters.validate`) is deferred until **all**
 * documents for a KB have settled into `completed` or `failed`. Then we
 * check whether the corpus has grown enough since the last fit to warrant
 * a re-cluster, and enqueue the job at most once per drain event.
 *
 * Threshold for a re-fit:
 *   - cold-start: KB has no stored cluster count, AND total chunks ≥ 50, OR
 *   - chunks-grown: total chunks since last fit > max(500, 0.2 × last-fit-size)
 *
 * Small KBs (< 200 chunks) always re-fit on drain so newly-ingested
 * documents pick up cluster assignments without waiting for the threshold.
 */

import { db } from '../db/client.ts'
import { document, kbCluster, knowledgeBase } from '../db/schema.ts'
import { createLogger } from '@actana/search-shared/log'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { getJobQueue } from '../queue/index.ts'
import { clustersValidateJobName } from './jobs/clusters-validate.ts'
import { kbPartitionRef, partitionExists } from './partition.ts'

const logger = createLogger('kb/clustering-trigger')

const COLD_START_MIN_CHUNKS = 50
const SMALL_KB_RECLUSTER_LIMIT = 200
const ABSOLUTE_GROWTH_FLOOR = 500
const RELATIVE_GROWTH_FRACTION = 0.2

/** Document statuses that count as "still in flight" for the drain check. */
const IN_FLIGHT_STATUSES = [
  'pending',
  'processing',
  'chunking',
  'embedding',
  'clustering',
  'keywording',
] as const

/**
 * If the per-KB ingestion queue has drained, evaluate the chunks-grown
 * threshold and enqueue a clustering job. Idempotent: safe to call
 * multiple times — extra invocations just no-op because clustering itself
 * dedupes via the kb_cluster row-lock.
 */
export async function maybeEnqueueClusteringIfDrained(kbId: string): Promise<void> {
  const inFlight = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(document)
    .where(
      and(
        eq(document.knowledgeBaseId, kbId),
        inArray(document.processingStatus, [...IN_FLIGHT_STATUSES])
      )
    )
  const inFlightCount = Number(inFlight[0]?.count ?? 0)
  if (inFlightCount > 0) {
    return
  }

  if (!(await partitionExists(kbId))) {
    return
  }

  // lifted: `kbPartitionName` -> `kbPartitionRef`, which returns the qualified
  // `"search"."<table>"` identifier. The SQL below is otherwise byte-identical;
  // only the identifier token changed. See `kb/partition.ts` for why a bare name
  // is dangerous on a database shared with Studio.
  const partitionTable = kbPartitionRef(kbId)
  const totalRowsResult = (await db.execute(
    sql.raw(`SELECT count(*)::int AS c FROM ${partitionTable}`)
  )) as { rows?: Array<{ c: number }> } | Array<{ c: number }>
  const totalRows = Array.isArray(totalRowsResult) ? totalRowsResult : (totalRowsResult.rows ?? [])
  const totalChunks = Number(totalRows[0]?.c ?? 0)
  if (totalChunks === 0) return

  /**
   * Count chunks that already carry a cluster_id — this is our proxy for
   * "last-fit size". On cold-start (no clusters yet) the count is 0.
   */
  const clusteredResult = (await db.execute(
    sql.raw(`SELECT count(*)::int AS c FROM ${partitionTable} WHERE cluster_id IS NOT NULL`)
  )) as { rows?: Array<{ c: number }> } | Array<{ c: number }>
  const clusteredRows = Array.isArray(clusteredResult)
    ? clusteredResult
    : (clusteredResult.rows ?? [])
  const clusteredChunks = Number(clusteredRows[0]?.c ?? 0)

  const [kbRow] = await db
    .select({ kmeansUpdatedAt: knowledgeBase.kmeansUpdatedAt })
    .from(knowledgeBase)
    .where(eq(knowledgeBase.id, kbId))
    .limit(1)
  const [centroidCountRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(kbCluster)
    .where(eq(kbCluster.kbId, kbId))
  const centroidCount = Number(centroidCountRow?.count ?? 0)

  const isColdStart = centroidCount === 0 || !kbRow?.kmeansUpdatedAt
  const newChunksSinceLastFit = Math.max(0, totalChunks - clusteredChunks)
  const growthThreshold = Math.max(
    ABSOLUTE_GROWTH_FLOOR,
    Math.floor(RELATIVE_GROWTH_FRACTION * Math.max(1, clusteredChunks))
  )

  const shouldCluster =
    (isColdStart && totalChunks >= COLD_START_MIN_CHUNKS) ||
    totalChunks <= SMALL_KB_RECLUSTER_LIMIT ||
    newChunksSinceLastFit > growthThreshold

  if (!shouldCluster) {
    logger.info('clustering-trigger: drained, no re-fit needed', {
      kbId,
      totalChunks,
      clusteredChunks,
      newChunksSinceLastFit,
      growthThreshold,
    })
    return
  }

  try {
    const queue = await getJobQueue()
    await queue.enqueue(clustersValidateJobName, { kbId })
    logger.info('clustering-trigger: enqueued kb.clusters.validate', {
      kbId,
      totalChunks,
      clusteredChunks,
      newChunksSinceLastFit,
      growthThreshold,
      isColdStart,
    })
  } catch (err) {
    logger.warn('clustering-trigger: failed to enqueue kb.clusters.validate', {
      kbId,
      err: err instanceof Error ? err.message : String(err),
    })
  }
}
