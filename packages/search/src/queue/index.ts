/**
 * Search's queue (ADR 0006). Replaces Studio's `@actana/queue` and
 * `lib/core/async-jobs/config`.
 *
 * The lifted engine only ever calls `(await getJobQueue()).enqueue(type,
 * payload, options?)`, so that is the surface this keeps — same name, same
 * shape, same job type strings — and the ingest and clustering code is
 * unchanged.
 *
 * lifted: Studio's binary backend dispatch is gone. It resolved to BullMQ *or*
 * to an `async_jobs` table that self-executed the handler inline through
 * `queueMicrotask`, because Studio runs in a Next.js process that may have no
 * worker beside it. Search is a service with its own worker (TASK-005), so
 * there is one backend and `shouldExecuteInline` — the double-execution guard
 * that only existed to make the inline backend safe — has nothing to guard.
 *
 * The prefix is `search`, which is what makes sharing a client's Redis safe.
 */

import { FlowProducer, Queue } from 'bullmq'
import { createLogger } from '@actana/search-shared/log'
import { generateId } from '@actana/search-shared/short-id'
import { getQueueConnection } from './redis.ts'
import { inlineFlowProducer, inlineJobQueue, inlineJobsEnabled } from './inline.ts'

const logger = createLogger('queue')

/** Namespace for every key Search writes into Redis. */
export const QUEUE_PREFIX = 'search'

/** The queue every ingestion job lands on. */
export const QUEUE_NAME = 'search-knowledge'

/**
 * The queue-name map the lifted fan-out addresses jobs through. Studio's
 * `@actana/queue` registry named five queues across four products; Search has
 * one, under the key the KB code already used.
 */
export const QUEUE_NAMES = {
  knowledge: QUEUE_NAME,
} as const

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES]

/**
 * The job names the engine enqueues. Kept as Studio's strings: the payloads are
 * the same and a renamed job is a job an in-flight deploy drops on the floor.
 */
export type JobType =
  | 'knowledge-process-document'
  | 'kb-keywords-extract'
  | 'kb.clusters.validate'
  | 'kb.ingest.document'
  | 'kb.embed.batch'
  | 'kb.document.finalize'

export interface EnqueueOptions {
  maxAttempts?: number
  metadata?: Record<string, unknown>
  jobId?: string
  priority?: number
  name?: string
  delayMs?: number
  tags?: string[]
}

/** Default retry count per job type. */
export const JOB_TYPE_ATTEMPTS: Record<JobType, number> = {
  'knowledge-process-document': 3,
  'kb-keywords-extract': 3,
  'kb.clusters.validate': 2,
  'kb.ingest.document': 3,
  'kb.embed.batch': 5,
  'kb.document.finalize': 3,
}

/**
 * The queue surface the engine sees. Named `JobQueueBackend` after Studio's
 * interface so the lifted code's type annotations survive the move.
 */
export interface JobQueueBackend {
  enqueue<TPayload>(type: JobType, payload: TPayload, options?: EnqueueOptions): Promise<string>
  enqueueBulk<TPayload>(
    jobs: Array<{ type: JobType; payload: TPayload; options?: EnqueueOptions }>
  ): Promise<string[]>
}

let queue: Queue | undefined

function bullQueue(): Queue {
  if (queue) return queue
  queue = new Queue(QUEUE_NAME, {
    connection: getQueueConnection(),
    prefix: QUEUE_PREFIX,
    defaultJobOptions: {
      removeOnComplete: { age: 24 * 60 * 60 },
      removeOnFail: { age: 48 * 60 * 60 },
    },
  })
  return queue
}

const backend: JobQueueBackend = {
  async enqueue(type, payload, options) {
    const jobId = options?.jobId ?? generateId()
    await bullQueue().add(
      type,
      { type, payload, metadata: options?.metadata ?? {} },
      {
        jobId,
        attempts: options?.maxAttempts ?? JOB_TYPE_ATTEMPTS[type] ?? 3,
        priority: options?.priority,
        delay: options?.delayMs,
      }
    )
    logger.debug('Enqueued job', { type, jobId })
    return jobId
  },

  async enqueueBulk(jobs) {
    const prepared = jobs.map((job) => {
      const jobId = job.options?.jobId ?? generateId()
      return {
        name: job.type,
        data: { type: job.type, payload: job.payload, metadata: job.options?.metadata ?? {} },
        opts: {
          jobId,
          attempts: job.options?.maxAttempts ?? JOB_TYPE_ATTEMPTS[job.type] ?? 3,
          priority: job.options?.priority,
          delay: job.options?.delayMs,
        },
      }
    })
    await bullQueue().addBulk(prepared)
    return prepared.map((p) => p.opts.jobId)
  },
}

/**
 * The queue. Async to keep the lifted `await getJobQueue()` call sites intact.
 *
 * **`SEARCH_INLINE_JOBS=1` swaps the backend here and nowhere else.** That is
 * the seam TASK-005 replaces with a real worker process: the engine enqueues
 * through this one function, so which side of it does the work is a decision
 * this file makes and no call site sees. `queue/inline.ts` says what the inline
 * side is for and why it refuses to be a deployment.
 */
export async function getJobQueue(): Promise<JobQueueBackend> {
  return inlineJobsEnabled() ? inlineJobQueue : backend
}

let flowProducer: FlowProducer | undefined

/**
 * The BullMQ flow producer. The embed fan-out is a parent `kb.document.finalize`
 * job over N `kb.embed.batch` children, which is the whole reason a flow
 * producer is in the graph at all: the finalize step must run once, after the
 * last batch, whichever batch that turns out to be.
 */
export function getFlowProducer(): FlowProducer {
  // The inline stand-in implements the one method the fan-out calls. It is not
  // a `FlowProducer` and cannot be — the cast is the honest shape of "this is
  // the seam", and `queue/inline.ts` is where it is justified.
  if (inlineJobsEnabled()) return inlineFlowProducer as unknown as FlowProducer
  if (flowProducer) return flowProducer
  flowProducer = new FlowProducer({
    connection: getQueueConnection(),
    prefix: QUEUE_PREFIX,
  })
  return flowProducer
}

export async function closeFlowProducer(): Promise<void> {
  if (!flowProducer) return
  const open = flowProducer
  flowProducer = undefined
  await open.close()
}

/** Close the queue and its connection. For a worker shutting down, and for tests. */
export async function closeQueue(): Promise<void> {
  await closeFlowProducer()
  if (queue) {
    const open = queue
    queue = undefined
    await open.close()
  }
}

export { getQueueConnection, resetQueueConnection } from './redis.ts'
export {
  INLINE_JOBS_VAR,
  inlineJobFailures,
  inlineJobsEnabled,
  inlineJobsSettled,
  resetInlineJobs,
} from './inline.ts'
