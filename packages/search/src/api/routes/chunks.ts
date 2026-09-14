/**
 * `/v1/kbs/:kbId/documents/:docId/chunks` — reading and editing what a document
 * became, and hanging keywords off one chunk by hand.
 *
 * Editing a chunk's `content` re-embeds it. That is the lifted behaviour and it
 * is not a flag: a chunk whose text and whose vector disagree is a chunk that
 * ranks for the wrong query, and there is no version of "edit but do not
 * re-embed" that is not that.
 */

import {
  AttachChunkKeywordRequestSchema,
  ListChunksQuerySchema,
  UpdateChunkRequestSchema,
} from "@actana/search/contracts";
import { generateShortId } from "@actana/search-shared/short-id";
import { and, eq } from "drizzle-orm";
import { db } from "../../db/client.ts";
import { kbKeyword } from "../../db/schema.ts";
import {
  attachKeywordToChunk,
  detachKeywordFromChunk,
  upsertKbKeyword,
} from "../../kb/keywords/index.ts";
import { deleteChunk, queryChunks, updateChunk } from "../../knowledge/chunks/service.ts";
import { badRequest, notFound, parseWith, queryOf, readJsonBody, route, sendJson } from "../http.ts";
import { requireChunk, requireDocument, requireKb } from "../ownership.ts";
import type { SearchRouter } from "../routes.ts";
import { chunkToWire, isoRequired } from "../serialize.ts";

const requestId = (): string => `rest-${generateShortId(8)}`;

const CHUNKS = "/v1/kbs/:kbId/documents/:docId/chunks";

export function registerChunkRoutes(router: SearchRouter): void {
  router.add(
    route("GET", CHUNKS, "read", async ({ res, client, url }, { kbId, docId }) => {
      await requireKb(client, kbId!);
      await requireDocument(kbId!, docId!);
      const query = parseWith(ListChunksQuerySchema, queryOf(url));
      const result = await queryChunks(docId!, query, requestId());
      sendJson(res, 200, {
        chunks: result.chunks.map(chunkToWire),
        pagination: result.pagination,
      });
    }),
  );

  router.add(
    route(
      "PATCH",
      `${CHUNKS}/:chunkId`,
      "write",
      async ({ req, res, client }, { kbId, docId, chunkId }) => {
        await requireKb(client, kbId!);
        await requireDocument(kbId!, docId!);
        await requireChunk(docId!, chunkId!);
        const body = parseWith(UpdateChunkRequestSchema, await readJsonBody(req));
        const updated = await updateChunk(chunkId!, body, requestId(), client!.id);
        sendJson(res, 200, chunkToWire(updated));
      },
    ),
  );

  router.add(
    route(
      "DELETE",
      `${CHUNKS}/:chunkId`,
      "write",
      async ({ res, client }, { kbId, docId, chunkId }) => {
        await requireKb(client, kbId!);
        await requireDocument(kbId!, docId!);
        await requireChunk(docId!, chunkId!);
        await deleteChunk(chunkId!, docId!, requestId());
        sendJson(res, 200, { id: chunkId, deleted: true });
      },
    ),
  );

  router.add(
    route(
      "PUT",
      `${CHUNKS}/:chunkId/keywords`,
      "write",
      async ({ req, res, client }, { kbId, docId, chunkId }) => {
        await requireKb(client, kbId!);
        await requireDocument(kbId!, docId!);
        await requireChunk(docId!, chunkId!);
        const body = parseWith(AttachChunkKeywordRequestSchema, await readJsonBody(req));

        const keyword = body.kbKeywordId
          ? await keywordById(kbId!, body.kbKeywordId)
          : await upsertKbKeyword({ kbId: kbId!, displayLabel: body.displayLabel! });
        if (!keyword) throw badRequest("that keyword could not be normalised to anything");

        const { inserted } = await attachKeywordToChunk({
          embeddingId: chunkId!,
          kbKeywordId: keyword.id,
          source: "manual",
        });
        sendJson(res, 200, {
          chunkId,
          keyword: {
            ...keyword,
            createdAt: isoRequired(keyword.createdAt),
            updatedAt: isoRequired(keyword.updatedAt),
          },
          attached: inserted,
        });
      },
    ),
  );

  router.add(
    route(
      "DELETE",
      `${CHUNKS}/:chunkId/keywords/:keywordId`,
      "write",
      async ({ res, client }, { kbId, docId, chunkId, keywordId }) => {
        await requireKb(client, kbId!);
        await requireDocument(kbId!, docId!);
        await requireChunk(docId!, chunkId!);
        await detachKeywordFromChunk({ embeddingId: chunkId!, kbKeywordId: keywordId! });
        sendJson(res, 200, { id: keywordId, deleted: true });
      },
    ),
  );
}

/**
 * A keyword row by id, but only this KB's.
 *
 * The service looks keywords up by canonical form rather than by id, so the id
 * path is a read of the same table with the KB pinned — which is also the check
 * that stops one KB's id from naming another's row.
 */
async function keywordById(kbId: string, id: string) {
  const [row] = await db
    .select()
    .from(kbKeyword)
    .where(and(eq(kbKeyword.id, id), eq(kbKeyword.knowledgeBaseId, kbId)))
    .limit(1);
  if (!row) throw notFound(`no keyword ${id} in ${kbId}`);
  return {
    id: row.id,
    knowledgeBaseId: row.knowledgeBaseId,
    keyword: row.keyword,
    displayLabel: row.displayLabel,
    usageCount: row.usageCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    createdByUserId: row.createdByUserId,
  };
}
