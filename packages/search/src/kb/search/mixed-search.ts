/**
 * Mixed keyword + semantic KB search (T6.3).
 *
 * Runs {@link keywordSearch} and {@link semanticSearch} in parallel, min-max
 * normalises each side's chunk scores to `[0,1]` within its result set, then
 * blends them by the configured weights. Missing-side scores default to 0.
 */

import { createLogger } from '@actana/search-shared/log'
import { type KeywordMatchMode, keywordSearch } from './keyword-search.ts'
import { semanticSearch } from './semantic-search.ts'

const logger = createLogger('kb/search/mixed')

/** Blend weights for {@link mixedSearch}. */
export interface MixedSearchWeights {
  semantic: number
  keyword: number
}

/** Arguments accepted by {@link mixedSearch}. */
export interface MixedSearchArgs {
  kbId: string
  query: string
  limit?: number
  weights?: MixedSearchWeights
  keywordMode?: KeywordMatchMode
  /**
   * Canonical-form keywords pre-extracted from the query. Threaded into
   * both the inner {@link keywordSearch} and {@link semanticSearch} calls
   * so each side scores against the LLM-derived vocabulary.
   */
  canonicals?: string[]
}

/** Per-chunk hit returned by {@link mixedSearch} with per-side breakdown. */
export interface MixedSearchChunkHit {
  embeddingId: string
  score: number
  semanticScore: number
  keywordScore: number
  matchedKeywords: string[]
  content?: string
  chunkIndex?: number
}

/** Per-document aggregate returned by {@link mixedSearch}. */
export interface MixedSearchHit {
  documentId: string
  score: number
  semanticScore: number
  keywordScore: number
  chunks: MixedSearchChunkHit[]
}

const DEFAULT_LIMIT = 20
const DEFAULT_WEIGHTS: MixedSearchWeights = { semantic: 0.5, keyword: 0.5 }

/** Run a blended keyword + semantic KB search. */
export async function mixedSearch(args: MixedSearchArgs): Promise<MixedSearchHit[]> {
  const {
    kbId,
    query,
    limit = DEFAULT_LIMIT,
    weights = DEFAULT_WEIGHTS,
    keywordMode = 'both',
    canonicals,
  } = args

  const [keywordHits, semanticHits] = await Promise.all([
    keywordSearch({ kbId, query, limit: limit * 2, mode: keywordMode, canonicals }),
    semanticSearch({ kbId, query, limit: limit * 2, canonicals }),
  ])

  /** embeddingId → side-specific score + matchedKeywords + chunk metadata. */
  type Side = {
    score: number
    documentId: string
    matchedKeywords: string[]
    content?: string
    chunkIndex?: number
  }
  const keywordByChunk = new Map<string, Side>()
  const semanticByChunk = new Map<string, Side>()

  for (const doc of keywordHits) {
    for (const c of doc.chunks) {
      keywordByChunk.set(c.embeddingId, {
        score: c.score,
        documentId: doc.documentId,
        matchedKeywords: c.matchedKeywords,
        content: c.content,
        chunkIndex: c.chunkIndex,
      })
    }
  }
  for (const doc of semanticHits) {
    for (const c of doc.chunks) {
      semanticByChunk.set(c.embeddingId, {
        score: c.score,
        documentId: doc.documentId,
        matchedKeywords: c.matchedKeywords,
        content: c.content,
        chunkIndex: c.chunkIndex,
      })
    }
  }

  const keywordNorm = buildNormaliser(keywordByChunk)
  const semanticNorm = buildNormaliser(semanticByChunk)

  const allChunkIds = new Set<string>([...keywordByChunk.keys(), ...semanticByChunk.keys()])

  const docAgg = new Map<string, MixedSearchHit>()

  for (const embeddingId of allChunkIds) {
    const k = keywordByChunk.get(embeddingId)
    const s = semanticByChunk.get(embeddingId)
    const documentId = k?.documentId ?? s?.documentId
    if (!documentId) continue

    const kNorm = k ? keywordNorm(k.score) : 0
    const sNorm = s ? semanticNorm(s.score) : 0
    const blended = sNorm * weights.semantic + kNorm * weights.keyword

    let doc = docAgg.get(documentId)
    if (!doc) {
      doc = {
        documentId,
        score: 0,
        semanticScore: 0,
        keywordScore: 0,
        chunks: [],
      }
      docAgg.set(documentId, doc)
    }
    doc.score += blended
    doc.semanticScore += sNorm
    doc.keywordScore += kNorm
    doc.chunks.push({
      embeddingId,
      score: blended,
      semanticScore: sNorm,
      keywordScore: kNorm,
      matchedKeywords: k?.matchedKeywords ?? [],
      content: k?.content ?? s?.content,
      chunkIndex: k?.chunkIndex ?? s?.chunkIndex,
    })
  }

  const hits = Array.from(docAgg.values())
    .map((hit) => ({
      ...hit,
      chunks: hit.chunks.sort((a, b) => b.score - a.score),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)

  logger.info('mixedSearch: ranked', {
    kbId,
    keywordHitCount: keywordHits.length,
    semanticHitCount: semanticHits.length,
    hitCount: hits.length,
    weights,
  })

  return hits
}

/** Build a min-max [0,1] normaliser closure for a side's chunk score map. */
function buildNormaliser(byChunk: Map<string, { score: number }>): (raw: number) => number {
  if (byChunk.size === 0) return () => 0
  const scores = Array.from(byChunk.values()).map((v) => v.score)
  const min = Math.min(...scores)
  const max = Math.max(...scores)
  const range = max - min
  if (range <= 0) return () => 1
  return (raw: number) => (raw - min) / range
}
