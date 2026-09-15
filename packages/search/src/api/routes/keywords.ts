/**
 * `/v1/kbs/:kbId/keywords` — the curated vocabulary, and the job that fills it.
 *
 * A keyword is dedup'd on its canonical form, so `PUT` is create-or-return
 * rather than create-or-conflict: two callers asking for "Parental Leave" and
 * "parental-leave" are asking for the same row and both get it.
 */

import { and, eq } from "drizzle-orm";
import {
  ExtractKeywordsRequestSchema,
  ListKeywordsQuerySchema,
  PutKeywordRequestSchema,
} from "@actana/search/contracts";
import type { Keyword } from "@actana/search/contracts";
import { db } from "../../db/client.ts";
import { document, kbKeyword } from "../../db/schema.ts";
import { listKbKeywords, upsertKbKeyword, type KbKeywordRow } from "../../kb/keywords/index.ts";
import { getJobQueue } from "../../queue/index.ts";
import { badRequest, notFound, parseWith, queryOf, readJsonBody, route, sendJson } from "../http.ts";
import { requireDocument, requireKb } from "../ownership.ts";
import type { SearchRouter } from "../routes.ts";
import { isoRequired } from "../serialize.ts";

const keywordToWire = (row: KbKeywordRow): Keyword => ({
  id: row.id,
  knowledgeBaseId: row.knowledgeBaseId,
  keyword: row.keyword,
  displayLabel: row.displayLabel,
  usageCount: row.usageCount,
  createdAt: isoRequired(row.createdAt),
  updatedAt: isoRequired(row.updatedAt),
  createdByUserId: row.createdByUserId,
});

export function registerKeywordRoutes(router: SearchRouter): void {
  router.add(
    route("GET", "/v1/kbs/:kbId/keywords", "read", async ({ res, client, url }, { kbId }) => {
      await requireKb(client, kbId!);
      const query = parseWith(ListKeywordsQuerySchema, queryOf(url));
      const rows = await listKbKeywords({
        kbId: kbId!,
        ...(query.q === undefined ? {} : { prefix: query.q }),
        ...(query.limit === undefined ? {} : { limit: query.limit }),
        ...(query.sort === undefined ? {} : { sort: query.sort }),
      });
      sendJson(res, 200, { keywords: rows.map(keywordToWire) });
    }),
  );

  router.add(
    route("PUT", "/v1/kbs/:kbId/keywords", "write", async ({ req, res, client }, { kbId }) => {
      await requireKb(client, kbId!);
      const body = parseWith(PutKeywordRequestSchema, await readJsonBody(req));
      const row = await upsertKbKeyword({ kbId: kbId!, displayLabel: body.displayLabel });
      if (!row) {
        throw badRequest(`"${body.displayLabel}" does not normalise to a keyword`);
      }
      sendJson(res, 200, keywordToWire(row));
    }),
  );

  router.add(
    route(
      "DELETE",
      "/v1/kbs/:kbId/keywords/:keywordId",
      "write",
      async ({ res, client }, { kbId, keywordId }) => {
        await requireKb(client, kbId!);
        const deleted = await db
          .delete(kbKeyword)
          .where(and(eq(kbKeyword.id, keywordId!), eq(kbKeyword.knowledgeBaseId, kbId!)))
          .returning({ id: kbKeyword.id });
        if (deleted.length === 0) throw notFound(`no keyword ${keywordId} in ${kbId}`);
        sendJson(res, 200, { id: keywordId, deleted: true });
      },
    ),
  );

  router.add(
    route(
      "POST",
      "/v1/kbs/:kbId/extract-keywords",
      "write",
      async ({ req, res, client }, { kbId }) => {
        await requireKb(client, kbId!);
        const body = parseWith(ExtractKeywordsRequestSchema, await readJsonBody(req));

        /**
         * A named document has to be **in this knowledge base**.
         *
         * Without `requireDocument` the route took the id on trust, and the job
         * it enqueues carries `{ documentId, knowledgeBaseId }` — while the
         * announcement at the end of a job reads the document row and publishes
         * to *that row's* owner (`jobs/run.ts`). So any `documentId` was a way
         * to make a `document.ingested` appear on another client's event stream,
         * and to spend that client's inference endpoint doing it. `404` rather
         * than `403` for a document that is not this caller's (ADR 0009 D5),
         * which is what `requireDocument` answers.
         */
        const documents =
          body.scope === "document"
            ? [{ id: (await requireDocument(kbId!, body.documentId!)).id }]
            : await db
                .select({ id: document.id })
                .from(document)
                .where(
                  and(
                    eq(document.knowledgeBaseId, kbId!),
                    eq(document.includedInKb, true),
                    eq(document.processingStatus, "completed"),
                  ),
                );

        const queue = await getJobQueue();
        for (const doc of documents) {
          await queue.enqueue("kb-keywords-extract", {
            documentId: doc.id,
            knowledgeBaseId: kbId!,
          });
        }
        sendJson(res, 202, { documents: documents.length });
      },
    ),
  );
}
