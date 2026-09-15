/**
 * One job name → one handler, one wall-clock budget, and what is announced when
 * it finishes.
 *
 * **The BullMQ worker calls {@link runSearchJob} — not a handler directly —**
 * so that the worker transport and the inline one run the same code, including
 * the budget and the announcement below.
 *
 * **This is the seam.** `worker.ts` pulls a job off BullMQ and calls
 * {@link runSearchJob}; the inline runner (`queue/inline.ts`,
 * `SEARCH_INLINE_JOBS=1`) calls exactly the same function from the enqueue
 * itself. Neither of them knows what a job does, and the handler table is
 * written once. A job type that is not in the table is an error rather than a
 * silent success, because a payload nobody handles is work that was lost.
 *
 * **The per-attempt budget lives here too.** It used to be a `switch` in
 * `worker.ts` — the size-scaled parse budget for the planner, fifteen minutes
 * for an embed batch — which meant the inline runner ran unbudgeted and the two
 * transports were two descriptions of one job. {@link JOB_HANDLERS} carries the
 * budget beside the handler, so a job that accepts an `AbortSignal` gets one
 * whichever transport ran it.
 *
 * **Events are announced here rather than inside the engine.** The terminal
 * writes — a document reaching `completed` or `failed`, a fit landing — are in
 * lifted code whose behaviour is frozen (ADR 0005), and threading a publish
 * through five of them would be five edits to files that are supposed to be
 * diffable against Studio's. Announcing from the job's *completion* instead
 * reads the row that the engine just wrote and is therefore correct for every
 * path into that state, including ones added later.
 */

import { eq } from "drizzle-orm";
import { createLogger } from "@actana/search-shared/log";
import type { SearchEvent } from "@actana/search/contracts";
import { db } from "../db/client.ts";
import { document, knowledgeBase } from "../db/schema.ts";
import { publishSearchEvent, searchEventId } from "../events/publish.ts";
import { prepareIngestDocument } from "./ingest-idempotency.ts";

const logger = createLogger("jobs/run");

/** A job, as a runner hands it over. */
export type SearchJob = { type: string; payload: unknown };

/**
 * Wall-clock budget for one fanned-out embed batch. Bounds a stuck provider
 * request; the work is resumable, so a timeout is a retry rather than a loss.
 */
export const EMBED_BATCH_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * What a document of unknown size is allowed for its download alone, on top of
 * the base processing budget.
 *
 * `knowledge-process-document`'s budget is `computeProcessingTimeoutMs(fileSize)`
 * — and the JSON `url` branch of the ingest route stages a document it has not
 * fetched, so the size it knows is `0` (`api/routes/documents.ts`, and the same
 * `0` comes back through `POST …/documents/:id/include`). At `0` the budget is
 * the base one, `KB_CONFIG_MAX_DURATION` (600s by default) — which is *exactly*
 * the engine's own `TIMEOUTS.FILE_DOWNLOAD`. The job's abort therefore raced
 * the download's own timeout: which of the two fired first decided whether the
 * operator was told "download timed out" or nothing at all, and neither number
 * left any of the budget for the parsing and embedding the download is only the
 * prelude to.
 *
 * So a document whose size is unknown gets the download's wall *plus* the base
 * budget. It is a floor and not a replacement: a document whose size we do know
 * keeps the size-scaled number exactly as before.
 *
 * `document-processor.ts` exports its `TIMEOUTS` so that the agreement between
 * this number and the download's is asserted in a test rather than in a
 * comment.
 */
export const UNKNOWN_SIZE_DOWNLOAD_ALLOWANCE_MS = 600_000;

