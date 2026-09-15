/**
 * `kb.ingest.document`, made safe to run twice.
 *
 * **Its own module, and not part of `jobs/run.ts`,** because it is what decides
 * whether the frozen handler runs at all, and a decision with that much of a
 * document's state behind it wants to be somewhere a reader can find it and a
 * test can drive it on its own.
 *
 * **What goes wrong without it.** `kb/ingest.ts` chunks, embeds, and then
 * inserts every chunk into the KB's partition — with no `(document_id,
 * chunk_index)` uniqueness on the partition to fall back on. So a second run of
 * the same job *adds* a second copy of every chunk: the document row reports N
 * chunks and the partition holds 2N, and every query over that KB is then
 * answered twice out of the same text. Two ordinary things produce that second
 * run — an attempt whose worker lost its lock (a blocked event loop, a killed
 * container) and was re-queued while the first was still working, and a crash
 * between the chunk commit and BullMQ's `moveToCompleted`.
 *
 * **Which of the two this module answers, and which the engine does.** A job
 * layer can only delete *before* the engine, and the engine's insert happens
 * minutes later, in a transaction of its own: a run that is still embedding
 * when that delete commits writes its chunks afterwards, so two live runs still
 * left 2N. The replace therefore belongs where the insert is, and that is where
 * it now is — `kb/ingest.ts` takes `pg_advisory_xact_lock(hashtext(documentId))`
 * and deletes the document's chunks (and the `embedding_keyword` links over
 * them, with the `kb_keyword.usage_count` those links are counted in) as the
 * first statements of the transaction it already opened. Two runs are
 * serialised on the document id and the second replaces the first, atomically.
 * It is the one behaviour-frozen file this round touches, additively, and it is
 * recorded in TASK-005.
 *
 * What is left here is what the engine has no way to know: that the work is
 * *already done* and the handler should not run at all, that the payload names
 * the KB its document is actually in, and the `document_keyword` rollup — a
 * table the chunk transaction does not write, rebuilt by the re-ingest's
 * keyword pass (`recomputeDocumentKeywords`). Nothing here deletes a row the
 * engine also deletes: one path per table, so there is nothing for two paths to
 * disagree about.
 */

import { eq } from "drizzle-orm";
import { createLogger } from "@actana/search-shared/log";
import { db } from "../db/client.ts";
import { documentKeyword } from "../db/schema.ts";
import { documentRow } from "./run.ts";

const logger = createLogger("jobs/ingest-idempotency");

/**
 * What runs before `kb.ingest.document`'s handler, and whether the handler runs
 * at all. Two branches:
 *
 *   * **The document is already `completed`.** The work is done. The handler
 *     does not run, and the announcement reads the same row under the same
 *     event id (see `documentEventId` in `run.ts`), so no second `document.ingested`
 *     goes out.
 *   * **Anything else.** Drop the `document_keyword` rollup a previous attempt
 *     of this job left behind, which the re-ingest's keyword pass rebuilds. The
 *     chunks and their keyword links are replaced inside the engine's own
 *     transaction, where a concurrent run cannot slip past the delete.
 */
export async function prepareIngestDocument(
  payload: Record<string, unknown>,
): Promise<{ skip: boolean }> {
  const documentId = typeof payload.documentId === "string" ? payload.documentId : undefined;
  const kbId = typeof payload.kbId === "string" ? payload.kbId : undefined;
  // No staged id is the pre-TASK-004 shape: `ingestDocument` generates one, so
  // there is nothing a previous attempt could have written under it.
  if (!documentId || !kbId) return { skip: false };

  const row = await documentRow(documentId);
  if (!row) return { skip: false };
  if (row.knowledgeBaseId !== kbId) {
    // The payload names a KB the document is not in. `announce` refuses the
    // same pair; refusing here too is what stops one client's payload
    // deleting rows from another client's partition.
    logger.warn("An ingest payload named a knowledge base its document is not in", {
      documentId,
      claimedKbId: kbId,
      actualKbId: row.knowledgeBaseId,
    });
    return { skip: false };
  }
  if (row.processingStatus === "completed") {
    logger.info("kb.ingest.document: the document is already completed; not re-ingesting", {
      documentId,
      kbId,
      chunkCount: row.chunkCount,
    });
    return { skip: true };
  }

  await clearDocumentKeywordRollup(documentId);
  return { skip: false };
}

/**
 * Drop a document's `document_keyword` rows.
 *
 * The rollup over the per-chunk `embedding_keyword` links, keyed by document
 * rather than by chunk — so the engine's replace, which works from the chunk
 * ids it removed, does not reach it. `recomputeDocumentKeywords` rebuilds it
 * after the re-ingest's keyword pass; until then a stale rollup would claim
 * chunk counts for chunks that no longer exist.
 *
 * `kb_keyword.usage_count` is not touched here: it counts *links*, the engine's
 * replace decrements it by the links it deletes, and a second decrement from
 * this side would take a keyword's count down twice for one re-run.
 */
export async function clearDocumentKeywordRollup(documentId: string): Promise<void> {
  const removed = await db
    .delete(documentKeyword)
    .where(eq(documentKeyword.documentId, documentId))
    .returning({ kbKeywordId: documentKeyword.kbKeywordId });
  if (removed.length > 0) {
    logger.info("kb.ingest.document: dropped a previous attempt's keyword rollup", {
      documentId,
      keywords: removed.length,
    });
  }
}
