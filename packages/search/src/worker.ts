/**
 * Search's ingestion worker (ADR 0006, ADR 0010).
 *
 * One BullMQ `Worker` on one queue — `search-knowledge`, under the prefix
 * `SEARCH_QUEUE_PREFIX`. Studio's `worker/index.ts` ran four queues for four
 * products; Search has one, and the concurrency, the lock duration and the
 * stall settings are the ones Studio used for *its* knowledge queue, because
 * the jobs are the same jobs.
 *
 * **The routing table is not here.** `jobs/run.ts` owns it — one job name, one
 * handler, one wall-clock budget, one announcement — and this file hands a job
 * over to {@link runSearchJob} exactly the way the inline runner does. It used
 * to be a `switch` here beside a second table there, which is two spellings of
 * every job name and two places for an event to be announced from; the worker's
 * job is the half `jobs/run.ts` cannot do, which is deciding what a *failure*
 * means.
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

import { Job, UnrecoverableError, Worker, type Processor } from 'bullmq'
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
import { publishSearchEvent } from './events/publish.ts'
import { assertEncryptionKeyConfigured } from './core/security/encryption.ts'
import {
  isEndpointKeyUnavailable,
  type EndpointKeyUnavailableError,
} from './models/endpoint-key-errors.ts'
import {
  claimAnnouncedEvent,
  documentEventId,
  documentRow,
  isKnownJobName,
  runSearchJob,
} from './jobs/run.ts'
import { NON_TERMINAL_PROCESSING_STATUSES } from './knowledge/documents/service.ts'
import type { KbIngestDocumentPayload } from './jobs/types.ts'

const logger = createLogger('Worker')

/**
 * The lock a knowledge job holds, how often it is renewed, and how long the
 * stall scan waits.
 *
 * Studio's numbers for its knowledge queue, and its reasoning: BullMQ's default
 * `lockDuration` is 30 seconds, and a document parse plus an embed batch
 * routinely runs longer than that without yielding. A job flagged `stalled` is
 * re-run or failed on a timer that has nothing to do with whether it is
 * working. `maxStalledCount: 2` keeps a genuinely dead worker's jobs recoverable
 * — every job here is idempotent and resumable, so a re-run is cheap and a
 * permanent loss is not.
 *
 * **The lock is shorter than the longest job, and that is deliberate.** A
 * `kb.embed.batch` may run for fifteen minutes and a
 * `knowledge-process-document` for up to an hour (`jobs/run.ts`'s budgets), so
 * a `lockDuration` that *covered* the longest budget would be an hour — which
 * is how long a dead worker's job would then be unrecoverable. What covers a
 * long job is the renewal: BullMQ extends the lock of every job it is running
 * on a timer, and `lockRenewTime` is that timer. It is set explicitly and well
 * under half the lock (the default is exactly half, which gives a job **one**
 * chance to renew before its lock expires); at thirty seconds a job has ten,
 * so a momentary stall of the event loop no longer costs it the lock.
 *
 * When renewal cannot happen at all — a worker that was killed, an event loop
 * blocked for minutes — the job *is* re-run, and what makes that safe rather
 * than duplicating work is the job layer: `jobs/run.ts` short-circuits a
 * document that is already `completed` and drops what a previous attempt wrote
 * before re-running one that is not.
 */
export const WORKER_LOCK_TUNING = {
  lockDuration: 5 * 60 * 1000,
  lockRenewTime: 30 * 1000,
  stalledInterval: 5 * 60 * 1000,
  maxStalledCount: 2,
} as const

/** How often the stranded-document sweep runs, when it is registered. */
export const TIMEOUT_SWEEP_INTERVAL_MS = 5 * 60 * 1000

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

/**
 * A job this build cannot run, whatever happens next: a name it does not know,
 * a payload missing something it needs.
 *
 * Its own type so it can be *classified*. Thrown as a plain `Error` it is
 * indistinguishable from "the provider timed out", and BullMQ spends the job's
 * attempts re-reading the same malformed payload before reporting the same
 * thing. Fields are assigned in the body rather than as constructor parameter
 * properties: Node's type stripping cannot erase those
 * (`scripts/check-strip-types.mjs`).
 */
