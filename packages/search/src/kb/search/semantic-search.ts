/**
 * Semantic KB chunk search (T6.2).
 *
 * Thin wrapper around {@link queryKb} (the KB v2 hybrid query in
 * `apps/actana/lib/kb/query.ts`). Since β.1 stubbed `queryKb` to
 * semantic-only (keyword scoring path stubbed to 0), calling it with
 * `keywordWeight: 0` gives a pure semantic ranking. Per-chunk semantic
 * scores are then min-max normalised to `[0,1]` within the result set
 * and reshaped to match {@link KeywordSearchHit}.
 */

import { createLogger } from '@actana/search-shared/log'
import { queryKb } from '../query.ts'
import type { KeywordSearchChunkHit, KeywordSearchHit } from './keyword-search.ts'

const logger = createLogger('kb/search/semantic')

/** Arguments accepted by {@link semanticSearch}. */
export interface SemanticSearchArgs {
  kbId: string
  query: string
  limit?: number
  /**
   * Canonical-form keywords pre-extracted from the query. Forwarded to
   * {@link queryKb} so cluster routing diagnostics can be surfaced; the
   * score itself stays semantic-only because `keywordWeight` is 0.
   */
  canonicals?: string[]
}

const DEFAULT_LIMIT = 20

/** Run a semantic-only KB search, returning normalised `[0,1]` scores. */
export async function semanticSearch(args: SemanticSearchArgs): Promise<KeywordSearchHit[]> {
  const { kbId, query, limit = DEFAULT_LIMIT, canonicals } = args

  if (!query.trim()) return []

  const result = await queryKb({
    kbId,
    text: query,
    topK: limit,
    keywordWeight: 0,
    includeContent: true,
    queryKeywordCanonicals: canonicals,
  })

  if (result.matches.length === 0) return []

  const scores = result.matches.map((m) => m.semanticScore)
  const min = Math.min(...scores)
  const max = Math.max(...scores)
  const range = max - min

  const docAgg = new Map<string, KeywordSearchHit>()
  for (const match of result.matches) {
    const normalised = range > 0 ? (match.semanticScore - min) / range : 1
    const chunk: KeywordSearchChunkHit = {
      embeddingId: match.id,
      score: normalised,
      matchedKeywords: [],
      content: match.content ?? undefined,
      chunkIndex: match.chunkIndex,
    }
    let doc = docAgg.get(match.documentId)
    if (!doc) {
      doc = { documentId: match.documentId, score: 0, chunks: [] }
      docAgg.set(match.documentId, doc)
    }
    doc.score += normalised
    doc.chunks.push(chunk)
  }

  const hits = Array.from(docAgg.values())
    .map((hit) => ({
      ...hit,
      chunks: hit.chunks.sort((a, b) => b.score - a.score),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)

  logger.info('semanticSearch: ranked', {
    kbId,
    matchCount: result.matches.length,
    hitCount: hits.length,
  })

  return hits
}
