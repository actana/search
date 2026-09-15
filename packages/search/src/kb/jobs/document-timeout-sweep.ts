/**
 * Background job: reconcile documents stranded in a non-terminal processing
 * state after a worker death (OOM, pod restart, stalled past max).
 *
 * When a BullMQ job is killed mid-flight the in-process
 * `processDocumentAsyncLocked` catch never runs, so the document stays
 * `processing` / `keywording` / `pending` forever — the UI spins and a doc
 * stuck in `keywording` blocks the KB's clustering drain gate. Nothing else
 * calls `markDocumentAsFailedTimeout` on a schedule, so this sweep does.
 *
 * Runs on the cron queue (see `worker/repeatable-jobs.ts`). Idempotent: it
 * only touches documents whose `processingStatus` is still non-terminal and
 * whose `processingStartedAt` is older than the safety window, so a
 * later-arriving terminal status is never clobbered.
 */

import { db } from '../../db/client.ts'
import { document } from '../../db/schema.ts'
import { createLogger } from '@actana/search-shared/log'
import { and, inArray, isNotNull, lt } from 'drizzle-orm'
import { env } from '../../config.ts'
import { generateShortId } from '@actana/search-shared/short-id'
import {
  computeDeadProcessWindowMs,
  DEAD_PROCESS_MIN_WINDOW_MS,
  markDocumentAsFailedTimeout,
  NON_TERMINAL_PROCESSING_STATUSES,
  PROCESSING_TIMEOUT_SAFETY_FACTOR,
} from '../../knowledge/documents/service.ts'

const logger = createLogger('kb/jobs/document-timeout-sweep')

/**
 * Multiplier applied to {@link computeProcessingTimeoutMs} to derive the safety
 * window. A document is only considered dead once it has been processing for
 * comfortably longer than its size-scaled budget, to avoid racing healthy jobs.
 * Shared with {@link markDocumentAsFailedTimeout} so both layers agree.
 */
const SAFETY_FACTOR = PROCESSING_TIMEOUT_SAFETY_FACTOR

/**
 * Lower bound (ms) for the safety window, matching the floor inside
 * {@link markDocumentAsFailedTimeout}. That function re-checks this threshold,
 * so a document younger than it is skipped even if selected.
 */
const MIN_SAFETY_WINDOW_MS = DEAD_PROCESS_MIN_WINDOW_MS

/** Cap on documents reconciled per sweep run to bound DB work. */
const MAX_DOCS_PER_SWEEP = 500

/** Result of a single sweep run. */
export interface DocumentTimeoutSweepResult {
  /** Documents inspected (non-terminal + older than the safety window). */
  candidates: number
  /** Documents successfully flipped to `failed`. */
  reconciled: number
  /**
   * Which documents those were, so the job layer can announce them.
   *
   * lifted: additive, and the only change to this file. The sweep is the one
   * path to `failed` that no job's completion covers — a worker killed mid-job,
   * or a job past `maxStalledCount`, leaves the row non-terminal with nothing
   * running, so neither `jobs/run.ts`'s announcement nor the worker's failure
   * handler ever sees that document again and its `document.failed` was simply
   * lost. Reporting the ids rather than publishing from here keeps every
   * announcement in the job layer, which is where ADR 0009 D8 put them.
   */
  failedDocumentIds: string[]
}

/**
 * Find documents stuck in a non-terminal processing state past the safety
 * window and mark them `failed` via `markDocumentAsFailedTimeout`.
 */
export async function runDocumentTimeoutSweep(): Promise<DocumentTimeoutSweepResult> {
  const requestId = `doc-timeout-sweep-${generateShortId(8)}`
  const maxDurationMs = (env.KB_CONFIG_MAX_DURATION || 600) * 1000
  const safetyWindowMs = Math.max(maxDurationMs * SAFETY_FACTOR, MIN_SAFETY_WINDOW_MS)
  const cutoff = new Date(Date.now() - safetyWindowMs)

  const stuckDocs = await db
    .select({
      id: document.id,
      processingStartedAt: document.processingStartedAt,
      processingStatus: document.processingStatus,
      fileSize: document.fileSize,
      chunkCount: document.chunkCount,
    })
    .from(document)
    .where(
      and(
        inArray(document.processingStatus, NON_TERMINAL_PROCESSING_STATUSES),
        isNotNull(document.processingStartedAt),
        lt(document.processingStartedAt, cutoff)
      )
    )
    .limit(MAX_DOCS_PER_SWEEP)

  if (stuckDocs.length === 0) {
    return { candidates: 0, reconciled: 0, failedDocumentIds: [] }
  }

  logger.warn(`[${requestId}] Reconciling stuck documents`, {
    candidates: stuckDocs.length,
    safetyWindowSeconds: Math.round(safetyWindowMs / 1000),
  })

  const now = Date.now()
  let reconciled = 0
  const failedDocumentIds: string[] = []
  for (const doc of stuckDocs) {
    if (!doc.processingStartedAt) {
      continue
    }
    /**
     * The coarse DB cutoff above uses the minimum window; refine per document
     * by its own phase-aware budget so a job that is legitimately still running
     * is not killed early — chunk-count-scaled while keywording (one sequential
     * LLM call per chunk), size-scaled otherwise.
     */
    const docWindowMs = computeDeadProcessWindowMs({
      status: doc.processingStatus,
      fileSize: doc.fileSize,
      chunkCount: doc.chunkCount,
    })
    if (now - doc.processingStartedAt.getTime() < docWindowMs) {
      continue
    }
    try {
      await markDocumentAsFailedTimeout(doc.id, doc.processingStartedAt, requestId)
      reconciled++
      failedDocumentIds.push(doc.id)
    } catch (error) {
      logger.error(`[${requestId}] Failed to reconcile stuck document ${doc.id}`, {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  logger.info(`[${requestId}] Document timeout sweep complete`, {
    candidates: stuckDocs.length,
    reconciled,
  })

  return { candidates: stuckDocs.length, reconciled, failedDocumentIds }
}