export class NotRunnableJobError extends Error {
  override readonly name = 'NotRunnableJobError'
}

/** The typed key failure in `error`, or in its `cause`, or null. */
function endpointKeyFailureOf(error: unknown): EndpointKeyUnavailableError | null {
  if (isEndpointKeyUnavailable(error)) return error
  const cause = (error as { cause?: unknown } | null | undefined)?.cause
  return isEndpointKeyUnavailable(cause) ? cause : null
}

/**
 * Could a later attempt of this job succeed?
 *
 * The question ADR 0010 says only the code that failed can answer, asked at the
 * one place that has to act on it. Three shapes say no: a job that is not
 * runnable at all, a key failure whose `reason` is terminal (the client forgot
 * the endpoint, the credential will not decrypt, the resolver names another
 * model, the row is another client's), and an error that has already been
 * marked unrecoverable.
 */
export function isTerminalJobFailure(error: unknown): boolean {
  if (error instanceof NotRunnableJobError) return true
  if (error instanceof UnrecoverableError) return true
  const keyFailure = endpointKeyFailureOf(error)
  return keyFailure !== null && !keyFailure.retryable
}

/**
 * Re-throw a terminal failure as the only thing BullMQ reads: `UnrecoverableError`.
 *
 * Without this the classification was advice. `handleJobFailure` knew perfectly
 * well that a resolver answering `404 unknown-endpoint` would answer the same
 * on the fifth attempt, marked the document `failed` on the first — and BullMQ,
 * which has never heard of `retryable`, re-queued the job anyway. Every attempt
 * then ran a full ingest against a stale mirror to arrive at the same 404: five
 * resolver round trips, five parses, and (until the rebase onto TASK-004's
 * `documentId` payload) five document rows for one document.
 *
 * The original error is kept as the `cause` rather than discarded: it carries
 * the `reason` that `handleJobFailure` puts in the log line and in
 * `document.failed`, and the operator's sentence is the whole point of ADR 0010.
 */
function asBullMqFailure(error: unknown): unknown {
  if (error instanceof UnrecoverableError) return error
  if (!isTerminalJobFailure(error)) return error
  const message = error instanceof Error ? error.message : String(error)
  const unrecoverable = new UnrecoverableError(message)
  unrecoverable.cause = error
  if (error instanceof Error && error.stack) unrecoverable.stack = error.stack
  return unrecoverable
}

/**
 * The processor. Exported so a unit test can drive it with a fake job rather
 * than a Redis.
 *
 * Three lines of its own and then {@link runSearchJob}, which is the whole
 * point: the dispatch table, the per-job budget and the terminal-state
 * announcement are shared with the inline runner rather than written twice.
 * What is local to this transport is the two things BullMQ needs and the inline
 * runner has no concept of — how many attempts are left, and whether this
 * failure should consume them (see {@link asBullMqFailure}).
 */
export const processSearchJob: Processor = async (job: Job): Promise<unknown> => {
  logger.info('Job started', correlationOf(job))
  try {
    assertRunnable(job)
    return await runSearchJob(
      { type: job.name, payload: (job.data ?? {}).payload },
      { attemptsRemaining: attemptsRemaining(job) },
    )
  } catch (err) {
    throw asBullMqFailure(err)
  }
}

/**
 * How many further attempts BullMQ will give this job if this one throws.
 *
 * `attemptsMade` is the count of attempts *already finished* while the processor
 * runs — `Job` increments it in `moveToFailed`/`moveToCompleted`, after the
 * handler has returned — and BullMQ's own retry test is
 * `attemptsMade + 1 < opts.attempts`. This is that subtraction, and it is what
 * `jobs/run.ts` holds a `document.failed` back on: the engine marks a document
 * failed the moment an attempt gives up, which on attempt one of five is not
 * news anybody should act on.
 */
function attemptsRemaining(job: Job): number {
  const allowed = job.opts?.attempts ?? JOB_TYPE_ATTEMPTS[job.name as JobType] ?? 1
  return Math.max(0, allowed - ((job.attemptsMade ?? 0) + 1))
}

