/**
 * One job name → one handler, and what is announced when it finishes.
 *
 * **This is the seam.** TASK-005's worker process pulls a job off BullMQ and
 * calls {@link runSearchJob}; the inline runner (`queue/inline.ts`,
 * `SEARCH_INLINE_JOBS=1`) calls exactly the same function from the enqueue
 * itself. Neither of them knows what a job does, and the handler table is
 * written once. A job type that is not in the table is an error rather than a
 * silent success, because a payload nobody handles is work that was lost.
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
import type { JobType } from "../queue/index.ts";

const logger = createLogger("jobs/run");

/**
 * The flow parent's job name.
 *
 * `embed-pipeline.ts` names it `kb.embed.finalize` and `queue/index.ts`'s
 * `JobType` calls it `kb.document.finalize`. Both spellings reach the same
 * handler because both spellings are already on the wire — renaming either is a
 * change that drops an in-flight job on the floor.
 */
const FINALIZE_JOB_NAMES = new Set(["kb.document.finalize", "kb.embed.finalize"]);

/** A job, as a runner hands it over. */
export type SearchJob = { type: string; payload: unknown };

/**
 * Run one job to completion, then announce whatever it made terminal.
 *
 * Rethrows whatever the handler threw: a worker needs the failure to decide
 * about a retry, and the inline runner needs it to fail a test loudly.
 */
export async function runSearchJob(job: SearchJob): Promise<void> {
  const payload = (job.payload ?? {}) as Record<string, unknown>;
  try {
    await dispatch(job.type, payload);
  } finally {
    // In `finally` on purpose: a planner that threw has already written
    // `failed` on the document, and that is exactly the state a client most
    // wants to be told about.
    await announce(job.type, payload).catch((err: unknown) => {
      logger.warn("Announcing a job's outcome failed", {
        type: job.type,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }
}

async function dispatch(type: string, payload: Record<string, unknown>): Promise<void> {
  if (FINALIZE_JOB_NAMES.has(type)) {
    const { finalizeDocumentEmbedding } = await import(
      "../knowledge/documents/embed-pipeline.ts"
    );
    await finalizeDocumentEmbedding(payload as never);
    return;
  }

  switch (type as JobType) {
    case "knowledge-process-document": {
      const { planDocumentEmbedding } = await import("../knowledge/documents/embed-pipeline.ts");
      await planDocumentEmbedding(payload as never);
      return;
    }
    case "kb.embed.batch": {
      const { processEmbedBatch } = await import("../knowledge/documents/embed-pipeline.ts");
      await processEmbedBatch(payload as never);
      return;
    }
    case "kb.ingest.document": {
      const { ingestDocument } = await import("../kb/ingest.ts");
      await ingestDocument(payload as never);
      return;
    }
    case "kb-keywords-extract": {
      const { handleKeywordsExtract } = await import("../kb/jobs/keywords-extract.ts");
      await handleKeywordsExtract(payload as never);
      return;
    }
    case "kb.clusters.validate": {
      const { handleClustersValidate } = await import("../kb/jobs/clusters-validate.ts");
      await handleClustersValidate(payload as never);
      return;
    }
    default:
      throw new Error(`no handler for job type "${type}"`);
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

function rememberAnnounced(id: string): boolean {
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

async function announce(type: string, payload: Record<string, unknown>): Promise<void> {
  if (type === "kb.clusters.validate") {
    const kbId = typeof payload.kbId === "string" ? payload.kbId : undefined;
    if (!kbId) return;
    const kb = await kbOwner(kbId);
    if (!kb) return;
    const id = searchEventId("clusters.retrained", kbId, String(kb.kmeansUpdatedAt?.getTime() ?? 0));
    if (!rememberAnnounced(id)) return;
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

  const [row] = await db
    .select({
      id: document.id,
      knowledgeBaseId: document.knowledgeBaseId,
      filename: document.filename,
      chunkCount: document.chunkCount,
      processingStatus: document.processingStatus,
      processingError: document.processingError,
    })
    .from(document)
    .where(eq(document.id, documentId))
    .limit(1);
  if (!row) return;
  if (row.processingStatus !== "completed" && row.processingStatus !== "failed") return;

  const kb = await kbOwner(row.knowledgeBaseId);
  if (!kb) return;

  const name = row.processingStatus === "completed" ? "document.ingested" : "document.failed";
  const id = searchEventId(name, documentId, row.processingStatus);
  if (!rememberAnnounced(id)) return;

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
  };
  await publishSearchEvent(kb.pairedClientId, event);
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
