/**
 * Search's ingestion worker (ADR 0006, ADR 0010).
 *
 * One BullMQ `Worker` on one queue — `search-knowledge`, under the prefix
 * `SEARCH_QUEUE_PREFIX` — routing by job name to the handlers the engine
 * already has. Studio's `worker/index.ts` ran four queues for four products;
 * Search has one, and the concurrency, the lock duration and the stall settings
 * are the ones Studio used for *its* knowledge queue, because the jobs are the
 * same jobs.
 *
 *   knowledge-process-document  → planDocumentEmbedding   (parse, stage, fan out)
 *   kb.embed.batch              → processEmbedBatch       (one resumable range)
 *   kb.embed.finalize           → finalizeDocumentEmbedding (fan-in)
 *   kb-keywords-extract         → handleKeywordsExtract
 *   kb.clusters.validate        → handleClustersValidate
 *   kb.ingest.document          → ingestDocument          (the synchronous path)
 *   kb.document.timeout-sweep   → runDocumentTimeoutSweep (repeatable)
 *
 * **Why the worker is Search's own, and what that costs.** ADR 0006 settled it:
 * the thing that owns the work owns the queue it recovers through. What this
 * file adds is the other half of that promise — a job that cannot run must fail
 * *cleanly*. The failure mode ADR 0010 exists to prevent is a wired instance
 * whose paired client is briefly unreachable turning a thousand embed batches
 * into a thousand permanently failed documents, or — worse — into a queue that
 * retries them forever without ever reporting anything.
 *
 * So there are exactly two outcomes for a failed job here:
 *
 *   * **Retry.** The error is an {@link EndpointKeyUnavailableError} whose
 *     `retryable` is true — the resolver timed out, answered 5xx, or refused a
 *     credential that is probably being rotated right now. BullMQ reschedules
 *     with the queue's exponential backoff and the document stays where it is.
 *   * **Fail the document.** Attempts are exhausted, or the error is one a
 *     retry cannot fix (the client forgot the endpoint; the mirror carries no
 *     external id; the file will not parse). The document goes to `failed` with
 *     a reason, and `document.failed` is emitted.
 *
 * **Nothing logged here is a key.** Job payloads carry ids, ranges and
 * filenames; an error message on its way into a log or an event has been
 * through `scrubSecret` first.
 */

import { Job, Worker, type Processor } from 'bullmq'
import { and, eq, inArray } from 'drizzle-orm'
import { createLogger } from '@actana/search-shared/log'
import { config } from './config.ts'
import { db } from './db/client.ts'
import { document, knowledgeBase } from './db/schema.ts'
import {
  closeQueue,
  getQueueConnection,
  JOB_TYPE_ATTEMPTS,
  QUEUE_NAME,
  queuePrefix,
  type JobType,
} from './queue/index.ts'
import { emitSearchEvent, eventTimestamp } from './events.ts'
import {
  isEndpointKeyUnavailable,
  type EndpointKeyUnavailableError,
} from './models/endpoint-key-errors.ts'
import { ingestDocument } from './kb/ingest.ts'
import { handleClustersValidate } from './kb/jobs/clusters-validate.ts'
import { handleKeywordsExtract, type KeywordsExtractPayload } from './kb/jobs/keywords-extract.ts'
import { runDocumentTimeoutSweep } from './kb/jobs/document-timeout-sweep.ts'
import {
  finalizeDocumentEmbedding,
  planDocumentEmbedding,
  processEmbedBatch,
  type EmbedBatchPayload,
  type EmbedFinalizePayload,
} from './knowledge/documents/embed-pipeline.ts'
import {
  computeProcessingTimeoutMs,
  NON_TERMINAL_PROCESSING_STATUSES,
} from './knowledge/documents/service.ts'
import type { DocumentProcessingPayload } from './jobs/types.ts'

const logger = createLogger('Worker')

