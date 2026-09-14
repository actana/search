/**
 * Keyword DB service (T2.1).
 *
 * Pure DB helpers used by API routes (T4) and the extraction worker
 * (T3). All callers go through here so that `kb_keyword.usage_count` and
 * `document_keyword.chunk_count` stay in sync with the join rows.
 */

import { db } from '../../db/client.ts'
import { documentKeyword, embedding, embeddingKeyword, kbKeyword } from '../../db/schema.ts'
import { createLogger } from '@actana/search-shared/log'
import { and, asc, desc, eq, like, sql } from 'drizzle-orm'
import { generateId } from '@actana/search-shared/short-id'
import { normalizeKeyword } from './normalize.ts'

const logger = createLogger('kb/keywords/service')

/** Origin of an `embedding_keyword` join row. */
export type EmbeddingKeywordSource = 'llm' | 'manual'

/** A KB keyword row, shaped for app consumption. */
export interface KbKeywordRow {
  id: string
  knowledgeBaseId: string
  keyword: string
  displayLabel: string
  usageCount: number
  createdAt: Date
  updatedAt: Date
  createdByUserId: string | null
}

/** Input for {@link listKbKeywords}. */
export interface ListKbKeywordsInput {
  kbId: string
  /** Optional prefix filter on the canonical `keyword` column. */
  prefix?: string
  limit?: number
  sort?: 'usage_desc' | 'keyword_asc'
}

const DEFAULT_LIST_LIMIT = 100

/** List keyword rows for a KB. */
export async function listKbKeywords(input: ListKbKeywordsInput): Promise<KbKeywordRow[]> {
  const { kbId, prefix, limit = DEFAULT_LIST_LIMIT, sort = 'usage_desc' } = input
  const conds = [eq(kbKeyword.knowledgeBaseId, kbId)]
  if (prefix) {
    const norm = normalizeKeyword(prefix)
    if (norm) conds.push(like(kbKeyword.keyword, `${norm.canonical}%`))
  }
  const order = sort === 'keyword_asc' ? asc(kbKeyword.keyword) : desc(kbKeyword.usageCount)
  const rows = await db
    .select()
    .from(kbKeyword)
    .where(and(...conds))
    .orderBy(order)
    .limit(limit)
  return rows.map(mapKbKeywordRow)
}

/** Look up a single keyword by its canonical form. */
export async function getKbKeywordByCanonical(input: {
  kbId: string
  keyword: string
}): Promise<KbKeywordRow | null> {
  const norm = normalizeKeyword(input.keyword)
  if (!norm) return null
  const rows = await db
    .select()
    .from(kbKeyword)
    .where(and(eq(kbKeyword.knowledgeBaseId, input.kbId), eq(kbKeyword.keyword, norm.canonical)))
    .limit(1)
  return rows[0] ? mapKbKeywordRow(rows[0]) : null
}

/**
 * Upsert a KB keyword. Normalises the display label, dedups by canonical,
 * and returns the resulting row. Existing rows are returned unchanged.
 */
export async function upsertKbKeyword(input: {
  kbId: string
  displayLabel: string
  createdByUserId?: string | null
}): Promise<KbKeywordRow | null> {
  const norm = normalizeKeyword(input.displayLabel)
  if (!norm) return null

  const existing = await getKbKeywordByCanonical({ kbId: input.kbId, keyword: norm.canonical })
  if (existing) return existing

  const id = generateId()
  const now = new Date()
  await db
    .insert(kbKeyword)
    .values({
      id,
      knowledgeBaseId: input.kbId,
      keyword: norm.canonical,
      displayLabel: norm.display,
      usageCount: 0,
      createdAt: now,
      updatedAt: now,
      createdByUserId: input.createdByUserId ?? null,
    })
    .onConflictDoNothing()

  const reread = await getKbKeywordByCanonical({ kbId: input.kbId, keyword: norm.canonical })
  return reread
}

/**
 * Attach a keyword to an embedding chunk. Idempotent: if the join row
 * already exists, `usage_count` is NOT bumped.
 */
export async function attachKeywordToChunk(input: {
  embeddingId: string
  kbKeywordId: string
  source: EmbeddingKeywordSource
}): Promise<{ inserted: boolean }> {
  const result = await db
    .insert(embeddingKeyword)
    .values({
      embeddingId: input.embeddingId,
      kbKeywordId: input.kbKeywordId,
      source: input.source,
      createdAt: new Date(),
    })
    .onConflictDoNothing()
    .returning({ embeddingId: embeddingKeyword.embeddingId })
  const inserted = result.length > 0
  if (inserted) {
    await bumpUsageCount({ kbKeywordId: input.kbKeywordId, delta: 1 })
  }
  return { inserted }
}

/** Detach a keyword from a chunk. Decrements `usage_count` on actual removal. */
export async function detachKeywordFromChunk(input: {
  embeddingId: string
  kbKeywordId: string
}): Promise<{ removed: boolean }> {
  const result = await db
    .delete(embeddingKeyword)
    .where(
      and(
        eq(embeddingKeyword.embeddingId, input.embeddingId),
        eq(embeddingKeyword.kbKeywordId, input.kbKeywordId)
      )
    )
    .returning({ embeddingId: embeddingKeyword.embeddingId })
  const removed = result.length > 0
  if (removed) {
    await bumpUsageCount({ kbKeywordId: input.kbKeywordId, delta: -1 })
  }
  return { removed }
}

/**
 * Adjust `kb_keyword.usage_count` by `delta`. Clamps at 0 so we never go
 * negative even if a detach races a cascade delete.
 */
export async function bumpUsageCount(input: { kbKeywordId: string; delta: number }): Promise<void> {
  if (input.delta === 0) return
  await db
    .update(kbKeyword)
    .set({
      usageCount: sql`GREATEST(${kbKeyword.usageCount} + ${input.delta}, 0)`,
      updatedAt: new Date(),
    })
    .where(eq(kbKeyword.id, input.kbKeywordId))
}

/**
 * Re-aggregate `document_keyword` from `embedding_keyword` for a single
 * document. Considers only chunks where `embedding.enabled = true`. The
 * result replaces any prior rollup rows for the document.
 */
export async function recomputeDocumentKeywords(input: {
  documentId: string
}): Promise<{ rowCount: number }> {
  const { documentId } = input

  const rows = await db
    .select({
      kbKeywordId: embeddingKeyword.kbKeywordId,
      count: sql<number>`count(*)::int`,
    })
    .from(embeddingKeyword)
    .innerJoin(embedding, eq(embedding.id, embeddingKeyword.embeddingId))
    .where(and(eq(embedding.documentId, documentId), eq(embedding.enabled, true)))
    .groupBy(embeddingKeyword.kbKeywordId)

  await db.transaction(async (tx) => {
    await tx.delete(documentKeyword).where(eq(documentKeyword.documentId, documentId))
    if (rows.length === 0) return
    await tx.insert(documentKeyword).values(
      rows.map((r) => ({
        documentId,
        kbKeywordId: r.kbKeywordId,
        chunkCount: Number(r.count),
        updatedAt: new Date(),
      }))
    )
  })

  logger.info('recomputeDocumentKeywords: refreshed rollup', {
    documentId,
    rowCount: rows.length,
  })
  return { rowCount: rows.length }
}

function mapKbKeywordRow(row: typeof kbKeyword.$inferSelect): KbKeywordRow {
  return {
    id: row.id,
    knowledgeBaseId: row.knowledgeBaseId,
    keyword: row.keyword,
    displayLabel: row.displayLabel,
    usageCount: row.usageCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    createdByUserId: row.createdByUserId,
  }
}
