/**
 * `kb.ingest.document`, made safe to run twice.
 *
 * **Its own module, and not part of `jobs/run.ts`,** because it is the one
 * thing in the job layer that reaches into a KB's *partition*: the dispatch
 * table is a table, and a `DELETE` against a hashed table name wants to be
 * somewhere a reader can find it and a test can drive it on its own.
 *
 * **What goes wrong without it.** `kb/ingest.ts` chunks, embeds, and then
 * inserts every chunk into the KB's partition inside one transaction — with no
 * `completed` short-circuit, no delete of what it is about to replace, and no
 * `(document_id, chunk_index)` uniqueness on the partition to fall back on. So
 * a second run of the same job *adds* a second copy of every chunk: the
 * document row reports N chunks and the partition holds 2N, and every query
 * over that KB is then answered twice out of the same text. Two ordinary
 * things produce that second run — an attempt whose worker lost its lock (a
 * blocked event loop, a killed container) and was re-queued while the first
 * was still working, and a crash between the chunk commit and BullMQ's
 * `moveToCompleted`.
 *
 * **Why the delete is before the engine rather than inside it.** The engine is
 * behaviour-frozen (ADR 0005) and opens its own transaction, so there is no
 * transaction to join. The window between the delete and the insert is the
 * cost, and it is the right cost: worst case an interrupted re-run leaves the
 * document with *fewer* chunks than it claims, which the attempt after it
 * fixes, where the alternative leaves duplicates that nothing ever notices.
 */

import { eq, inArray, sql } from "drizzle-orm";
import { createLogger } from "@actana/search-shared/log";
import { db } from "../db/client.ts";
import { documentKeyword, embeddingKeyword } from "../db/schema.ts";
import { kbPartitionRef, partitionExists } from "../kb/partition.ts";
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
 *   * **Anything else.** Drop what a previous attempt of this job left in the
 *     partition, and the keyword links over those chunk ids, in one
 *     transaction. A first attempt deletes nothing, which costs one statement.
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

  await clearStagedChunks(kbId, documentId);
  return { skip: false };
}

/**
 * Remove a document's chunks from its KB's partition, and the keyword links
 * that hang off them.
 *
 * The pattern is the engine's own (`retryDocumentProcessing` in
 * `knowledge/documents/service.ts` does exactly this before a retry), including
 * the `partitionExists` guard: a KB whose partition has not been provisioned is
 * a `DELETE` against a relation that does not exist, which would fail the job
 * for the one document that has nothing to clean up.
 *
 * `embedding_keyword` is keyed by chunk id, and a chunk id from the partition
 * and one from `search.embedding` come out of the same generator — so the link
 * rows are deleted by the ids being removed rather than by assuming the two
 * stores can never share one. `document_keyword` is the rollup over those
 * links; `recomputeDocumentKeywords` rebuilds it after the re-ingest's
 * keyword pass.
 */
export async function clearStagedChunks(kbId: string, documentId: string): Promise<void> {
  const partition = kbPartitionRef(kbId);
  await db.transaction(async (tx) => {
    if (await partitionExists(kbId, tx)) {
      // The table name through `sql.raw` (it is an identifier, hashed from the
      // KB id by `kbPartitionRef`), the document id as a parameter. Never the
      // other way round.
      const removed = (await tx.execute(
        sql`DELETE FROM ${sql.raw(partition)} WHERE document_id = ${documentId} RETURNING id`,
      )) as { rows?: Array<{ id: string }> } | Array<{ id: string }>;
      const rows = Array.isArray(removed) ? removed : (removed.rows ?? []);
      if (rows.length > 0) {
        await tx.delete(embeddingKeyword).where(
          inArray(
            embeddingKeyword.embeddingId,
            rows.map((r) => r.id),
          ),
        );
        await tx.delete(documentKeyword).where(eq(documentKeyword.documentId, documentId));
        logger.info("kb.ingest.document: dropped a previous attempt's chunks before re-running", {
          documentId,
          kbId,
          chunks: rows.length,
        });
      }
    }
  });
}