/**
 * The lock a knowledge job holds, and how long the stall scan waits.
 *
 * Studio's numbers for its knowledge queue, and its reasoning: BullMQ's default
 * `lockDuration` is 30 seconds, and a document parse plus an embed batch
 * routinely runs longer than that without yielding. A job flagged `stalled` is
 * re-run or failed on a timer that has nothing to do with whether it is
 * working. `maxStalledCount: 2` keeps a genuinely dead worker's jobs recoverable
 * — every job here is idempotent and resumable, so a re-run is cheap and a
 * permanent loss is not.
 */
export const WORKER_LOCK_TUNING = {
  lockDuration: 5 * 60 * 1000,
  stalledInterval: 5 * 60 * 1000,
  maxStalledCount: 2,
} as const

/**
 * Wall-clock budget for one fanned-out embed batch. Bounds a stuck provider
 * request; the work is resumable, so a timeout is a retry rather than a loss.
 */
export const EMBED_BATCH_TIMEOUT_MS = 15 * 60 * 1000

/** How often the stranded-document sweep runs, when it is registered. */
export const TIMEOUT_SWEEP_INTERVAL_MS = 5 * 60 * 1000

/** The payload of a `kb.ingest.document` job. */
export interface KbIngestDocumentPayload {
  knowledgeBaseId: string
  filename: string
  /** The document's text. One of `text` or `fileUrl`. */
  text?: string
  /** A URL in Search's own bucket, fetched before the ingest. */
  fileUrl?: string
  mimeType?: string
  metadata?: Record<string, unknown>
  /** Defaults to `true` for a job — an enqueued ingest means "make it searchable". */
  includedInKb?: boolean
  /** The paired client that asked, for the event. */
  pairedClientId?: string
}

/** What a job's envelope looks like. `queue/index.ts` writes it. */
interface JobEnvelope {
  type?: JobType
  payload?: unknown
  metadata?: { correlation?: { requestId?: string } }
}

/** The ids a log line carries, so every line in a job is joinable. */
function correlationOf(job: Job | undefined): Record<string, unknown> {
  const data = job?.data as JobEnvelope | undefined
  return {
    jobId: job?.id,
    jobName: job?.name,
    queue: QUEUE_NAME,
    attempt: job?.attemptsMade,
    requestId: data?.metadata?.correlation?.requestId,
  }
}

/** Run `fn` under an abort signal that fires after `timeoutMs`. */
async function withTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number
): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fn(controller.signal)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The processor. Exported so a unit test can drive it with a fake job rather
 * than a Redis.
 */
export const processSearchJob: Processor = async (job: Job): Promise<unknown> => {
  const { payload } = (job.data ?? {}) as JobEnvelope
  logger.info('Job started', correlationOf(job))

  switch (job.name) {
    case 'knowledge-process-document': {
      /**
       * On the BullMQ backend this job is the *planner*: it parses, stages every
       * chunk and fans out the resumable batches. The embedding is no longer
       * here, but parsing a large file still is, so it keeps the size-scaled
       * budget Studio gave it.
       */
      const docPayload = payload as DocumentProcessingPayload
      return withTimeout(
        (signal) => planDocumentEmbedding(docPayload, signal),
        computeProcessingTimeoutMs(docPayload?.docData?.fileSize)
      )
    }

    case 'kb.embed.batch':
      return withTimeout(
        (signal) => processEmbedBatch(payload as EmbedBatchPayload, signal),
        EMBED_BATCH_TIMEOUT_MS
      )

    case 'kb.embed.finalize':
      return finalizeDocumentEmbedding(payload as EmbedFinalizePayload)

    case 'kb-keywords-extract':
      return handleKeywordsExtract(payload as KeywordsExtractPayload)

    case 'kb.clusters.validate':
      return handleClustersValidate(payload as { kbId: string })

    case 'kb.ingest.document':
      return runKbIngestDocument(payload as KbIngestDocumentPayload)

    case 'kb.document.timeout-sweep':
      return runDocumentTimeoutSweep()

    default:
      // Not a retry: a name this build does not know will not become one on the
      // fourth attempt. It fails loudly so an operator sees a version skew
      // rather than a queue that silently grows.
      throw new Error(`Unknown search job name: ${job.name}`)
  }
}