/** One entry of the dispatch table. */
type JobHandlerEntry = {
  /**
   * The handler, imported lazily — one module per entry, because this file is
   * loaded by the API process as well and the engine behind it is large.
   */
  load: () => Promise<(payload: never, signal?: AbortSignal) => Promise<unknown>>;
  /**
   * This attempt's wall-clock budget, from the payload. Absent means the job
   * runs unbounded, which is right for the short ones: a budget is only worth
   * having where the work makes a network call that can hang.
   *
   * May be `async` so that a budget which needs the engine's own numbers can
   * import them lazily, the same way {@link JobHandlerEntry.load} does.
   */
  budgetMs?: (payload: Record<string, unknown>) => number | Promise<number>;
  /**
   * Run before the handler, and decide whether to run it at all.
   *
   * The job layer's half of "every job on this queue is idempotent and
   * resumable" (ADR 0010 D1). The engine is frozen (ADR 0005), so a handler
   * that is not idempotent on its own is made idempotent *here* — by removing
   * what a previous attempt of this same job wrote, or by answering that the
   * work is already done.
   *
   * `{ skip: true }` returns from {@link runSearchJob} without calling the
   * handler. The announcement still runs: it reads the row, and the row's
   * terminal state is the same one the run that completed it already announced
   * under the same event id, so nothing new goes out.
   */
  prepare?: (payload: Record<string, unknown>) => Promise<{ skip: boolean }>;
};

/**
 * Every job name a runner can hand over, and where that job's handler is.
 *
 * **This table is the only place a job name is spelled.** It used to be three
 * places — a `FINALIZE_JOB_NAMES` set, a `switch` here and a second `switch` in
 * the worker — which is two too many for a string that is also sitting in
 * Redis. `kb.document.finalize` and `kb.embed.finalize` are both here because
 * both are already on the wire: `embed-pipeline.ts` enqueues the second and
 * `queue/index.ts`'s `JobType` used to declare the first, and renaming either
 * drops an in-flight job on the floor.
 */
const JOB_HANDLERS: Record<string, JobHandlerEntry> = {
  "kb.document.finalize": {
    load: async () =>
      (await import("../knowledge/documents/embed-pipeline.ts")).finalizeDocumentEmbedding,
  },
  "kb.embed.finalize": {
    load: async () =>
      (await import("../knowledge/documents/embed-pipeline.ts")).finalizeDocumentEmbedding,
  },
  "knowledge-process-document": {
    load: async () =>
      (await import("../knowledge/documents/embed-pipeline.ts")).planDocumentEmbedding,
    /**
     * On the BullMQ backend this job is the *planner*: it parses, stages every
     * chunk and fans out the resumable batches. The embedding is no longer
     * here, but parsing a large file still is, so it keeps the size-scaled
     * budget Studio gave it.
     */
    budgetMs: async (payload) => {
      const { computeProcessingTimeoutMs } = await import("../knowledge/documents/service.ts");
      const fileSize = (payload.docData as { fileSize?: number } | undefined)?.fileSize ?? 0;
      const budget = computeProcessingTimeoutMs(fileSize);
      // An unknown size is the `url` branch of the ingest route, which stages a
      // document it has not fetched. Its budget has to cover the download it is
      // about to do — see {@link UNKNOWN_SIZE_DOWNLOAD_ALLOWANCE_MS}.
      return fileSize > 0 ? budget : budget + UNKNOWN_SIZE_DOWNLOAD_ALLOWANCE_MS;
    },
  },
  "kb.embed.batch": {
    load: async () => (await import("../knowledge/documents/embed-pipeline.ts")).processEmbedBatch,
    budgetMs: () => EMBED_BATCH_TIMEOUT_MS,
  },
  "kb.ingest.document": {
    load: async () => (await import("../kb/ingest.ts")).ingestDocument,
    /**
     * The same size-scaled budget the planner gets, off the text this payload
     * carries — `kb.ingest.document` is the direct-text path, so the bytes are
     * in hand and there is no download to allow for.
     *
     * It had none at all, which is the number the queue's lock has to be
     * checked against (`WORKER_LOCK_TUNING`): an unbudgeted job is one with no
     * answer to "how long may this hold a lock for". The engine does not take
     * the signal yet — `ingestDocument`'s parameters are frozen (ADR 0005) —
     * so today the budget is the bound the transport reasons with rather than
     * one the work honours, and the safety against an over-running attempt is
     * {@link prepareIngestDocument} below.
     */
    budgetMs: async (payload) =>
      (await import("../knowledge/documents/service.ts")).computeProcessingTimeoutMs(
        typeof payload.text === "string" ? Buffer.byteLength(payload.text, "utf8") : 0,
      ),
    prepare: (payload) => prepareIngestDocument(payload),
  },
  "kb-keywords-extract": {
    load: async () => (await import("../kb/jobs/keywords-extract.ts")).handleKeywordsExtract,
  },
  "kb.clusters.validate": {
    load: async () => (await import("../kb/jobs/clusters-validate.ts")).handleClustersValidate,
  },
  /**
   * The stranded-document sweep. Repeatable rather than enqueued by the engine,
   * and it takes no payload — it reconciles documents that a worker which was
   * killed rather than stopped left non-terminal.
   */
  "kb.document.timeout-sweep": {
    load: async () =>
      (await import("../kb/jobs/document-timeout-sweep.ts")).runDocumentTimeoutSweep,
  },
};

