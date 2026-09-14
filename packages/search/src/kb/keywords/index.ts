/**
 * KB keyword module barrel. Imports go through here so the worker (T3)
 * and API routes (T4) don't need to know the internal file layout.
 */

export {
  type ExtractedKeyword,
  type ExtractKeywordsForChunkInput,
  extractKeywordsForChunk,
  KeywordInferenceFatalError,
} from './extract.ts'
export {
  type NormalizedKeyword,
  normalizeKeyword,
} from './normalize.ts'
export {
  type AttachChunkKeywordBody,
  AttachChunkKeywordBodySchema,
  type AttachDocumentKeywordBody,
  AttachDocumentKeywordBodySchema,
  type BulkDeleteKbKeywordsBody,
  BulkDeleteKbKeywordsBodySchema,
  type CreateKbKeywordBody,
  CreateKbKeywordBodySchema,
  type ExtractKeywordsBody,
  ExtractKeywordsBodySchema,
  KB_KEYWORDS_EXTRACT_JOB_NAME,
  ListKbKeywordsQuerySchema,
  type RenameKbKeywordBody,
  RenameKbKeywordBodySchema,
} from './schemas.ts'
export {
  attachKeywordToChunk,
  bumpUsageCount,
  detachKeywordFromChunk,
  type EmbeddingKeywordSource,
  getKbKeywordByCanonical,
  type KbKeywordRow,
  type ListKbKeywordsInput,
  listKbKeywords,
  recomputeDocumentKeywords,
  upsertKbKeyword,
} from './service.ts'
