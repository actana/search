/**
 * KB search barrel (T6).
 *
 * Public entry points for keyword-only, semantic-only, and mixed-mode
 * chunk search against a knowledge base.
 */

export {
  type KeywordMatchMode,
  type KeywordSearchArgs,
  type KeywordSearchChunkHit,
  type KeywordSearchHit,
  keywordSearch,
} from './keyword-search.ts'
export {
  type MixedSearchArgs,
  type MixedSearchChunkHit,
  type MixedSearchHit,
  type MixedSearchWeights,
  mixedSearch,
} from './mixed-search.ts'
export { type SemanticSearchArgs, semanticSearch } from './semantic-search.ts'