/** Every job name this file answers for. `JobType`'s spellings are a subset. */
export const SEARCH_JOB_NAMES: readonly string[] = Object.keys(JOB_HANDLERS);

/** Whether this build can run a job by this name at all. */
export function isKnownJobName(type: string): boolean {
  return Object.hasOwn(JOB_HANDLERS, type);
}

export type RunSearchJobOptions = {
  /**
   * Cancel the handler from outside — a shutdown, or a transport with a budget
   * of its own. Combined with this job's own budget rather than replacing it,
   * so whichever fires first aborts the work.
   */
  signal?: AbortSignal;
  /**
   * How many further attempts the transport will give this job **if it throws**.
   *
   * `0` — the default, and what the inline runner passes — means a failure now
   * is final. Above zero the `document.failed` announcement is held back *for a
   * dispatch that threw*: the engine marks a document `failed` on a retryable
   * attempt too (a resolver that was away for thirty seconds), and Studio's
   * trigger must not see a failure for a document that is about to ingest on
   * the next attempt.
   *
   * It says nothing about a handler that **returned**. That distinction is the
   * whole of the bug below (see {@link announce}), and it is why this number is
   * read beside the outcome rather than on its own.
   */
  attemptsRemaining?: number;
};

/**
 * What the dispatch did — which is not the same question as how many attempts
 * are left, and conflating the two lost an event.
 *
 * `threw` is about *this* dispatch: a handler that raised is a handler whose
 * work the transport may run again, so a `failed` row it left behind is not
 * news yet. A handler that returned normally has finished, whatever the attempt
 * counter says, and the row it wrote is the truth about the document —
 * including when that row is `failed`.
 */
type JobOutcome = { threw: boolean; result?: unknown };

/**
 * Run one job to completion, then announce whatever it made terminal.
 *
 * Rethrows whatever the handler threw: a worker needs the failure to decide
 * about a retry, and the inline runner needs it to fail a test loudly.
 */