/**
 * The single-shot ingest, as a job.
 *
 * `ingestDocument` is the synchronous path — parse, chunk, embed and write in
 * one call — and it is what the CLI's `ingest` and a small `POST
 * /kbs/:id/documents` reach. Running it on the queue is what makes it
 * non-blocking without a second code path: same function, same ranking, one
 * `await`.
 */
async function runKbIngestDocument(payload: KbIngestDocumentPayload): Promise<unknown> {
  if (!payload?.knowledgeBaseId || !payload.filename) {
    throw new Error('kb.ingest.document: knowledgeBaseId and filename are required')
  }
  if (payload.text === undefined && !payload.fileUrl) {
    throw new Error('kb.ingest.document: one of text or fileUrl is required')
  }

  let file: Buffer | undefined
  if (payload.fileUrl && payload.text === undefined) {
    const response = await fetch(payload.fileUrl)
    if (!response.ok) {
      throw new Error(
        `kb.ingest.document: the document's bytes could not be read (${response.status})`
      )
    }
    file = Buffer.from(await response.arrayBuffer())
  }

  const result = await ingestDocument({
    kbId: payload.knowledgeBaseId,
    filename: payload.filename,
    ...(payload.text === undefined ? {} : { text: payload.text }),
    ...(file ? { file } : {}),
    ...(payload.mimeType ? { mimeType: payload.mimeType } : {}),
    ...(payload.metadata ? { metadata: payload.metadata } : {}),
    includedInKb: payload.includedInKb ?? true,
  })

  emitSearchEvent({
    type: 'document.ingested',
    pairedClientId:
      payload.pairedClientId ?? (await pairedClientOfKb(payload.knowledgeBaseId)),
    knowledgeBaseId: payload.knowledgeBaseId,
    documentId: result.documentId,
    chunkCount: result.chunkCount,
    at: eventTimestamp(),
  })
  return result
}

// ---------------------------------------------------------------------------
// Failure handling — the half ADR 0010 is about
// ---------------------------------------------------------------------------

/** The document a job was working on, when the payload names one. */
function documentOf(job: Job): { documentId: string; knowledgeBaseId: string } | null {
  const payload = (job.data as JobEnvelope | undefined)?.payload as
    | { documentId?: unknown; knowledgeBaseId?: unknown }
    | undefined
  if (typeof payload?.documentId !== 'string' || typeof payload.knowledgeBaseId !== 'string') {
    return null
  }
  return { documentId: payload.documentId, knowledgeBaseId: payload.knowledgeBaseId }
}

/** Whether BullMQ has any attempts left for this job. */
function hasAttemptsLeft(job: Job): boolean {
  const allowed = job.opts?.attempts ?? JOB_TYPE_ATTEMPTS[job.name as JobType] ?? 1
  return job.attemptsMade < allowed
}

async function pairedClientOfKb(kbId: string): Promise<string | null> {
  const rows = await db
    .select({ pairedClientId: knowledgeBase.pairedClientId })
    .from(knowledgeBase)
    .where(eq(knowledgeBase.id, kbId))
    .limit(1)
  return rows[0]?.pairedClientId ?? null
}

/**
 * Settle a job that has run out of attempts: mark its document `failed` and say
 * so.
 *
 * Idempotent by construction — the `UPDATE` narrows on a non-terminal status,
 * so a document already `completed` by a sibling batch is left alone and a
 * second failing job writes nothing. Best-effort: a database that is down is
 * the reason the job failed, and a throw here would only replace one failure
 * with another.
 */
