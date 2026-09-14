/**
 * Keyword-based KB chunk search (T6.1).
 *
 * Tokenizes the user query by whitespace, canonicalizes each token via
 * {@link normalizeKeyword}, then matches against `kb_keyword.keyword` either
 * exactly, by prefix, or both. Scoring is plain frequency-based — a chunk
 * matched by two keywords scores higher than one matched by a single keyword.
 * No IDF, no embeddings.
 */

import { db } from '../../db/client.ts'
import { document, embedding, embeddingKeyword, kbKeyword } from '../../db/schema.ts'
import { createLogger } from '@actana/search-shared/log'
import { and, eq, inArray, or, sql } from 'drizzle-orm'
import { normalizeKeyword } from '../keywords/normalize.ts'

const logger = createLogger('kb/search/keyword')

/** Match mode for keyword lookup against `kb_keyword.keyword`. */
export type KeywordMatchMode = 'exact' | 'prefix' | 'both'

/** Arguments accepted by {@link keywordSearch}. */
export interface KeywordSearchArgs {
  kbId: string
  query: string
  limit?: number
  mode?: KeywordMatchMode
  /**
   * Canonical-form keywords pre-extracted from the query (e.g. via
   * `extractKeywordsForQuery`). When provided, replaces the default
   * whitespace tokenisation so the keyword side scores against the same
   * vocabulary that was used at ingest time.
   */
  canonicals?: string[]
}

/** Per-chunk hit returned by keyword/semantic/mixed search. */
export interface KeywordSearchChunkHit {
  embeddingId: string
  score: number
  matchedKeywords: string[]
  content?: string
  chunkIndex?: number
}

/** Per-document aggregate returned by keyword search. */
export interface KeywordSearchHit {
  documentId: string
  score: number
  chunks: KeywordSearchChunkHit[]
}

const DEFAULT_LIMIT = 20
const EXACT_SCORE = 1.0
const PREFIX_SCORE = 0.6

/** Run a frequency-based keyword search against a KB. */
export async function keywordSearch(args: KeywordSearchArgs): Promise<KeywordSearchHit[]> {
  const { kbId, query, limit = DEFAULT_LIMIT, mode = 'both', canonicals } = args

  const tokens =
    canonicals && canonicals.length > 0
      ? canonicals.filter((c) => typeof c === 'string' && c.length > 0)
      : tokenizeQuery(query)
  if (tokens.length === 0) return []

  /** Track canonical → display so we can return readable matchedKeywords. */
  const exactCanonicals = new Set<string>()
  const prefixCanonicals = new Set<string>()

  const exactClauses: ReturnType<typeof eq>[] = []
  const prefixClauses: ReturnType<typeof sql>[] = []

  for (const canonical of tokens) {
    if (mode === 'exact' || mode === 'both') {
      exactCanonicals.add(canonical)
      exactClauses.push(eq(kbKeyword.keyword, canonical))
    }
    if (mode === 'prefix' || mode === 'both') {
      prefixCanonicals.add(canonical)
      prefixClauses.push(sql`${kbKeyword.keyword} LIKE ${canonical + '%'}`)
    }
  }

  const conditions = [...exactClauses, ...prefixClauses]
  if (conditions.length === 0) return []

  const matchedKeywordRows = await db
    .select({
      id: kbKeyword.id,
      keyword: kbKeyword.keyword,
      displayLabel: kbKeyword.displayLabel,
    })
    .from(kbKeyword)
    .where(and(eq(kbKeyword.knowledgeBaseId, kbId), or(...conditions)))

  if (matchedKeywordRows.length === 0) return []

  /** Classify each kb_keyword row as exact/prefix relative to the query tokens. */
  const keywordMeta = new Map<string, { displayLabel: string; type: 'exact' | 'prefix' }>()
  for (const row of matchedKeywordRows) {
    const isExact = exactCanonicals.has(row.keyword)
    keywordMeta.set(row.id, {
      displayLabel: row.displayLabel,
      type: isExact ? 'exact' : 'prefix',
    })
  }

  const kbKeywordIds = Array.from(keywordMeta.keys())

  /**
   * Mirror the `included_in_kb` + `enabled` filters used by the semantic
   * path in `queryKb` so both modes operate on the same eligibility set.
   * Without this the keyword side surfaced docs that semantic explicitly
   * excludes, producing keyword-only hits in mixed mode.
   */
  const chunkRows = await db
    .select({
      embeddingId: embedding.id,
      documentId: embedding.documentId,
      content: embedding.content,
      chunkIndex: embedding.chunkIndex,
      kbKeywordId: embeddingKeyword.kbKeywordId,
    })
    .from(embeddingKeyword)
    .innerJoin(embedding, eq(embedding.id, embeddingKeyword.embeddingId))
    .innerJoin(document, eq(document.id, embedding.documentId))
    .where(
      and(
        inArray(embeddingKeyword.kbKeywordId, kbKeywordIds),
        eq(embedding.enabled, true),
        eq(document.includedInKb, true),
        eq(document.enabled, true)
      )
    )

  /** chunkId → { documentId, content, chunkIndex, score, matchedKeywords[] } */
  const chunkAgg = new Map<
    string,
    {
      documentId: string
      content: string
      chunkIndex: number
      score: number
      matchedKeywords: Set<string>
    }
  >()

  for (const row of chunkRows) {
    const meta = keywordMeta.get(row.kbKeywordId)
    if (!meta) continue
    const delta = meta.type === 'exact' ? EXACT_SCORE : PREFIX_SCORE
    let entry = chunkAgg.get(row.embeddingId)
    if (!entry) {
      entry = {
        documentId: row.documentId,
        content: row.content,
        chunkIndex: row.chunkIndex,
        score: 0,
        matchedKeywords: new Set(),
      }
      chunkAgg.set(row.embeddingId, entry)
    }
    entry.score += delta
    entry.matchedKeywords.add(meta.displayLabel)
  }

  /** documentId → aggregate hit */
  const docAgg = new Map<string, KeywordSearchHit>()
  for (const [embeddingId, entry] of chunkAgg) {
    let doc = docAgg.get(entry.documentId)
    if (!doc) {
      doc = { documentId: entry.documentId, score: 0, chunks: [] }
      docAgg.set(entry.documentId, doc)
    }
    doc.score += entry.score
    doc.chunks.push({
      embeddingId,
      score: entry.score,
      matchedKeywords: Array.from(entry.matchedKeywords),
      content: entry.content,
      chunkIndex: entry.chunkIndex,
    })
  }

  const hits = Array.from(docAgg.values())
    .map((hit) => ({
      ...hit,
      chunks: hit.chunks.sort((a, b) => b.score - a.score),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)

  logger.info('keywordSearch: ranked', {
    kbId,
    tokenCount: tokens.length,
    matchedKeywordCount: matchedKeywordRows.length,
    hitCount: hits.length,
  })

  return hits
}

/** Tokenize on whitespace and canonicalize via the shared normalize helper. */
function tokenizeQuery(query: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of query.split(/\s+/)) {
    if (!raw) continue
    const norm = normalizeKeyword(raw)
    if (!norm) continue
    if (seen.has(norm.canonical)) continue
    seen.add(norm.canonical)
    out.push(norm.canonical)
  }
  return out
}