export async function runSearchJob(
  job: SearchJob,
  options: RunSearchJobOptions = {},
): Promise<unknown> {
  const payload = (job.payload ?? {}) as Record<string, unknown>;
  // Pessimistic until the dispatch returns: a `finally` that runs because
  // something threw must not read as "the handler finished".
  const outcome: JobOutcome = { threw: true };
  try {
    const result = await dispatch(job.type, payload, options);
    outcome.threw = false;
    outcome.result = result;
    return result;
  } finally {
    // In `finally` on purpose: a planner that threw has already written
    // `failed` on the document, and — on the attempt that is the last one —
    // that is exactly the state a client most wants to be told about.
    await announce(job.type, payload, options, outcome).catch((err: unknown) => {
      logger.warn("Announcing a job's outcome failed", {
        type: job.type,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }
}

async function dispatch(
  type: string,
  payload: Record<string, unknown>,
  options: RunSearchJobOptions,
): Promise<unknown> {
  const entry = JOB_HANDLERS[type];
  // A payload nobody handles is work that was lost, so an unknown name is an
  // error rather than a silent success.
  if (!entry) throw new Error(`no handler for job type "${type}"`);
  const handler = await entry.load();
  if (entry.prepare) {
    const { skip } = await entry.prepare(payload);
    if (skip) return undefined;
  }
  const budgetMs = await entry.budgetMs?.(payload);
  if (budgetMs === undefined) return handler(payload as never, options.signal);
  return withBudget(budgetMs, options.signal, (signal) => handler(payload as never, signal));
}

/**
 * Run `fn` under an abort signal that fires after `budgetMs`, or sooner if the
 * caller's signal does.
 *
 * `AbortSignal.any` rather than a hand-rolled listener pair, and the
 * `clearTimeout` in the `finally` is what stops a fifteen-minute timer from
 * holding a process open after a job that finished in a second.
 */
async function withBudget<T>(
  budgetMs: number,
  outer: AbortSignal | undefined,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budgetMs);
  try {
    return await fn(outer ? AbortSignal.any([outer, controller.signal]) : controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Announced ids, so one document's terminal state is published once.
 *
 * The webhook ledger already deduplicates a delivery, but an SSE stream has no
 * ledger — and a document is visited by two jobs on its way to `completed`, so
 * without this a UI sees the same "ingested" twice. Bounded, because a
 * long-lived worker would otherwise accumulate one entry per document forever;
 * losing the oldest entries only risks a duplicate SSE frame for a document
 * that finished ten thousand documents ago.
 */
const announced = new Set<string>();
const ANNOUNCED_CAP = 10_000;

/**
 * Claim an event id, or answer `false` because it has already gone out.
 *
 * Exported because the worker's failure handler announces the *other*
 * `document.failed` — the one where the engine never got as far as writing the
 * row — and both have to be in one id space, or a document that fails once is
 * two events on a UI's stream.
 */
export function claimAnnouncedEvent(id: string): boolean {
  if (announced.has(id)) return false;
  if (announced.size >= ANNOUNCED_CAP) {
    for (const old of announced) {
      announced.delete(old);
      if (announced.size < ANNOUNCED_CAP / 2) break;
    }
  }
  announced.add(id);
  return true;
}

/** Forget what has been announced. A test's `afterEach`. */
export function resetAnnouncedEvents(): void {
  announced.clear();
}

/**
 * The generation of a document's processing run, as a component of an event id.
 *
 * **Why an event id needs one.** The id is derived from the facts so that two
 * workers noticing the same thing produce one event (see
 * `events/publish.ts`) — and "this document, in this terminal state" looked
 * like the whole of the facts. It is not: a document can reach `completed`
 * twice. `POST /v1/kbs/:id/documents/:docId/include` re-runs the pipeline over
 * a document that already ingested, and the second `document.ingested` had the
 * same id as the first, so `claimAnnouncedEvent` dropped it in-process and
 * `webhook_delivery_hook_event_unique` dropped it in the ledger — *forever*.
 * A client that re-included a document was told nothing, and the row said
 * `completed` with no event to explain when.
 *
 * `processingStartedAt` is the generation, because it is stamped once per run
 * and not once per attempt: every path that starts a document over writes it
 * (`knowledge/documents/service.ts`, `embed-pipeline.ts`), and nothing writes
 * it between the attempts of one job. That is exactly the line the dedupe
 * wants — five attempts of one ingest are one event, two includes are two —
 * where `processingCompletedAt` moves on every attempt and would have made the
 * dedupe a no-op.
 *
 * It falls back to `processingCompletedAt` for a row that has no start stamp (a
 * document that was never included and then failed), and to the status alone
 * for a row with neither, which is the id this function used to return.
 */
export function documentEventGeneration(row: {
  processingStartedAt: Date | null;
  processingCompletedAt: Date | null;
}): string {
  const stamp = row.processingStartedAt ?? row.processingCompletedAt;
  return stamp ? String(stamp.getTime()) : "none";
}

/**
 * The id for a document event. One scheme, because three places announce one:
 * this file, the worker's failure handler, and the timeout sweep's
 * announcement below.
 */
export function documentEventId(
  name: "document.ingested" | "document.failed",
  documentId: string,
  row: {
    processingStatus: string;
    processingStartedAt: Date | null;
    processingCompletedAt: Date | null;
  },
): string {
  return searchEventId(name, documentId, row.processingStatus, documentEventGeneration(row));
}

async function announce(
  type: string,
  payload: Record<string, unknown>,
  options: RunSearchJobOptions,
  outcome: JobOutcome,
): Promise<void> {
  /**
   * The sweep names no document in its payload — it has none, it goes looking
   * for them — so the documents it reconciled come back in its *result*.
   *
   * Without this a `document.failed` was simply lost for the two failures the
   * sweep exists to catch: a worker killed mid-job, and a job that exceeded
   * `maxStalledCount`. Both leave the row non-terminal with no live job, so
   * neither this file's ordinary path nor the worker's failure handler ever
   * runs again for it; the sweep flipped the row to `failed` and the client was
   * never told.
   */
  if (type === "kb.document.timeout-sweep") {
    if (outcome.threw) return;
    const swept = outcome.result as { failedDocumentIds?: unknown } | undefined;
    const ids = Array.isArray(swept?.failedDocumentIds) ? swept.failedDocumentIds : [];
    for (const id of ids) {
      if (typeof id !== "string") continue;
      // `timeout` is the typed reason, the same vocabulary the worker's key
      // failures use (ADR 0010 D3): the operator's sentence is on the row.
      await announceDocumentState(id, "timeout");
    }
    return;
  }

  if (type === "kb.clusters.validate") {
    const kbId = typeof payload.kbId === "string" ? payload.kbId : undefined;
    if (!kbId) return;
    const kb = await kbOwner(kbId);
    if (!kb) return;
    const id = searchEventId("clusters.retrained", kbId, String(kb.kmeansUpdatedAt?.getTime() ?? 0));
    if (!claimAnnouncedEvent(id)) return;
    const event: SearchEvent = {
      id,
      event: "clusters.retrained",
      occurredAt: new Date().toISOString(),
      kbId,
    };
    await publishSearchEvent(kb.pairedClientId, event);
    return;
  }

  const documentId =
    typeof payload.documentId === "string" ? payload.documentId : undefined;
  if (!documentId) return;

  const row = await documentRow(documentId);
  if (!row) return;

  /**
   * The document has to be in the KB the payload named.
   *
   * This lookup is by document id alone — which is right, because the row is
   * what says what happened — and the event is then published to *that row's*
   * owner. So a payload naming one client's document under another client's KB
   * would have announced on the first client's stream on the second client's
   * say-so. The route layer refuses such a pair now (`api/routes/keywords.ts`),
   * and this is the same check on the other side of the queue, where a payload
   * may also have been written by an older version of a route.
   */
  const claimedKbId = payloadKbId(payload);
  if (claimedKbId !== undefined && claimedKbId !== row.knowledgeBaseId) {
    logger.warn("A job's payload named a knowledge base the document is not in; not announcing", {
      documentId,
      claimedKbId,
      actualKbId: row.knowledgeBaseId,
      type,
    });
    return;
  }

  if (row.processingStatus !== "completed" && row.processingStatus !== "failed") return;

  /**
   * A failure with attempts left is not a failure yet — **when this dispatch is
   * what failed**.
   *
   * The engine marks the document `failed` as soon as *an attempt* gave up, and
   * on attempt one of five that is routinely a resolver that will answer on the
   * next one, which Studio's trigger must not act on. The id is deliberately
   * not claimed on the way out, so the attempt that really is the last one can
   * still announce it.
   *
   * **The outcome is half the question, and it was missing.** `attemptsMade + 1`
   * subtracted from the queue's `attempts` is `2` on a first attempt of three,
   * whether that attempt threw or returned — and `finalizeDocumentEmbedding`
   * *returns normally* after marking a document `failed` for batches that have
   * exhausted their own attempts. So the announcement was held back, the job
   * completed, BullMQ's `failed` handler never ran, nothing ever re-read the
   * row, and `document.failed` was never sent on the ordinary path. (The
   * fixture suites are green because the inline runner passes `0`.) A handler
   * that returned has finished: whatever the attempt counter says, the row is
   * the truth.
   */
  if (row.processingStatus === "failed" && outcome.threw && (options.attemptsRemaining ?? 0) > 0) {
    logger.debug("A document is failed but its job has attempts left; not announcing yet", {
      documentId,
      type,
      attemptsRemaining: options.attemptsRemaining,
    });
    return;
  }

  await announceDocumentState(documentId, undefined, row);
}

/**
 * Publish whatever terminal state a document's row is in, once.
 *
 * Takes the row when the caller has just read it and re-reads it when the
 * caller has not (the sweep, which reconciled a list of ids). Everything about
 * the event comes off the row — which is what makes this correct for every path
 * into a terminal state, including ones added later.
 */
async function announceDocumentState(
  documentId: string,
  reason?: string,
  known?: AnnounceableDocument,
): Promise<void> {
  const row = known ?? (await documentRow(documentId));
  if (!row) return;
  if (row.processingStatus !== "completed" && row.processingStatus !== "failed") return;

  const kb = await kbOwner(row.knowledgeBaseId);
  if (!kb) return;

  const name = row.processingStatus === "completed" ? "document.ingested" : "document.failed";
  const id = documentEventId(name, documentId, row);
  if (!claimAnnouncedEvent(id)) return;

  const event: SearchEvent = {
    id,
    event: name,
    occurredAt: new Date().toISOString(),
    kbId: row.knowledgeBaseId,
    documentId,
    filename: row.filename,
    ...(name === "document.ingested" ? { chunkCount: row.chunkCount } : {}),
    ...(name === "document.failed" && row.processingError
      ? { error: row.processingError.slice(0, 2000) }
      : {}),
    ...(name === "document.failed" && reason ? { reason } : {}),
  };
  await publishSearchEvent(kb.pairedClientId, event);
}

/**
 * The knowledge base a payload claims, under either of the two names the
 * payloads use — `knowledgeBaseId` in the worker-flow payloads and `kbId` in
 * `kb.ingest.document`'s. `undefined` when it names none, which is not a
 * mismatch: `kb.embed.batch` carries only the document.
 */
function payloadKbId(payload: Record<string, unknown>): string | undefined {
  if (typeof payload.knowledgeBaseId === "string") return payload.knowledgeBaseId;
  if (typeof payload.kbId === "string") return payload.kbId;
  return undefined;
}

/** The document row an announcement reads. */
export type AnnounceableDocument = {
  id: string;
  knowledgeBaseId: string;
  filename: string;
  chunkCount: number;
  processingStatus: string;
  processingError: string | null;
  /** The generation of this processing run — see {@link documentEventGeneration}. */
  processingStartedAt: Date | null;
  processingCompletedAt: Date | null;
};

/**
 * One document, by id. `null` when there is no such row.
 *
 * Exported because the worker's failure handler needs the same row for the same
 * reason — to say what happened rather than what it was told.
 */
export async function documentRow(documentId: string): Promise<AnnounceableDocument | null> {
  const [row] = await db
    .select({
      id: document.id,
      knowledgeBaseId: document.knowledgeBaseId,
      filename: document.filename,
      chunkCount: document.chunkCount,
      processingStatus: document.processingStatus,
      processingError: document.processingError,
      processingStartedAt: document.processingStartedAt,
      processingCompletedAt: document.processingCompletedAt,
    })
    .from(document)
    .where(eq(document.id, documentId))
    .limit(1);
  return row ?? null;
}

async function kbOwner(
  kbId: string,
): Promise<{ pairedClientId: string; kmeansUpdatedAt: Date | null } | null> {
  const [row] = await db
    .select({
      pairedClientId: knowledgeBase.pairedClientId,
      kmeansUpdatedAt: knowledgeBase.kmeansUpdatedAt,
    })
    .from(knowledgeBase)
    .where(eq(knowledgeBase.id, kbId))
    .limit(1);
  return row ?? null;
}
