/**
 * Whose row is this?
 *
 * Two different questions guard a KB route and both have to be answered. The
 * router asks the first — *does this pairing's grant cover this KB id?* — from
 * the certificate's `kb_ids` allow-list, before the handler runs. This file
 * asks the second: *does the row exist, and does it belong to this paired
 * client?*
 *
 * **The answer to "not yours" is 404, not 403** (ADR 0009). A 403 on a row that
 * belongs to somebody else confirms that the row exists, which turns the id
 * space into something worth walking; a 404 says the same thing to a caller
 * with a right to know and nothing at all to a caller without one. The router's
 * 403 `kb-forbidden` is different and stays: there the caller was told at
 * pairing time exactly which KBs it may touch, so the refusal reveals nothing
 * it did not already hold.
 */

import { and, eq, isNull } from "drizzle-orm";
import type { PairedClient } from "@actana/search-shared/pairing/pairing-code-digest";
import { db } from "../db/client.ts";
import { document, embedding, knowledgeBase } from "../db/schema.ts";
import { notFound } from "./http.ts";

export type KbRow = typeof knowledgeBase.$inferSelect;
export type DocumentRow = typeof document.$inferSelect;

/**
 * The KB this route names, or a 404.
 *
 * A soft-deleted KB is gone as far as every route but the listing is concerned,
 * which is why `deleted_at IS NULL` is part of the identity rather than a
 * filter a caller can lift.
 */
export async function requireKb(client: PairedClient | null, kbId: string): Promise<KbRow> {
  if (!client) throw notFound(`no knowledge base ${kbId}`);
  const [row] = await db
    .select()
    .from(knowledgeBase)
    .where(
      and(
        eq(knowledgeBase.id, kbId),
        eq(knowledgeBase.pairedClientId, client.id),
        isNull(knowledgeBase.deletedAt),
      ),
    )
    .limit(1);
  if (!row) throw notFound(`no knowledge base ${kbId}`);
  return row;
}

/** The same, for a KB a caller may be about to un-archive. Includes deleted rows. */
export async function requireKbIncludingArchived(
  client: PairedClient | null,
  kbId: string,
): Promise<KbRow> {
  if (!client) throw notFound(`no knowledge base ${kbId}`);
  const [row] = await db
    .select()
    .from(knowledgeBase)
    .where(and(eq(knowledgeBase.id, kbId), eq(knowledgeBase.pairedClientId, client.id)))
    .limit(1);
  if (!row) throw notFound(`no knowledge base ${kbId}`);
  return row;
}

/**
 * The document this route names, inside the KB the caller already proved it
 * owns — so this is an existence check rather than a second ownership one.
 */
export async function requireDocument(kbId: string, documentId: string): Promise<DocumentRow> {
  const [row] = await db
    .select()
    .from(document)
    .where(
      and(
        eq(document.id, documentId),
        eq(document.knowledgeBaseId, kbId),
        isNull(document.deletedAt),
      ),
    )
    .limit(1);
  if (!row) throw notFound(`no document ${documentId} in ${kbId}`);
  return row;
}

/** The chunk this route names, in that document. */
export async function requireChunk(documentId: string, chunkId: string): Promise<{ id: string }> {
  const [row] = await db
    .select({ id: embedding.id })
    .from(embedding)
    .where(and(eq(embedding.id, chunkId), eq(embedding.documentId, documentId)))
    .limit(1);
  if (!row) throw notFound(`no chunk ${chunkId} in document ${documentId}`);
  return row;
}

/**
 * The `owner_id` to stamp on a row this client is creating.
 *
 * Search has no user table and will not grow one (ADR 0002): `owner_id` is
 * plain text with nothing behind it, and it exists so a row migrated out of
 * Studio keeps the user id it had. A client that has no such notion leaves it
 * out and the row is owned by the client itself.
 */
export function ownerIdFor(client: PairedClient | null, supplied?: string): string {
  return supplied ?? client?.id ?? "";
}