/**
 * The two payload shapes that are not runnable at all, checked before dispatch.
 *
 * Both are the same decision as an unknown key failure — a retry cannot change
 * the answer — and both used to be plain `Error`s, which BullMQ cheerfully
 * re-queued. `jobs/run.ts` throws an untyped error for a name it has no handler
 * for; the name is asked about *here*, before the job runs, so that the refusal
 * is an {@link NotRunnableJobError} and therefore terminal.
 */
function assertRunnable(job: Job): void {
  if (!isKnownJobName(job.name)) {
    // Not a retry: a name this build does not know will not become one on the
    // fourth attempt. It fails loudly so an operator sees a version skew
    // rather than a queue that silently grows.
    throw new NotRunnableJobError(`Unknown search job name: ${job.name}`)
  }
  if (job.name !== 'kb.ingest.document') return
  /**
   * `kb.ingest.document` is the one job whose payload this file still reads,
   * because it is the one the frozen `ingestDocument` destructures directly
   * (`jobs/types.ts`'s `KbIngestDocumentPayload`). A payload missing its
   * knowledge base is missing it on every attempt.
   *
   * The `fileUrl` branch this used to have is gone with the shape: nothing
   * enqueues it. A file-backed document goes to `knowledge-process-document`,
   * which reads its bytes from the row the route staged.
   */
  const payload = ((job.data ?? {}).payload ?? {}) as Partial<KbIngestDocumentPayload>
  if (!payload.kbId || !payload.filename) {
    throw new NotRunnableJobError('kb.ingest.document: kbId and filename are required')
  }
  if (payload.text === undefined) {
    throw new NotRunnableJobError('kb.ingest.document: text is required')
  }
}

// ---------------------------------------------------------------------------
// Failure handling — the half ADR 0010 is about
// ---------------------------------------------------------------------------

/**
 * The document a job was working on, when the payload names one.
 *
 * Under **either** spelling of the knowledge base id: the worker-flow payloads
 * say `knowledgeBaseId` and `kb.ingest.document`'s says `kbId`, because that is
 * what the frozen `ingestDocument` destructures (ADR 0005). Reading only the
 * first meant an ingest job that ran out of attempts left its document in
 * `pending` for the sweep to find, with nothing said about it.
 */
