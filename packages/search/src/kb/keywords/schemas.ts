/**
 * Shared Zod schemas for the KB keyword HTTP routes (T4.10).
 *
 * Centralised so route handlers, tests, and future SDK callers all
 * validate against one source of truth.
 */

import { z } from 'zod'

/** Job name used when enqueuing keyword extraction work onto the `knowledge` queue. */
export const KB_KEYWORDS_EXTRACT_JOB_NAME = 'kb-keywords-extract' as const

/** Body for `POST /api/knowledge/[id]/keywords`. */
export const CreateKbKeywordBodySchema = z.object({
  displayLabel: z.string().min(1, 'displayLabel is required').max(120),
})

/** Body for `PATCH /api/knowledge/[id]/keywords/[keywordId]`. */
export const RenameKbKeywordBodySchema = z
  .object({
    displayLabel: z.string().min(1).max(120).optional(),
    keyword: z.string().min(1).max(120).optional(),
  })
  .refine((v) => v.displayLabel !== undefined || v.keyword !== undefined, {
    message: 'At least one of displayLabel or keyword is required',
  })

/** Query string for `GET /api/knowledge/[id]/keywords`. */
export const ListKbKeywordsQuerySchema = z.object({
  q: z.string().trim().min(1).max(120).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
})

/** Body for `POST /api/knowledge/[id]/documents/[docId]/keywords`. */
export const AttachDocumentKeywordBodySchema = z.object({
  kbKeywordId: z.string().min(1),
  applyToAllChunks: z.literal(true),
})

/** Body for `POST /api/knowledge/[id]/chunks/[embeddingId]/keywords`. */
export const AttachChunkKeywordBodySchema = z
  .object({
    kbKeywordId: z.string().min(1).optional(),
    displayLabel: z.string().min(1).max(120).optional(),
  })
  .refine((v) => Boolean(v.kbKeywordId) !== Boolean(v.displayLabel), {
    message: 'Provide exactly one of kbKeywordId or displayLabel',
  })

/** Body for `DELETE /api/knowledge/[id]/keywords` (bulk). */
export const BulkDeleteKbKeywordsBodySchema = z.object({
  ids: z.array(z.string().min(1)).min(1, 'at least one id is required').max(500),
})

/** Body for `POST /api/knowledge/[id]/extract-keywords`. */
export const ExtractKeywordsBodySchema = z
  .object({
    scope: z.enum(['all', 'document']),
    documentId: z.string().min(1).optional(),
  })
  .refine((v) => v.scope !== 'document' || Boolean(v.documentId), {
    message: 'documentId is required when scope is "document"',
  })

export type CreateKbKeywordBody = z.infer<typeof CreateKbKeywordBodySchema>
export type RenameKbKeywordBody = z.infer<typeof RenameKbKeywordBodySchema>
export type AttachDocumentKeywordBody = z.infer<typeof AttachDocumentKeywordBodySchema>
export type AttachChunkKeywordBody = z.infer<typeof AttachChunkKeywordBodySchema>
export type BulkDeleteKbKeywordsBody = z.infer<typeof BulkDeleteKbKeywordsBodySchema>
export type ExtractKeywordsBody = z.infer<typeof ExtractKeywordsBodySchema>
