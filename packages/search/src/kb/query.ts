/**
 * KB v2 hybrid query.
 *
 * Auth lives at the route layer. This function takes no session/OTP context —
 * it accepts only the data parameters needed to score and rank chunks. The
 * SDK runtime route (`/api/apps/runtime/kb/query`) and Chunk D's agent-runtime
 * route are both responsible for authenticating the caller before invoking
 * `queryKb`.
 *
 * Scoring is a 50/50 hybrid by default: keyword-overlap (vocab terms shared
 * between the query and chunk) blended with cosine similarity over the
 * partition's HNSW index. `keywordWeight` ∈ [0,1] tunes the blend.
 *
 * Ranking is ANN-first: a candidate set is over-fetched with a bare
 * `ORDER BY embedding <=> vec LIMIT topK * CANDIDATE_OVERFETCH`, which lets
 * pgvector use the partition's HNSW index instead of distance-sorting the whole
 * partition. Only the ≈`candidateLimit` returned rows materialize a distance,
 * which the candidate CTE aliases and reuses downstream. The candidate set is
 * then re-ranked in JS by a min-max-normalized keyword+semantic blend and
 * trimmed to `topK`.
 *
 * Cluster routing is now an optional optimization that only kicks in for very
 * large KBs (>= `CLUSTER_PRUNE_MIN_CHUNKS`). Below that threshold the ANN
 * over-fetch runs across the whole KB so a relevant chunk in any cluster stays
 * retrievable — the HNSW index keeps the unpruned search cheap.
 */

import { db } from '../db/client.ts'
import { kbCluster, knowledgeBase, qualified } from '../db/schema.ts'
import { createLogger } from '@actana/search-shared/log'
import { eq, sql } from 'drizzle-orm'
import { cosineDistance } from './clustering.ts'
import { kbPartitionRef } from './partition.ts'
import { resolveKbEmbeddingEndpoint } from './provider-context.ts'
import { executeWorkspaceEmbedding } from '../models/embedding.ts'

const logger = createLogger('kb/query')

const COLD_START_MIN_CHUNKS = 50
const DEFAULT_TOP_K = 5
const DEFAULT_KEYWORD_WEIGHT = 0.5
const DEFAULT_NEIGHBOR_CLUSTERS = 2

/**
 * How many candidate chunks to over-fetch from the ANN index per requested
 * result. The candidate CTE pulls `topK * CANDIDATE_OVERFETCH` rows ordered by
 * bare cosine distance (HNSW-usable), then JS re-ranks them by the blended
 * score. A larger factor improves recall of keyword-strong-but-semantically-
 * weaker chunks at the cost of a wider candidate window.
 */
const CANDIDATE_OVERFETCH = 8

/**
 * Cluster pruning is only worthwhile once a KB is large enough that scanning
 * the whole HNSW graph becomes expensive. Below this chunk count the ANN
 * over-fetch runs across the entire KB (no `cluster_id` filter) so matches in
 * any cluster remain reachable. Above it we additionally restrict the ANN
 * candidate set to the query's nearest clusters as an optimization.
 */
const CLUSTER_PRUNE_MIN_CHUNKS = 50_000

export interface TokenUsage {
  promptTokens: number
  totalTokens: number
}

export interface QueryKbArgs {
  kbId: string
  text: string
  topK?: number
  keywordWeight?: number
  neighborClusters?: number
  filter?: Record<string, unknown>
  minScore?: number
  includeContent?: boolean
  signal?: AbortSignal
  includeDiagnostics?: boolean
  /**
   * Canonical-form keywords derived from the query (see
   * `extractKeywordsForQuery`). Drives the keyword-score side of the
   * hybrid blend; when empty the query falls back to semantic-only.
   */
  queryKeywordCanonicals?: string[]
}

export interface QueryKbMatch {
  id: string
  documentId: string
  chunkIndex: number
  content: string | null
  metadata: Record<string, unknown>
  score: number
  semanticScore: number
  keywordScore: number
}

export interface QueryKbResult {
  matches: QueryKbMatch[]
  usage?: { embed: TokenUsage; keywords: TokenUsage }
  diagnostics?: { candidateClusterIds: number[] | null; queryKeywords: string[] }
}

interface KbClusterRow {
  clusterId: number
  centroid: number[]
}

