/**
 * The KB's curated keyword vocabulary.
 *
 * A keyword has a **canonical** form (lowercased, trimmed, one token or one
 * hyphenated pair) and a **display label** the caller chose. Dedup is on the
 * canonical form, which is why `PUT` takes a label and answers with the row
 * that ended up existing rather than the one it was asked to create.
 */

import { z } from "zod";
import { IsoDateTimeSchema } from "./common.ts";

export const KeywordSchema = z.object({
  id: z.string(),
  knowledgeBaseId: z.string(),
  /** Canonical lowercase form. The dedup key. */
  keyword: z.string(),
  /** Original-cased label, for a UI. */
  displayLabel: z.string(),
  /** Chunk links across the KB. Maintained by the service, not by a caller. */
  usageCount: z.number().int(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  createdByUserId: z.string().nullable(),
});
export type Keyword = z.infer<typeof KeywordSchema>;

export const ListKeywordsQuerySchema = z.object({
  /** Prefix filter on the canonical column. */
  q: z.string().trim().min(1).max(120).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  sort: z.enum(["usage_desc", "keyword_asc"]).optional(),
});
export type ListKeywordsQuery = z.infer<typeof ListKeywordsQuerySchema>;

export const ListKeywordsResponseSchema = z.object({
  keywords: z.array(KeywordSchema),
});
export type ListKeywordsResponse = z.infer<typeof ListKeywordsResponseSchema>;

/** `PUT /v1/kbs/:id/keywords` — create or return the existing canonical row. */
export const PutKeywordRequestSchema = z.object({
  displayLabel: z.string().min(1).max(120),
});
export type PutKeywordRequest = z.infer<typeof PutKeywordRequestSchema>;

export const DeleteKeywordResponseSchema = z.object({
  id: z.string(),
  deleted: z.literal(true),
});
export type DeleteKeywordResponse = z.infer<typeof DeleteKeywordResponseSchema>;

/**
 * `POST /v1/kbs/:id/extract-keywords` — run the inference extractor over the
 * whole KB or one document. Asynchronous: one `kb-keywords-extract` job per
 * document.
 */
export const ExtractKeywordsRequestSchema = z
  .object({
    scope: z.enum(["all", "document"]),
    documentId: z.string().min(1).optional(),
  })
  .refine((v) => v.scope !== "document" || Boolean(v.documentId), {
    message: "`documentId` is required when scope is \"document\"",
  });
export type ExtractKeywordsRequest = z.infer<typeof ExtractKeywordsRequestSchema>;

export const ExtractKeywordsResponseSchema = z.object({
  /** How many documents were handed to the extractor. */
  documents: z.number().int(),
});
export type ExtractKeywordsResponse = z.infer<typeof ExtractKeywordsResponseSchema>;

/**
 * Attach a keyword to one chunk by hand. Exactly one of `kbKeywordId` (an
 * existing row) and `displayLabel` (create-or-reuse), which is the lifted
 * route's own rule.
 *
 * **Two addresses for one chunk, and both are served.**
 *
 *   - `PUT|POST /v1/kbs/:kbId/chunks/:chunkId/keywords`, and
 *     `DELETE /v1/kbs/:kbId/chunks/:chunkId/keywords/:keywordId` — the chunk by
 *     its own id, which is what this docstring promised before either existed.
 *     A chunk id is unique across the instance and the KB in the path is what
 *     makes it *this* caller's chunk, so the document segment identified
 *     nothing extra. It is also the only shape some callers can send: Studio's
 *     manual keyword overlay is
 *     `POST /api/knowledge/[id]/chunks/[embeddingId]/keywords` and its
 *     `kb_admin` input is `{ knowledgeBaseId, chunkId }`, so against the
 *     document-addressed form alone it had no document id to put in the path
 *     and refused (TASK-009's second round, contract change 10).
 *   - `PUT /v1/kbs/:kbId/documents/:docId/chunks/:chunkId/keywords`, and its
 *     `DELETE` — the same thing under the document. Kept: it is what shipped,
 *     and it is what a caller walking a document's chunks already writes.
 *
 * The document-addressed form additionally asserts that the chunk is in *that*
 * document; the chunk-addressed form asserts that it is in the KB. Otherwise
 * they are one handler with one behaviour.
 */
export const AttachChunkKeywordRequestSchema = z
  .object({
    kbKeywordId: z.string().min(1).optional(),
    displayLabel: z.string().min(1).max(120).optional(),
  })
  .refine((v) => Boolean(v.kbKeywordId) !== Boolean(v.displayLabel), {
    message: "provide exactly one of `kbKeywordId` or `displayLabel`",
  });
export type AttachChunkKeywordRequest = z.infer<typeof AttachChunkKeywordRequestSchema>;

export const ChunkKeywordResponseSchema = z.object({
  chunkId: z.string(),
  keyword: KeywordSchema,
  attached: z.boolean(),
});
export type ChunkKeywordResponse = z.infer<typeof ChunkKeywordResponseSchema>;
