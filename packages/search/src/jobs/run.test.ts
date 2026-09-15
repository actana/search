/**
 * The numbers in the job layer, and the two invariants that tie them to the
 * transport under them.
 *
 * Neither of these is a behaviour a mock can stand in for: they are agreements
 * between two files that each look right on their own.
 *
 *   1. **An unknown-size document's budget must cover the download it is about
 *      to do.** The JSON `url` branch of the ingest route stages a document it
 *      has not fetched, so its `fileSize` is `0` and the budget is the base
 *      one — which is the download's own timeout to the millisecond, so the
 *      two raced.
 *   2. **A job may hold a lock for longer than the lock lasts**, which is only
 *      safe because BullMQ renews it. `lockRenewTime` is what has to be short
 *      enough for that to be true more than once.
 *
 * @vitest-environment node
 */
import { describe, expect, it } from "vitest";
import { TIMEOUTS } from "../knowledge/documents/document-processor.ts";
import { WORKER_LOCK_TUNING } from "../worker.ts";
import {
  documentEventGeneration,
  documentEventId,
  EMBED_BATCH_TIMEOUT_MS,
  UNKNOWN_SIZE_DOWNLOAD_ALLOWANCE_MS,
} from "./run.ts";

describe("the unknown-size budget floor", () => {
  it("is the engine's own file-download timeout", () => {
    // If the engine's number changes, this is where it is noticed — rather
    // than in a job that is aborted while its download is still legal.
    expect(UNKNOWN_SIZE_DOWNLOAD_ALLOWANCE_MS).toBe(TIMEOUTS.FILE_DOWNLOAD);
  });
});

describe("the queue's lock tuning", () => {
  it("renews the lock several times over, rather than once", () => {
    // BullMQ's default is `lockDuration / 2`, which gives a job exactly one
    // chance to renew before its lock expires. A momentary stall then costs it
    // the lock, and the job is re-run.
    expect(WORKER_LOCK_TUNING.lockRenewTime).toBeLessThanOrEqual(
      WORKER_LOCK_TUNING.lockDuration / 4,
    );
    expect(WORKER_LOCK_TUNING.lockRenewTime).toBeGreaterThan(0);
  });

  it("is deliberately shorter than the longest job, and says why", () => {
    /**
     * Not an accident to be corrected: a `lockDuration` long enough to cover
     * an hour-long document parse is an hour before a dead worker's job can be
     * recovered. What covers a long job is the renewal above; what makes a
     * re-run safe when renewal fails is the job layer's idempotency
     * (`ingest-idempotency.ts`).
     */
    expect(EMBED_BATCH_TIMEOUT_MS).toBeGreaterThan(WORKER_LOCK_TUNING.lockDuration);
    expect(WORKER_LOCK_TUNING.maxStalledCount).toBeGreaterThan(0);
  });
});

describe("a document event's generation", () => {
  const row = (
    startedAt: string | null,
    completedAt: string | null,
  ): {
    processingStatus: string;
    processingStartedAt: Date | null;
    processingCompletedAt: Date | null;
  } => ({
    processingStatus: "completed",
    processingStartedAt: startedAt === null ? null : new Date(startedAt),
    processingCompletedAt: completedAt === null ? null : new Date(completedAt),
  });

  it("is the start of the run, which is stamped once per run and not per attempt", () => {
    const first = row("2026-09-15T10:00:00Z", "2026-09-15T10:00:10Z");
    // The same run, read again after a later attempt wrote a new completion
    // stamp: one generation, therefore one event id.
    const later = row("2026-09-15T10:00:00Z", "2026-09-15T10:04:00Z");
    expect(documentEventGeneration(first)).toBe(documentEventGeneration(later));
    expect(documentEventId("document.ingested", "doc-1", first)).toBe(
      documentEventId("document.ingested", "doc-1", later),
    );
  });

  it("changes when the document is processed again", () => {
    // `POST …/documents/:docId/include` re-runs the pipeline, which re-stamps
    // `processingStartedAt`. Without this the second `document.ingested` had
    // the first one's id and was dropped by the dedupe and by the delivery
    // ledger's unique index — forever.
    const run1 = row("2026-09-15T10:00:00Z", "2026-09-15T10:00:10Z");
    const run2 = row("2026-09-16T08:00:00Z", "2026-09-16T08:00:10Z");
    expect(documentEventId("document.ingested", "doc-1", run1)).not.toBe(
      documentEventId("document.ingested", "doc-1", run2),
    );
  });

  it("falls back to the completion stamp, and then to neither", () => {
    expect(documentEventGeneration(row(null, "2026-09-15T10:00:10Z"))).toBe(
      String(new Date("2026-09-15T10:00:10Z").getTime()),
    );
    expect(documentEventGeneration(row(null, null))).toBe("none");
  });

  it("gives a success and a failure of one run different ids", () => {
    const stamps = { start: "2026-09-15T10:00:00Z", end: "2026-09-15T10:00:10Z" };
    const completed = row(stamps.start, stamps.end);
    const failed = { ...completed, processingStatus: "failed" };
    expect(documentEventId("document.ingested", "doc-1", completed)).not.toBe(
      documentEventId("document.failed", "doc-1", failed),
    );
  });
});