/** Run a hybrid keyword+semantic query against a KB partition. */
export async function queryKb(args: QueryKbArgs): Promise<QueryKbResult> {
  const {
    kbId,
    text,
    topK = DEFAULT_TOP_K,
    keywordWeight: rawKeywordWeight = DEFAULT_KEYWORD_WEIGHT,
    neighborClusters = DEFAULT_NEIGHBOR_CLUSTERS,
    minScore,
    includeContent = true,
    includeDiagnostics = false,
    queryKeywordCanonicals = [],
  } = args
  /**
   * Suppress the keyword side when no canonical keywords were provided;
   * otherwise the JOIN evaluates against an empty set and contributes a
   * spurious zero that drags blended scores down.
   */
  const effectiveKeywordWeight =
    queryKeywordCanonicals.length === 0 ? 0 : Math.min(1, Math.max(0, rawKeywordWeight))
  const keywordWeight = effectiveKeywordWeight

  const [kb] = await db.select().from(knowledgeBase).where(eq(knowledgeBase.id, kbId)).limit(1)
  if (!kb) throw new Error(`queryKb: knowledge base not found: ${kbId}`)
  if (!kb.embeddingEndpointId) {
    throw new Error(`queryKb: KB has no embedding endpoint configured`)
  }

  const embeddingEndpoint = await resolveKbEmbeddingEndpoint(kb.embeddingEndpointId)

  const queryKeywords = queryKeywordCanonicals
  const embRes = await executeWorkspaceEmbedding({
    endpoint: embeddingEndpoint,
    input: text,
  })
  const queryVec = embRes.embeddings[0]
  if (!Array.isArray(queryVec) || queryVec.length === 0) {
    throw new Error('queryKb: embedding provider returned no vector for the query text')
  }

  // lifted: `kbPartitionName` -> `kbPartitionRef`, which returns the qualified
  // `"search"."<table>"` identifier. The SQL below is otherwise byte-identical;
  // only the identifier token changed. See `kb/partition.ts` for why a bare name
  // is dangerous on a database shared with Studio.
  const partitionTable = kbPartitionRef(kbId)

  const clusterRowsRaw = await db
    .select({ clusterId: kbCluster.clusterId, centroid: kbCluster.centroid })
    .from(kbCluster)
    .where(eq(kbCluster.kbId, kbId))
  const clusters: KbClusterRow[] = clusterRowsRaw.map((r) => ({
    clusterId: r.clusterId,
    centroid: r.centroid as number[],
  }))

  const totalExistingResult = (await db.execute(
    sql.raw(`SELECT count(*)::int AS c FROM ${partitionTable}`)
  )) as { rows?: Array<{ c: number }> } | Array<{ c: number }>
  const totalRows = Array.isArray(totalExistingResult)
    ? totalExistingResult
    : (totalExistingResult.rows ?? [])
  const totalExisting = Number(totalRows[0]?.c ?? 0)

  /**
   * Cluster routing is only applied as an optimization for very large KBs.
   * Below `CLUSTER_PRUNE_MIN_CHUNKS` the ANN over-fetch runs unpruned across
   * the whole KB, guaranteeing recall of matches in non-routed clusters.
   */
  let candidateClusterIds: number[] | null = null
  if (clusters.length > 0 && totalExisting >= CLUSTER_PRUNE_MIN_CHUNKS) {
    const ranked = clusters
      .map((c) => ({ clusterId: c.clusterId, d: cosineDistance(queryVec, c.centroid) }))
      .sort((a, b) => a.d - b.d)
    const slice = ranked.slice(0, Math.max(1, neighborClusters + 1))
    candidateClusterIds = slice.map((r) => r.clusterId)
  }

  const queryVecLit = `[${queryVec.join(',')}]`

  const clusterFilter =
    candidateClusterIds && candidateClusterIds.length > 0
      ? sql`AND chunk.cluster_id = ANY(${sql.raw(`ARRAY[${candidateClusterIds.join(',')}]::int[]`)})`
      : sql``

  /**
   * Keyword score = fraction of query keywords that appear on this chunk's
   * `embedding_keyword` rows, in [0, 1]. The LATERAL join shortcircuits to
   * 0 when no query keywords were supplied (caller passed empty).
   */
  const hasQueryKeywords = queryKeywordCanonicals.length > 0
  const queryKeywordsArrayLit = hasQueryKeywords
    ? `ARRAY[${queryKeywordCanonicals.map((k) => sqlLiteralString(k)).join(',')}]::text[]`
    : `ARRAY[]::text[]`
  const queryKeywordDenom = Math.max(1, queryKeywordCanonicals.length)
  const keywordScoreExpr = hasQueryKeywords ? sql`COALESCE(kw.s, 0)` : sql`0::float`
  const keywordLateralJoin = hasQueryKeywords
    ? sql`
        LEFT JOIN LATERAL (
          SELECT COUNT(DISTINCT kk.id)::float / ${queryKeywordDenom}::float AS s
            FROM ${sql.raw(qualified('embedding_keyword'))} ek
            JOIN ${sql.raw(qualified('kb_keyword'))} kk ON kk.id = ek.kb_keyword_id
           WHERE ek.embedding_id = candidates.id
             AND kk.knowledge_base_id = ${kbId}
             AND kk.keyword = ANY(${sql.raw(queryKeywordsArrayLit)})
        ) kw ON true
      `
    : sql``

  /**
   * Over-fetch ANN candidates. The `candidates` CTE orders by the bare cosine
   * distance (`embedding <=> vec`) so pgvector uses the partition's HNSW index;
   * the `ORDER BY` must stay the bare expression for the index to engage, so the
   * distance also appears aliased as `cosine_distance` for reuse downstream.
   * Only the returned candidate rows (≈ `candidateLimit`) materialize a
   * distance — not the whole partition as the previous blended sort did. The
   * outer query reuses the alias for `semantic_score` and attaches the keyword
   * score; final blending/re-ranking happens in JS after normalization.
   */
  const candidateLimit = Math.max(topK, topK * CANDIDATE_OVERFETCH)
  const rawResult = (await db.execute(sql`
    WITH candidates AS (
      SELECT chunk.id AS id,
             chunk.document_id AS document_id,
             chunk.chunk_index AS chunk_index,
             chunk.content AS content,
             chunk.metadata AS metadata,
             (chunk.embedding <=> ${queryVecLit}::vector) AS cosine_distance
        FROM ${sql.raw(partitionTable)} chunk
        JOIN ${sql.raw(qualified('document'))} d ON d.id = chunk.document_id
       WHERE d.included_in_kb = true
         AND d.enabled = true
         ${clusterFilter}
       ORDER BY chunk.embedding <=> ${queryVecLit}::vector
       LIMIT ${candidateLimit}
    )
    SELECT candidates.id AS id,
           candidates.document_id AS document_id,
           candidates.chunk_index AS chunk_index,
           CASE WHEN ${includeContent} THEN candidates.content ELSE NULL END AS content,
           candidates.metadata AS metadata,
           (1 - candidates.cosine_distance) AS semantic_score,
           ${keywordScoreExpr} AS keyword_score
      FROM candidates
      ${keywordLateralJoin}
  `)) as
    | {
        rows?: Array<{
          id: string
          document_id: string
          chunk_index: number
          content: string | null
          metadata: unknown
          semantic_score: number | string
          keyword_score: number | string
        }>
      }
    | Array<{
        id: string
        document_id: string
        chunk_index: number
        content: string | null
        metadata: unknown
        semantic_score: number | string
        keyword_score: number | string
      }>
  const rows = Array.isArray(rawResult) ? rawResult : (rawResult.rows ?? [])

  /**
   * Raw candidate scores. `semantic_score` (1 - cosine_distance) can fall
   * outside [0, 1] for cosine distances > 1; `keyword_score` is a coarse
   * matched/total fraction. They live on incompatible scales, so both are
   * min-max normalized across the candidate set before blending.
   */
  interface CandidateScore {
    id: string
    documentId: string
    chunkIndex: number
    content: string | null
    metadata: Record<string, unknown>
    semanticScore: number
    keywordScore: number
  }
  const candidates: CandidateScore[] = rows.map((row) => ({
    id: row.id,
    documentId: row.document_id,
    chunkIndex: row.chunk_index,
    content: row.content,
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    semanticScore: Number(row.semantic_score),
    keywordScore: Number(row.keyword_score),
  }))

  /**
   * Min-max normalize a column across the candidate set onto [0, 1]. When all
   * values are equal (range 0) every row maps to 1 — a constant column carries
   * no ranking signal, so it neither helps nor hurts the blend.
   */
  const normalizeColumn = (values: number[]): number[] => {
    let min = Number.POSITIVE_INFINITY
    let max = Number.NEGATIVE_INFINITY
    for (const v of values) {
      if (v < min) min = v
      if (v > max) max = v
    }
    const range = max - min
    if (!Number.isFinite(range) || range === 0) return values.map(() => 1)
    return values.map((v) => (v - min) / range)
  }

  const normSemantic = normalizeColumn(candidates.map((c) => c.semanticScore))
  const normKeyword = normalizeColumn(candidates.map((c) => c.keywordScore))

  /**
   * Blend the normalized scores. `minScore`, when provided, is applied on this
   * normalized [0, 1] scale (not the raw semantic/keyword scales). When
   * `keywordWeight` is 0 (the no-canonicals case) the keyword side drops out
   * cleanly and the blend is pure normalized semantic.
   */
  let matches: QueryKbMatch[] = candidates
    .map((c, i) => ({
      id: c.id,
      documentId: c.documentId,
      chunkIndex: c.chunkIndex,
      content: c.content,
      metadata: c.metadata,
      score: keywordWeight * normKeyword[i] + (1 - keywordWeight) * normSemantic[i],
      semanticScore: c.semanticScore,
      keywordScore: c.keywordScore,
    }))
    .sort((a, b) => b.score - a.score)

  if (typeof minScore === 'number') {
    matches = matches.filter((m) => m.score >= minScore)
  }

  matches = matches.slice(0, topK)

  logger.info('queryKb: ranked', {
    kbId,
    matchCount: matches.length,
    candidateClusterIds,
    queryKeywords,
  })

  const wantDiagnostics =
    includeDiagnostics || process.env.KB_QUERY_DIAGNOSTICS === '1' || queryKeywords.length > 0

  const result: QueryKbResult = {
    matches,
    usage: {
      embed: {
        promptTokens: embRes.usage?.promptTokens ?? 0,
        totalTokens: embRes.usage?.totalTokens ?? 0,
      },
      keywords: { promptTokens: 0, totalTokens: 0 },
    },
  }
  if (wantDiagnostics) {
    result.diagnostics = { candidateClusterIds, queryKeywords }
  }
  return result
}