async function failDocument(job: Job, error: Error, reason?: string): Promise<void> {
  const target = documentOf(job)
  if (!target) return
  const message = `${job.name} failed after ${job.attemptsMade} attempt(s): ${error.message}`
  try {
    const updated = await db
      .update(document)
      .set({
        processingStatus: 'failed',
        processingError: message.slice(0, 2000),
        processingCompletedAt: new Date(),
      })
      .where(
        and(
          eq(document.id, target.documentId),
          // The narrowing that makes this idempotent: a document a sibling
          // batch already carried to `completed` is not dragged back to
          // `failed` by a late finalize, and a second failing job of the same
          // fan-out writes nothing and emits nothing.
          inArray(document.processingStatus, NON_TERMINAL_PROCESSING_STATUSES)
        )
      )
      .returning({ id: document.id })
    if (updated.length === 0) return

    emitSearchEvent({
      type: 'document.failed',
      pairedClientId: await pairedClientOfKb(target.knowledgeBaseId),
      knowledgeBaseId: target.knowledgeBaseId,
      documentId: target.documentId,
      error: message,
      ...(reason ? { reason } : {}),
      at: eventTimestamp(),
    })
  } catch (err) {
    logger.error('Could not mark a document failed after its job gave up', {
      ...correlationOf(job),
      documentId: target.documentId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/** The `failed` handler, exported so a unit test can drive it without Redis. */
export async function handleJobFailure(job: Job | undefined, error: Error): Promise<void> {
  if (!job) {
    logger.error('A job failed with no job attached', {
      queue: QUEUE_NAME,
      error: error.message,
    })
    return
  }

  const keyFailure = isEndpointKeyUnavailable(error)
    ? (error as EndpointKeyUnavailableError)
    : null
  const willRetry = hasAttemptsLeft(job) && (keyFailure === null || keyFailure.retryable)

  const line = {
    ...correlationOf(job),
    error: error.message,
    errorName: error.name,
    ...(keyFailure
      ? {
          endpointKeyReason: keyFailure.reason,
          endpointId: keyFailure.endpointId,
          externalId: keyFailure.externalId,
          pairedClientId: keyFailure.pairedClientId,
        }
      : {}),
    willRetry,
  }

  if (keyFailure && keyFailure.retryable && willRetry) {
    // Not an error: a wired client's resolver being briefly away is an
    // operational fact about the other machine, and logging it at error would
    // make a rolling restart over there look like an incident over here.
    logger.warn('Job failed because a model endpoint key could not be resolved; retrying', line)
    return
  }

  logger.error('Job failed', { ...line, stack: error.stack })

  if (!willRetry) {
    await failDocument(job, error, keyFailure?.reason)
  }
}

// ---------------------------------------------------------------------------
// The worker itself
// ---------------------------------------------------------------------------

export interface StartWorkersOptions {
  /** Defaults to `SEARCH_WORKER_CONCURRENCY`. */
  concurrency?: number
  /** Override the processor. Tests only. */
  processor?: Processor
  /**
   * Register the repeatable stranded-document sweep. On for a service, off for
   * a test rig that would otherwise leave a repeatable key behind in Redis.
   */
  repeatable?: boolean
}

export interface SearchWorkers {
  workers: Worker[]
  /** Stop accepting jobs, let the running ones finish, close the connections. */
  close(): Promise<void>
}

/** Build the worker, with its event logging attached. */
export function createSearchWorker(options: StartWorkersOptions = {}): Worker {
  const concurrency = options.concurrency ?? config().SEARCH_WORKER_CONCURRENCY
  const worker = new Worker(QUEUE_NAME, options.processor ?? processSearchJob, {
    connection: getQueueConnection(),
    prefix: queuePrefix(),
    concurrency,
    ...WORKER_LOCK_TUNING,
  })

  worker.on('completed', (job: Job) => {
    logger.info('Job finished', correlationOf(job))
  })

  worker.on('failed', (job: Job | undefined, error: Error) => {
    void handleJobFailure(job, error).catch((err: unknown) => {
      logger.error('The failure handler itself failed', {
        ...correlationOf(job),
        error: err instanceof Error ? err.message : String(err),
      })
    })
  })

  worker.on('stalled', (jobId: string) => {
    // Tolerated rather than fatal: every job here is idempotent and resumable,
    // so a job whose worker died is re-run rather than lost.
    logger.warn('Job stalled — the worker lost its lock; it may be re-run', {
      queue: QUEUE_NAME,
      jobId,
    })
  })

  worker.on('error', (error: Error) => {
    // A worker-level error comes from BullMQ or from ioredis — a connection, a
    // script, a lock — and never from a handler, so there is no key in scope
    // here to keep out of it.
    logger.error('Worker error', { queue: QUEUE_NAME, error: error.message, stack: error.stack })
  })

  return worker
}

/**
 * Start the workers. Used by `pnpm dev` (API and worker in one process) and by
 * `start:worker` (the split).
 *
 * The two are the same code on purpose: a worker that only exists in the split
 * deployment is a worker nobody runs while they are developing.
 */
export async function startWorkers(options: StartWorkersOptions = {}): Promise<SearchWorkers> {
  const worker = createSearchWorker(options)
  const workers = [worker]

  if (options.repeatable !== false) {
    await registerRepeatableJobs()
  }

  logger.info('Workers started', {
    queue: QUEUE_NAME,
    prefix: queuePrefix(),
    concurrency: options.concurrency ?? config().SEARCH_WORKER_CONCURRENCY,
  })

  let closing: Promise<void> | undefined
  return {
    workers,
    close: () => {
      closing ??= (async () => {
        logger.info('Shutting workers down')
        for (const w of workers) {
          try {
            await w.close()
          } catch (err) {
            logger.error('Error closing a worker', {
              error: err instanceof Error ? err.message : String(err),
            })
          }
        }
        await closeQueue()
        logger.info('Workers stopped')
      })()
      return closing
    },
  }
}

/**
 * The repeatable jobs. One: the stranded-document sweep, which reconciles
 * documents left non-terminal by a worker that was killed rather than stopped.
 *
 * **Safe to call from every replica.** BullMQ keys a scheduler by the job's
 * name and its pattern, so three processes starting together register one
 * schedule and not three — verified rather than assumed: registering twice
 * leaves exactly one scheduler and one delayed job.
 */
export async function registerRepeatableJobs(): Promise<void> {
  const { Queue } = await import('bullmq')
  const queue = new Queue(QUEUE_NAME, {
    connection: getQueueConnection(),
    prefix: queuePrefix(),
  })
  try {
    await queue.add(
      'kb.document.timeout-sweep',
      { type: 'kb.document.timeout-sweep', payload: {}, metadata: {} },
      {
        repeat: { every: TIMEOUT_SWEEP_INTERVAL_MS },
        removeOnComplete: true,
        removeOnFail: { count: 10 },
      }
    )
    logger.info('Repeatable jobs registered', {
      sweepIntervalMs: TIMEOUT_SWEEP_INTERVAL_MS,
    })
  } catch (err) {
    // A schedule that could not be registered is not a reason to refuse to
    // process jobs: the sweep is a safety net over a failure that is itself
    // rare, and every other job on this queue still works without it.
    logger.warn('Could not register the repeatable document sweep', {
      error: err instanceof Error ? err.message : String(err),
    })
  } finally {
    await queue.close()
  }
}

/**
 * Install SIGTERM/SIGINT handlers that drain rather than kill.
 *
 * A worker killed mid-job leaves a document in `processing` until the sweep
 * finds it, which is minutes of a UI spinning for something that could have
 * been a clean handover.
 */
export function installShutdownHandlers(workers: SearchWorkers): void {
  let stopping = false
  const stop = (signal: string) => {
    if (stopping) return
    stopping = true
    logger.info(`Received ${signal}; draining`)
    workers
      .close()
      .then(() => process.exit(0))
      .catch((err: unknown) => {
        logger.error('Shutdown failed', {
          error: err instanceof Error ? err.message : String(err),
        })
        process.exit(1)
      })
  }
  process.on('SIGTERM', () => stop('SIGTERM'))
  process.on('SIGINT', () => stop('SIGINT'))
}

/** `start:worker` — the worker with no API beside it. */
export async function bootWorker(): Promise<SearchWorkers> {
  const { runMigrations } = await import('./db/migrate.ts')
  const { databaseUrl } = await import('./config.ts')
  // The worker migrates too. A split deployment where only the API migrates is
  // a deployment whose worker starts first half the time (ADR 0002).
  await runMigrations({ url: databaseUrl() })
  const workers = await startWorkers()
  installShutdownHandlers(workers)
  return workers
}

if (process.argv[1]?.endsWith('worker.ts')) {
  bootWorker().catch((err: unknown) => {
    logger.error('Worker boot failed', {
      error: err instanceof Error ? err.message : String(err),
    })
    process.exitCode = 1
  })
}
