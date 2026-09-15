/**
 * `SEARCH_INLINE_JOBS=1` — run the jobs in this process, in worker order, with
 * no Redis and no worker.
 *
 * **What it is for.** The REST fixture suite has to drive the whole ingestion
 * pipeline through the API, and the pipeline is asynchronous by construction:
 * `POST /v1/kbs/:id/documents` enqueues and answers. Without a worker beside it
 * that request would never complete anything. TASK-005 brings the real worker
 * process; until then — and in a test, afterwards too — this stands in.
 *
 * **It is a queue, not a function call.** An enqueue appends to a FIFO and
 * returns; a single consumer drains it, one job at a time, awaiting each. That
 * is deliberately the shape of a BullMQ worker at concurrency 1, and it is what
 * makes the fixture's expectations reproducible: a route still answers before
 * its work is done, jobs a handler enqueues land behind the ones already
 * waiting, and nothing runs concurrently with anything.
 *
 * **The flow producer is the same idea.** `planDocumentEmbedding` fans out N
 * `kb.embed.batch` children under a `kb.embed.finalize` parent; here that
 * becomes one FIFO entry that runs every child and then the parent, which is
 * the order BullMQ guarantees and the order the in-process fixture suite
 * already drives by hand.
 *
 * **It refuses to run outside a test environment**, for the same reason
 * `SEARCH_DEV_INSECURE` does: a deployment that quietly ran its ingestion
 * inside its API process would look like it was working right up until the
 * process was restarted mid-document. The refusal is in two places and both
 * earn their keep — `SEARCH_INLINE_JOBS` is in the configuration schema, so
 * `config()` throws before such a process finishes starting (`config.ts`), and
 * {@link inlineJobsEnabled} throws too, so no code path reaches this backend by
 * asking the question instead of reading the configuration.
 */

import { createLogger } from "@actana/search-shared/log";
import { generateId } from "@actana/search-shared/short-id";
import { inATestEnvironment } from "../config.ts";
import type { EnqueueOptions, JobQueueBackend, JobType } from "./index.ts";

const logger = createLogger("queue/inline");

/** The variable. */
export const INLINE_JOBS_VAR = "SEARCH_INLINE_JOBS";

/**
 * Is the inline runner on?
 *
 * Throws rather than answering outside a test environment: the variable being
 * set there at all is the mistake, and answering `false` would hand the caller
 * the Redis-backed queue while leaving the misconfiguration in place for
 * something else to discover.
 */
export function inlineJobsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (!/^(1|true|yes|on)$/i.test(env[INLINE_JOBS_VAR] ?? "")) return false;
  if (!inATestEnvironment(env)) {
    throw new Error(
      `${INLINE_JOBS_VAR} is set outside a test environment. That mode runs the ingestion jobs ` +
        "inside this process instead of on a worker, so a deployment would look like it was " +
        "working right up until it was restarted mid-document — it runs only where " +
        "NODE_ENV=test or SEARCH_TEST_DATABASE_URL is set.",
    );
  }
  return true;
}

type Task = () => Promise<void>;

const pending: Task[] = [];
let draining: Promise<void> | null = null;
/** Failures the drain swallowed, kept so a test can assert none happened. */
const failures: Array<{ error: unknown }> = [];

function schedule(task: Task): void {
  pending.push(task);
  if (!draining) draining = drain();
}

async function drain(): Promise<void> {
  try {
    while (pending.length > 0) {
      const task = pending.shift()!;
      try {
        await task();
      } catch (err) {
        // A worker logs a failed job and takes the next one; so does this. The
        // failure is kept for `inlineJobFailures()` rather than thrown, because
        // there is nobody left to throw at — the enqueue returned long ago.
        failures.push({ error: err });
        logger.error("Inline job failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } finally {
    draining = null;
    // A job that enqueued another one while the last `while` check was running
    // would otherwise sit in a queue with no consumer.
    if (pending.length > 0) draining = drain();
  }
}

/**
 * Wait until the FIFO is empty.
 *
 * For a test that wants the pipeline settled rather than polled, and for a
 * shutdown that does not want to cut a document in half. It re-checks after
 * every drain because a job's last act is often to enqueue the next one.
 */
export async function inlineJobsSettled(): Promise<void> {
  while (draining || pending.length > 0) {
    await draining;
    // Give a handler's own `void`-ed enqueue a turn to land.
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** Everything the drain swallowed since the last reset. */
export function inlineJobFailures(): ReadonlyArray<{ error: unknown }> {
  return failures;
}

/** Forget the failures. A test's `beforeEach`. */
export function resetInlineJobs(): void {
  failures.length = 0;
}

async function run(type: string, payload: unknown): Promise<void> {
  const { runSearchJob } = await import("../jobs/run.ts");
  await runSearchJob({ type, payload });
}

/** The backend `getJobQueue()` hands back when the inline runner is on. */
export const inlineJobQueue: JobQueueBackend = {
  async enqueue<TPayload>(
    type: JobType,
    payload: TPayload,
    options?: EnqueueOptions,
  ): Promise<string> {
    const jobId = options?.jobId ?? generateId();
    logger.debug("Inline enqueue", { type, jobId });
    schedule(() => run(type, payload));
    return jobId;
  },

  async enqueueBulk<TPayload>(
    jobs: Array<{ type: JobType; payload: TPayload; options?: EnqueueOptions }>,
  ): Promise<string[]> {
    const ids: string[] = [];
    for (const job of jobs) {
      ids.push(await inlineJobQueue.enqueue(job.type, job.payload, job.options));
    }
    return ids;
  },
};

/** One node of a BullMQ flow, as `FlowProducer.add` takes it. */
type FlowNode = {
  name: string;
  queueName?: string;
  data?: { payload?: unknown };
  children?: FlowNode[];
};

/**
 * The flow producer's stand-in: children depth-first, then the parent.
 *
 * `ignoreDependencyOnFailure` is what the real children carry, so a child that
 * throws must not stop the parent — the parent's whole job is to decide the
 * document's terminal state from how much work is left, and it has to run
 * precisely when something failed.
 */
export const inlineFlowProducer = {
  async add(flow: FlowNode): Promise<{ job: { id: string } }> {
    const id = generateId();
    schedule(async () => {
      for (const child of flow.children ?? []) {
        try {
          await run(child.name, child.data?.payload);
        } catch (err) {
          failures.push({ error: err });
          logger.warn("Inline flow child failed; the parent still runs", {
            name: child.name,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      await run(flow.name, flow.data?.payload);
    });
    return { job: { id } };
  },
  async close(): Promise<void> {},
};