/**
 * Escape a string for inclusion as a Postgres text literal. Used by the
 * inline `ARRAY[...]::text[]` builder above — `sql.raw` requires a
 * literal string, and query keywords come from the LLM so we can't trust
 * them to be quote-free. Mirrors `pg_quote_literal`.
 */
function sqlLiteralString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/**
 * Compute the nearest cluster ids for a query against a KB's stored
 * centroids. Returns `null` when clustering hasn't kicked in yet
 * (cold-start or no centroids). Used by the route to surface
 * "your query landed in cluster X" diagnostics without rerunning the
 * full `queryKb` SQL.
 *
 * This is diagnostics-only: `queryKb` no longer prunes the read path to these
 * clusters below `CLUSTER_PRUNE_MIN_CHUNKS`, so this routing result describes
 * the query's nearest centroids but does not bound what `queryKb` returns.
 */
export async function findNearestQueryClusters(
  kbId: string,
  text: string,
  neighborClusters: number = DEFAULT_NEIGHBOR_CLUSTERS
): Promise<{ nearestClusterIds: number[] | null }> {
  const [kb] = await db.select().from(knowledgeBase).where(eq(knowledgeBase.id, kbId)).limit(1)
  if (!kb || !kb.embeddingEndpointId) return { nearestClusterIds: null }

  const partitionTable = kbPartitionRef(kbId)
  const totalRowsResult = (await db.execute(
    sql.raw(`SELECT count(*)::int AS c FROM ${partitionTable}`)
  )) as { rows?: Array<{ c: number }> } | Array<{ c: number }>
  const totalRows = Array.isArray(totalRowsResult) ? totalRowsResult : (totalRowsResult.rows ?? [])
  const totalExisting = Number(totalRows[0]?.c ?? 0)
  if (totalExisting < COLD_START_MIN_CHUNKS) return { nearestClusterIds: null }

  const clusterRowsRaw = await db
    .select({ clusterId: kbCluster.clusterId, centroid: kbCluster.centroid })
    .from(kbCluster)
    .where(eq(kbCluster.kbId, kbId))
  if (clusterRowsRaw.length === 0) return { nearestClusterIds: null }

  const embeddingEndpoint = await resolveKbEmbeddingEndpoint(kb.embeddingEndpointId)
  const embRes = await executeWorkspaceEmbedding({ endpoint: embeddingEndpoint, input: text })
  const queryVec = embRes.embeddings[0]
  if (!Array.isArray(queryVec) || queryVec.length === 0) {
    throw new Error(
      'findNearestQueryClusters: embedding provider returned no vector for the query text'
    )
  }

  const ranked = clusterRowsRaw
    .map((c) => ({
      clusterId: c.clusterId,
      d: cosineDistance(queryVec, c.centroid as number[]),
    }))
    .sort((a, b) => a.d - b.d)
  const slice = ranked.slice(0, Math.max(1, neighborClusters + 1))
  return { nearestClusterIds: slice.map((r) => r.clusterId) }
}
