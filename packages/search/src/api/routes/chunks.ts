/**
 * `/v1/kbs/:kbId/documents/:docId/chunks` — reading and editing what a document
 * became, and hanging keywords off one chunk by hand.
 *
 * Editing a chunk's `content` re-embeds it. That is the lifted behaviour and it
 * is not a flag: a chunk whose text and whose vector disagree is a chunk that
 * ranks for the wrong query, and there is no version of "edit but do not
 * re-embed" that is not that.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  AttachChunkKeywordRequestSchema,
  CreateChunkRequestSchema,
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
import {
  createChunk,
  deleteChunk,
  queryChunks,
  updateChunk,
} from "../../knowledge/chunks/service.ts";
import type { ChunkData } from "../../knowledge/chunks/types.ts";
import { badRequest, notFound, parseWith, queryOf, readJsonBody, route, sendJson } from "../http.ts";
import {
  requireChunk,
  requireChunkInKb,
  requireDocument,
  requireKb,
  type ChunkRow,
  type DocumentRow,
} from "../ownership.ts";
import type { SearchRouter } from "../routes.ts";
import { chunkToWire, isoRequired } from "../serialize.ts";

const requestId = (): string => `rest-${generateShortId(8)}`;

const CHUNKS = "/v1/kbs/:kbId/documents/:docId/chunks";

/** The chunk-by-id family: what a caller holding only a chunk id can address. */
const BY_ID = "/v1/kbs/:kbId/chunks/:chunkId";

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
    /**
     * `POST …/documents/:docId/chunks` — one chunk, written by hand.
     *
     * The route's whole job is the two things the frozen `createChunk` will not
     * do for itself: prove the KB and the document are this caller's, and hand
     * it the document's **tag values**, which a manual chunk inherits (the
     * lifted signature takes them as an argument because Studio's route read
     * them off the row it had just authorised). Everything else — the embedding
     * call through the KB's own endpoint, the next `chunkIndex` taken inside a
     * transaction, the token count, the document's three counters — is the
     * engine's, unchanged (ADR 0005).
     */
    route("POST", CHUNKS, "write", async ({ req, res, client }, { kbId, docId }) => {
      await requireKb(client, kbId!);
      const doc = await requireDocument(kbId!, docId!);
      const body = parseWith(CreateChunkRequestSchema, await readJsonBody(req));
      let created;
      try {
        created = await createChunk(
          kbId!,
          docId!,
          tagValuesOf(doc),
          {
            content: body.content,
            ...(body.enabled === undefined ? {} : { enabled: body.enabled }),
          },
          requestId(),
          client!.id,
        );
      } catch (err) {
        refuseIfNoEmbeddingEndpoint(err, kbId!);
        if (err instanceof Error && /document not found/i.test(err.message)) {
          throw notFound(`no document ${docId} in ${kbId}`);
        }
        throw err;
      }
      sendJson(res, 201, chunkToWire(created));
    }),
  );

  router.add(
    /**
     * `GET /v1/kbs/:kbId/chunks/:chunkId` — a chunk by its own id.
     *
     * A chunk id is unique across the instance, so a caller holding one should
     * not have to hold its document id as well in order to read it — which is
     * exactly the position Studio's chunk surfaces are in (their input is
     * `{ knowledgeBaseId, chunkId }`). The KB in the path is the ownership
     * anchor, and the answer is the same `ChunkSchema` the document-addressed
     * listing returns, off the same row.
     */
    route("GET", BY_ID, "read", async ({ res, client }, { kbId, chunkId }) => {
      await requireKb(client, kbId!);
      sendJson(res, 200, chunkToWire(chunkRowToData(await requireChunkInKb(kbId!, chunkId!))));
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
        let updated;
        try {
          updated = await updateChunk(chunkId!, body, requestId(), client!.id);
        } catch (err) {
          /**
           * The same refusal the `POST` above makes, for the same reason: this
           * route **re-embeds** the content it is given, so a KB with no
           * embedding endpoint has nothing to do that with. Unmapped, the
           * engine's plain `Error` became a `500` on the one edit a caller
           * could have fixed itself — and the two routes that embed disagreed
           * about the same condition.
           */
          refuseIfNoEmbeddingEndpoint(err, kbId!);
          throw err;
        }
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
      async (ctx, { kbId, docId, chunkId }) => {
        await requireKb(ctx.client, kbId!);
        await requireDocument(kbId!, docId!);
        await requireChunk(docId!, chunkId!);
        await attachKeyword(ctx, kbId!, chunkId!);
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

  /**
   * The same attach and detach, addressed by the chunk id alone.
   *
   * **One handler, two addresses**, which is the point: a caller holding
   * `{ knowledgeBaseId, chunkId }` had nothing to send to the document-addressed
   * form and there was no chunk-by-id read to recover a document from, so the
   * whole manual-keyword surface refused on a wired workspace (TASK-009's
   * second round, contract change 10). The KB carries the ownership check here,
   * as it does on every route that names one.
   *
   * `PUT` **and** `POST`: the attach is create-or-return on a
   * `(chunk, keyword)` pair, so it is idempotent and `PUT` is what the contract
   * has always documented and what the document-addressed route serves — and
   * `POST` is what a caller writing "attach this keyword" reaches for, and what
   * Studio's own route is. One verb would have been tidier and the wrong one
   * would have been a `405` on a request that is unambiguous.
   */
  for (const method of ["PUT", "POST"]) {
    router.add(
      route(method, `${BY_ID}/keywords`, "write", async (ctx, { kbId, chunkId }) => {
        await requireKb(ctx.client, kbId!);
        await requireChunkInKb(kbId!, chunkId!);
        await attachKeyword(ctx, kbId!, chunkId!);
      }),
    );
  }

  router.add(
    route(
      "DELETE",
      `${BY_ID}/keywords/:keywordId`,
      "write",
      async ({ res, client }, { kbId, chunkId, keywordId }) => {
        await requireKb(client, kbId!);
        await requireChunkInKb(kbId!, chunkId!);
        await detachKeywordFromChunk({ embeddingId: chunkId!, kbKeywordId: keywordId! });
        sendJson(res, 200, { id: keywordId, deleted: true });
      },
    ),
  );
}

/**
 * "This KB has no embedding endpoint" as a `400`, on every route that embeds.
 *
 * The request is fine and the instance is fine; the knowledge base is not
 * configured, and the caller is the one who can configure it — so it is a
 * refusal with an instruction, not a `core-error`. Both routes that embed
 * (`POST …/chunks` and the re-embedding `PATCH`) go through here, because a
 * condition that two routes answer two ways is a condition a caller cannot
 * handle.
 *
 * **The sentence is the wire's own.** The engine's message ends "Set one in the
 * KB settings.", which is Studio's UI telling a person where to click; there is
 * no KB settings page on this surface. What a paired client needs is the two
 * calls that fix it, so that is what it is told.
 */
function refuseIfNoEmbeddingEndpoint(err: unknown, kbId: string): void {
  if (err instanceof Error && /no embedding endpoint configured/i.test(err.message)) {
    throw badRequest(
      `knowledge base ${kbId} has no embedding endpoint; declare one with ` +
        `PUT /v1/endpoints and set it on the knowledge base`,
    );
  }
}

/**
 * Attach a keyword to a chunk this caller has already been proved to own.
 *
 * The body's rule — exactly one of `kbKeywordId` and `displayLabel` — is the
 * contract's, and which of the two was sent decides whether an existing row is
 * looked up or the canonical one is created. Shared by both addressings so
 * that they cannot come to mean different things.
 */
async function attachKeyword(
  ctx: { req: IncomingMessage; res: ServerResponse },
  kbId: string,
  chunkId: string,
): Promise<void> {
  const body = parseWith(AttachChunkKeywordRequestSchema, await readJsonBody(ctx.req));

  const keyword = body.kbKeywordId
    ? await keywordById(kbId, body.kbKeywordId)
    : await upsertKbKeyword({ kbId, displayLabel: body.displayLabel! });
  if (!keyword) throw badRequest("that keyword could not be normalised to anything");

  const { inserted } = await attachKeywordToChunk({
    embeddingId: chunkId,
    kbKeywordId: keyword.id,
    source: "manual",
  });
  sendJson(ctx.res, 200, {
    chunkId,
    keyword: {
      ...keyword,
      createdAt: isoRequired(keyword.createdAt),
      updatedAt: isoRequired(keyword.updatedAt),
    },
    attached: inserted,
  });
}

/**
 * The seventeen tag values of a document row, as `createChunk` takes them.
 *
 * A manual chunk inherits its document's tags, and the frozen function is
 * handed them rather than reading them — so this is the read, in the route
 * that just authorised the row.
 */
function tagValuesOf(doc: DocumentRow): Record<string, string | number | boolean | Date | null> {
  return {
    tag1: doc.tag1,
    tag2: doc.tag2,
    tag3: doc.tag3,
    tag4: doc.tag4,
    tag5: doc.tag5,
    tag6: doc.tag6,
    tag7: doc.tag7,
    number1: doc.number1,
    number2: doc.number2,
    number3: doc.number3,
    number4: doc.number4,
    number5: doc.number5,
    date1: doc.date1,
    date2: doc.date2,
    boolean1: doc.boolean1,
    boolean2: doc.boolean2,
    boolean3: doc.boolean3,
  };
}

/** An `embedding` row as the `ChunkData` the wire serializer takes. */
function chunkRowToData(row: ChunkRow): ChunkData {
  return {
    id: row.id,
    chunkIndex: row.chunkIndex,
    content: row.content,
    contentLength: row.contentLength,
    tokenCount: row.tokenCount,
    enabled: row.enabled,
    startOffset: row.startOffset,
    endOffset: row.endOffset,
    tag1: row.tag1,
    tag2: row.tag2,
    tag3: row.tag3,
    tag4: row.tag4,
    tag5: row.tag5,
    tag6: row.tag6,
    tag7: row.tag7,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
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