function documentOf(job: Job): { documentId: string; knowledgeBaseId: string } | null {
  const payload = (job.data as JobEnvelope | undefined)?.payload as
    | { documentId?: unknown; knowledgeBaseId?: unknown; kbId?: unknown }
    | undefined
  if (typeof payload?.documentId !== 'string') return null
  const kbId =
    typeof payload.knowledgeBaseId === 'string'
      ? payload.knowledgeBaseId
      : typeof payload.kbId === 'string'
        ? payload.kbId
        : null
  if (kbId === null) return null
  return { documentId: payload.documentId, knowledgeBaseId: kbId }
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
 *
 * **This is the second of the two places a `document.failed` comes from, and
 * they share one id space.** `jobs/run.ts` announces the state the *engine*
 * wrote, which is the ordinary path; this one covers the failures the engine
 * never saw — a key that could not be resolved before any row was touched — and
 * adds the typed `reason`, which is not on the row. Both derive the event id
 * from the same facts and both go through `claimAnnouncedEvent`, so a document
 * that fails is one event rather than two.
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
      /**
       * The stamps come back because the event id carries the *generation* of
       * the processing run (`documentEventId`): a document that fails, is
       * re-included and fails again is two events, and five attempts of one
       * run are one. `processing_started_at` is not touched by this update, so
       * what is returned is this run's own generation.
       */
      .returning({
        id: document.id,
        processingStartedAt: document.processingStartedAt,
        processingCompletedAt: document.processingCompletedAt,
      })

    let generation = updated[0]
    if (!generation) {
      /**
       * Nothing to write — but possibly something still to say.
       *
       * Two ways here. A sibling carried the document to `completed`, in which
       * case this job's failure is not news and the early return is right. Or
       * the engine had already marked it `failed` on *this* attempt — and if
       * this attempt had attempts left (a terminal error, refused before
       * BullMQ's counter ran out), `jobs/run.ts` deliberately held the
       * announcement back. Somebody has to make it, and the claim below is what
       * stops it being made twice.
       */
      const row = await documentRow(target.documentId)
      if (row?.processingStatus !== 'failed') return
      generation = row
    }

    const id = documentEventId('document.failed', target.documentId, {
      processingStatus: 'failed',
      processingStartedAt: generation.processingStartedAt ?? null,
      processingCompletedAt: generation.processingCompletedAt ?? null,
    })
    if (!claimAnnouncedEvent(id)) return
    const pairedClientId = await pairedClientOfKb(target.knowledgeBaseId)
    // No paired client is no addressee: the KB was deleted under the job, and
    // there is nobody to tell.
    if (!pairedClientId) return
    await publishSearchEvent(pairedClientId, {
      id,
      event: 'document.failed',
      occurredAt: new Date().toISOString(),
      kbId: target.knowledgeBaseId,
      documentId: target.documentId,
      error: message.slice(0, 2000),
      // The machine-readable half of ADR 0010 D3, and the reason this path
      // exists beside the one in `jobs/run.ts`: the row carries the operator's
      // sentence and not the typed reason behind it.
      ...(reason ? { reason } : {}),
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

  // Through the `cause` as well as the error itself: a terminal failure reaches
  // here wrapped in `UnrecoverableError`, and the `reason` the operator needs
  // is on what it wraps.
  const keyFailure = endpointKeyFailureOf(error)
  const terminal = isTerminalJobFailure(error)
  const willRetry = !terminal && hasAttemptsLeft(job)

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
    terminal,
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

/** Something else this process should close before it exits. */
export interface ShutdownCloser {
  /** What a log line calls it. */
  name: string
  close(): Promise<void>
}

/**
 * Drain the workers, then close whatever else was handed over, in that order.
 *
 * Exported so the ordering can be asserted against fakes rather than against a
 * real listener and a real Redis.
 *
 * **The order is the decision.** The worker goes first because a job in flight
 * still needs the database and the queue, and a listener closed underneath it
 * would turn a clean handover into the half-written document this whole
 * function exists to avoid. The servers then close in the order they were
 * given — the API before the admin socket, which is the order they were opened
 * in, so the last thing to stop answering is the socket an operator would use
 * to ask what is happening.
 *
 * Every close is best-effort and independent: one listener that will not shut
 * down must not leave the next one open, and a shutdown that throws is a
 * container that gets killed instead.
 */
export async function drainAndClose(
  workers: SearchWorkers | null,
  closers: readonly ShutdownCloser[] = []
): Promise<void> {
  if (workers) {
    try {
      await workers.close()
    } catch (err) {
      logger.error('Error draining the workers', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  for (const closer of closers) {
    try {
      await closer.close()
      logger.info('Closed', { what: closer.name })
    } catch (err) {
      logger.error('Error closing a listener', {
        what: closer.name,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
}

/**
 * Install SIGTERM/SIGINT handlers that drain rather than kill.
 *
 * A worker killed mid-job leaves a document in `processing` until the sweep
 * finds it, which is minutes of a UI spinning for something that could have
 * been a clean handover.
 *
 * `closers` is what the *combined* process hands over (ADR 0010 D2). Draining
 * the worker and then calling `process.exit(0)` was right for `start:worker`
 * and wrong for `index.ts`, where the same function also owned the API listener
 * and the admin socket: the exit closed neither, so an in-flight request was
 * cut mid-response and the socket file survived at `$SEARCH_STATE_DIR/admin.sock`
 * for the next boot to trip over. `admin.close()` unlinks it, which is why the
 * fix is to *call* the closers rather than to add an unlink here.
 */
export function installShutdownHandlers(
  workers: SearchWorkers | null,
  closers: readonly ShutdownCloser[] = []
): void {
  let stopping = false
  const stop = (signal: string) => {
    if (stopping) return
    stopping = true
    logger.info(`Received ${signal}; draining`)
    drainAndClose(workers, closers)
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
  // Before the migrations and before the queue. A worker with no
  // `SEARCH_ENCRYPTION_KEY` starts happily and then fails every job that needs
  // a mirrored key, one cipher error at a time; it is required in both modes
  // (ADR 0010 D7), so the right place to say so is here.
  assertEncryptionKeyConfigured()
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
