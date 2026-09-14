/**
 * KB v2 ingestion fan-out: plan → embed-batch → finalize.
 *
 * Replaces the monolithic, all-or-nothing document embedding loop (still kept
 * as the inline fallback in {@link ./service.ts} for the non-BullMQ backend)
 * with a resumable BullMQ flow:
 *
 * 1. {@link planDocumentEmbedding} (runs as the `knowledge-process-document`
 *    worker job): parse + chunk the document, stage every chunk as an
 *    `embedding` row with a NULL vector, provision the KB partition once
 *    (serial — `CREATE TABLE IF NOT EXISTS` is not concurrency-safe), write the
 *    `document_embed_batch` ledger, then create a flow whose children are the
 *    embed batches and whose parent is the finalize step.
 * 2. {@link processEmbedBatch} (`kb.embed.batch`): embed only the rows in its
 *    chunk range whose vector is still NULL, then upsert vectors into both the
 *    `embedding` table and the per-KB partition. Idempotent and resumable —
 *    BullMQ retries (queue default `attempts: 3`) re-run only the missing work.
 * 3. {@link finalizeDocumentEmbedding} (`kb.embed.finalize`): runs after all
 *    batches settle (children use `ignoreDependencyOnFailure`, so it runs even
 *    when a batch exhausted its retries). If no chunk is left unembedded the
 *    document completes and keyword extraction is enqueued as its own
 *    keyword-aware job; otherwise the document fails with a per-batch summary.
 *
 * The resume anchor is the `embedding` unique index `(document_id, chunk_index)`
 * plus the nullable vector column: "needs embedding" == `embedding IS NULL`.
 */

import crypto from 'crypto'
import { db } from '../../db/client.ts'
import {
  document,
  documentEmbedBatch,
  embedding,
  kbCluster,
  knowledgeBase,
} from '../../db/schema.ts'
import { createLogger } from '@actana/search-shared/log'
import { getFlowProducer, QUEUE_NAMES } from '../../queue/index.ts'
import { and, asc, eq, gte, isNull, lt, sql } from 'drizzle-orm'
import type { ChunkingStrategy, StrategyOptions } from '@actana/search-shared/chunkers/types'
import { getJobQueue } from '../../queue/index.ts'
import { env } from '../../config.ts'
import { generateId } from '@actana/search-shared/short-id'
import { assignCluster } from '../../kb/clustering.ts'
import { provisionKbPartition } from '../../kb/ddl.ts'
import { kbPartitionRef, partitionExists } from '../../kb/partition.ts'
import { resolveKbEmbeddingEndpoint } from '../../kb/provider-context.ts'
import { processDocument } from './document-processor.ts'
import { executeWorkspaceEmbedding } from '../../models/embedding.ts'
import type { DocumentProcessingPayload } from '../../jobs/types.ts'

const logger = createLogger('KbEmbedPipeline')

/**
 * Target number of chunks per `kb.embed.batch` job. This bounds a single job's
 * wall-clock and the blast radius of a retry; the embedding primitive
 * (`executeWorkspaceEmbedding`) further sub-batches each range by the provider's
 * token/item caps, so this is a job-granularity knob, not a provider limit.
 */
const TARGET_CHUNKS_PER_BATCH = Math.max(1, env.KB_CONFIG_EMBED_BATCH_CHUNKS || 256)

/** How many staged chunk rows to INSERT per statement during planning. */
const STAGE_INSERT_BATCH = 500

/** Minimum other-document rows in a partition before cluster routing kicks in. */
const COLD_START_MIN = 50

/** Per-child / parent job retry policy (FlowProducer does not inherit queue defaults). */
const FLOW_JOB_OPTS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 1000 },
} as const

/** Payload for a `kb.embed.batch` job. */
export interface EmbedBatchPayload {
  knowledgeBaseId: string
  documentId: string
  /** Inclusive lower chunk_index bound. */
  startIndex: number
  /** Exclusive upper chunk_index bound. */
  endIndex: number
  /** `document_embed_batch` row id this job owns. */
  batchId: string
  /** Embedding endpoint id this batch is routed to. */
  endpointId: string
}

/** Payload for a `kb.embed.finalize` job. */
export interface EmbedFinalizePayload {
  knowledgeBaseId: string
  documentId: string
  filename: string
}

/** Split `[0, total)` into contiguous `[start, end)` ranges of at most `perBatch`. */
export function computeBatchRanges(
  total: number,
  perBatch: number
): Array<{ startIndex: number; endIndex: number }> {
  const ranges: Array<{ startIndex: number; endIndex: number }> = []
  for (let start = 0; start < total; start += perBatch) {
    ranges.push({ startIndex: start, endIndex: Math.min(start + perBatch, total) })
  }
  return ranges
}

/**
 * Round-robin each range across the available embedding endpoints. The model
 * and dimension are constant for a document (a KB references a single embedding
 * model), so this only distributes load across interchangeable
 * instances/endpoints of that one model. With a single endpoint every range
 * gets the same id.
 */
export function assignEndpoints(rangeCount: number, endpointIds: string[]): string[] {
  const pool = endpointIds.length > 0 ? endpointIds : ['']
  return Array.from({ length: rangeCount }, (_, i) => pool[i % pool.length])
}

interface PartitionChunkRecord {
  id: string
  chunkIndex: number
  content: string
  embedding: number[]
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

/**
 * Write a batch's freshly-embedded chunks into the per-KB partition table.
 *
 * Deletes only this batch's chunk indices first (idempotent re-runs preserve
 * sibling batches), assigns a cluster when the KB is warm enough, then inserts
 * each row reusing the `embedding` row id so the two tables stay aligned.
 */
async function writePartitionChunks(
  tx: Tx,
  args: {
    kbId: string
    documentId: string
    /** The qualified `"search"."kb_embedding_<sha>"` identifier — see `kb/partition.ts`. */
    partitionTable: string
    records: PartitionChunkRecord[]
  }
): Promise<void> {
  const { kbId, documentId, partitionTable, records } = args
  if (records.length === 0) return

  const clusterRows = await tx
    .select({ clusterId: kbCluster.clusterId, centroid: kbCluster.centroid })
    .from(kbCluster)
    .where(eq(kbCluster.kbId, kbId))
  const centroids = clusterRows.map((c) => c.centroid as number[])
  const clusterIds = clusterRows.map((c) => c.clusterId)

  const existingResult = (await tx.execute(
    sql.raw(
      `SELECT count(*)::int AS c FROM ${partitionTable} WHERE document_id <> '${documentId.replace(
        /'/g,
        "''"
      )}'`
    )
  )) as { rows?: Array<{ c: number }> } | Array<{ c: number }>
  const existingRows = Array.isArray(existingResult) ? existingResult : (existingResult.rows ?? [])
  const totalExistingOther = Number(existingRows[0]?.c ?? 0)
  const useClusters = centroids.length > 0 && totalExistingOther >= COLD_START_MIN

  /**
   * Delete exactly this batch's chunk indices so a re-run is idempotent without
   * clobbering sibling batches. The indices are integer column values, so they
   * are inlined as a literal `IN (...)` list — drizzle expands a JS array in a
   * `sql` template into a parenthesised parameter tuple, which is invalid as an
   * `ANY(...)` argument.
   */
  const indexList = records.map((r) => Math.trunc(r.chunkIndex)).join(',')
  await tx.execute(
    sql`DELETE FROM ${sql.raw(partitionTable)} WHERE document_id = ${documentId} AND chunk_index IN (${sql.raw(indexList)})`
  )

  for (const rec of records) {
    let clusterIdValue: number | null = null
    if (useClusters) {
      const idx = assignCluster(rec.embedding, centroids)
      if (idx !== null && idx >= 0 && idx < clusterIds.length) {
        clusterIdValue = clusterIds[idx]
      }
    }
    const embeddingLit = `[${rec.embedding.join(',')}]`
    await tx.execute(sql`
      INSERT INTO ${sql.raw(partitionTable)}
        (id, kb_id, document_id, chunk_index, content, cluster_id, metadata, embedding)
      VALUES (
        ${rec.id},
        ${kbId},
        ${documentId},
        ${rec.chunkIndex},
        ${rec.content},
        ${clusterIdValue},
        '{}'::jsonb,
        ${embeddingLit}::vector
      )
    `)
  }
}

/**
 * Stage 1 — parse, chunk, stage rows, provision, and fan out.
 *
 * Runs as the `knowledge-process-document` worker job on the BullMQ backend.
 * Completes quickly after creating the flow; the embedding work happens in the
 * fanned-out batch children.
 */
export async function planDocumentEmbedding(
  payload: DocumentProcessingPayload,
  signal?: AbortSignal
): Promise<void> {
  try {
    await runPlan(payload, signal)
  } catch (error) {
    /**
     * A crashed planner (bad file, parse failure, provisioning error) must not
     * strand the document in `processing`. Mark it `failed` and pull it from the
     * KB; BullMQ then retries, and a later successful attempt resets the status
     * to `processing` and re-plans from scratch.
     */
    const message = error instanceof Error ? error.message : String(error)
    logger.error(`[${payload.documentId}] Planning failed`, { error: message })
    await db
      .update(document)
      .set({
        processingStatus: 'failed',
        processingError: message,
        processingCompletedAt: new Date(),
        includedInKb: false,
      })
      .where(eq(document.id, payload.documentId))
    throw error
  }
}

async function runPlan(payload: DocumentProcessingPayload, signal?: AbortSignal): Promise<void> {
  const { knowledgeBaseId, documentId, docData } = payload

  const kbRows = await db
    .select({
      userId: knowledgeBase.ownerId,
      workspaceId: knowledgeBase.pairedClientId,
      chunkingConfig: knowledgeBase.chunkingConfig,
      embeddingEndpointId: knowledgeBase.embeddingEndpointId,
    })
    .from(knowledgeBase)
    .where(and(eq(knowledgeBase.id, knowledgeBaseId), isNull(knowledgeBase.deletedAt)))
    .limit(1)

  if (kbRows.length === 0) {
    throw new Error(`Knowledge base not found: ${knowledgeBaseId}`)
  }
  const kb = kbRows[0]
  if (!kb.embeddingEndpointId) {
    throw new Error(
      `Knowledge base ${knowledgeBaseId} has no embedding endpoint configured. Set one in the KB settings.`
    )
  }

  const endpoint = await resolveKbEmbeddingEndpoint(kb.embeddingEndpointId)
  const dim = endpoint.dimensions
  if (!Number.isInteger(dim) || (dim as number) < 1) {
    throw new Error(
      `Cannot plan embedding: endpoint ${kb.embeddingEndpointId} has invalid dimensions ${String(dim)}`
    )
  }

  await db
    .update(document)
    .set({
      processingStatus: 'chunking',
      processingStartedAt: new Date(),
      processingCompletedAt: null,
      processingError: null,
      processedChunks: 0,
      includedInKb: true,
    })
    .where(
      and(eq(document.id, documentId), isNull(document.archivedAt), isNull(document.deletedAt))
    )

  const rawConfig = kb.chunkingConfig as {
    maxSize?: number
    minSize?: number
    overlap?: number
    strategy?: ChunkingStrategy
    strategyOptions?: StrategyOptions
  } | null
  const kbConfig = {
    maxSize: rawConfig?.maxSize ?? 1024,
    minSize: rawConfig?.minSize ?? 100,
    overlap: rawConfig?.overlap ?? 200,
  }

  logger.info(`[${documentId}] Planning embedding: parsing ${docData.filename}`)
  const processed = await processDocument(
    docData.fileUrl,
    docData.filename,
    docData.mimeType,
    kbConfig.maxSize,
    kbConfig.overlap,
    kbConfig.minSize,
    kb.userId,
    kb.workspaceId,
    rawConfig?.strategy,
    rawConfig?.strategyOptions
  )
  if (signal?.aborted) {
    throw new Error('Document planning aborted')
  }

  const chunks = processed.chunks
  const chunkCount = chunks.length

  /** Fetch document tag columns so staged chunk rows inherit them for filtering. */
  const [docTags] = await db
    .select({
      tag1: document.tag1,
      tag2: document.tag2,
      tag3: document.tag3,
      tag4: document.tag4,
      tag5: document.tag5,
      tag6: document.tag6,
      tag7: document.tag7,
      number1: document.number1,
      number2: document.number2,
      number3: document.number3,
      number4: document.number4,
      number5: document.number5,
      date1: document.date1,
      date2: document.date2,
      boolean1: document.boolean1,
      boolean2: document.boolean2,
      boolean3: document.boolean3,
    })
    .from(document)
    .where(eq(document.id, documentId))
    .limit(1)
  const tags = docTags ?? {}

  /**
   * Stage every chunk content-addressed by `(document_id, chunk_index)`. On a
   * resume/re-process the upsert preserves an already-computed vector when the
   * chunk content is unchanged (`chunk_hash` matches) and resets it to NULL when
   * the content changed, so unchanged work is never redone and stale vectors are
   * never kept.
   */
  const now = new Date()
  for (let i = 0; i < chunks.length; i += STAGE_INSERT_BATCH) {
    const slice = chunks.slice(i, i + STAGE_INSERT_BATCH)
    const rows = slice.map((chunk, j) => {
      const chunkIndex = i + j
      const content = chunk.text
      return {
        id: generateId(),
        knowledgeBaseId,
        documentId,
        chunkIndex,
        chunkHash: crypto.createHash('sha256').update(content).digest('hex'),
        content,
        contentLength: content.length,
        tokenCount: Math.ceil(content.length / 4),
        embedding: null,
        embeddingModel: endpoint.modelName ?? 'embedding',
        startOffset: chunk.metadata.startIndex,
        endOffset: chunk.metadata.endIndex,
        enabled: false,
        ...tags,
        createdAt: now,
        updatedAt: now,
      }
    })
    await db
      .insert(embedding)
      .values(rows)
      .onConflictDoUpdate({
        target: [embedding.documentId, embedding.chunkIndex],
        set: {
          content: sql`excluded.content`,
          contentLength: sql`excluded.content_length`,
          tokenCount: sql`excluded.token_count`,
          startOffset: sql`excluded.start_offset`,
          endOffset: sql`excluded.end_offset`,
          chunkHash: sql`excluded.chunk_hash`,
          embedding: sql`CASE WHEN ${embedding.chunkHash} = excluded.chunk_hash THEN ${embedding.embedding} ELSE NULL END`,
          enabled: sql`CASE WHEN ${embedding.chunkHash} = excluded.chunk_hash THEN ${embedding.enabled} ELSE false END`,
          updatedAt: now,
        },
      })
  }

  /** Drop any rows beyond the new chunk count (document shrank on re-process). */
  await db
    .delete(embedding)
    .where(and(eq(embedding.documentId, documentId), gte(embedding.chunkIndex, chunkCount)))

  /** Provision the partition once, serially, before any batch writes to it. */
  if (!(await partitionExists(knowledgeBaseId))) {
    await provisionKbPartition({ kbId: knowledgeBaseId, dim: dim as number })
  }

  await db
    .update(document)
    .set({
      chunkCount,
      tokenCount: processed.metadata.tokenCount,
      characterCount: processed.metadata.characterCount,
    })
    .where(eq(document.id, documentId))

  if (chunkCount === 0) {
    await db
      .update(document)
      .set({
        processingStatus: 'completed',
        processingCompletedAt: new Date(),
        processingError: null,
      })
      .where(eq(document.id, documentId))
    logger.info(`[${documentId}] No chunks produced; marked completed`)
    return
  }

  /** Reset the batch ledger for this document, then write fresh rows. */
  await db.delete(documentEmbedBatch).where(eq(documentEmbedBatch.documentId, documentId))

  const ranges = computeBatchRanges(chunkCount, TARGET_CHUNKS_PER_BATCH)
  const endpointIds = assignEndpoints(ranges.length, [kb.embeddingEndpointId])
  const batchRows = ranges.map((range, i) => ({
    id: generateId(),
    documentId,
    knowledgeBaseId,
    startIndex: range.startIndex,
    endIndex: range.endIndex,
    endpointId: endpointIds[i],
    status: 'pending' as const,
    attempt: 0,
    createdAt: now,
    updatedAt: now,
  }))
  await db.insert(documentEmbedBatch).values(batchRows)

  /**
   * Enter the `embedding` phase: parsing/staging (the `chunking` phase) is done
   * and the fanned-out batches now drive `processed_chunks` toward `chunkCount`.
   */
  await db
    .update(document)
    .set({ processingStatus: 'embedding', processedChunks: 0 })
    .where(eq(document.id, documentId))

  // lifted: was `payload.correlation ?? { requestId }`. The correlation record
  // ties a job to a Studio workflow execution; Search carries the request id and
  // nothing else (see `jobs/types.ts`).
  const correlation = { requestId: payload.requestId }
  const finalizePayload: EmbedFinalizePayload = {
    knowledgeBaseId,
    documentId,
    filename: docData.filename,
  }

  const flow = getFlowProducer()
  await flow.add({
    name: 'kb.embed.finalize',
    queueName: QUEUE_NAMES.knowledge,
    data: { payload: finalizePayload, metadata: { correlation, runtime: 'bullmq' } },
    opts: { ...FLOW_JOB_OPTS, removeOnComplete: true, removeOnFail: false },
    children: batchRows.map((b) => {
      const batchPayload: EmbedBatchPayload = {
        knowledgeBaseId,
        documentId,
        startIndex: b.startIndex,
        endIndex: b.endIndex,
        batchId: b.id,
        endpointId: b.endpointId,
      }
      return {
        name: 'kb.embed.batch',
        queueName: QUEUE_NAMES.knowledge,
        data: { payload: batchPayload, metadata: { correlation, runtime: 'bullmq' } },
        opts: { ...FLOW_JOB_OPTS, ignoreDependencyOnFailure: true },
      }
    }),
  })

  logger.info(`[${documentId}] Fanned out ${ranges.length} embed batches for ${chunkCount} chunks`)
}

/**
 * Stage 2 — embed one resumable chunk range.
 *
 * Embeds only rows whose vector is still NULL, then writes vectors to the
 * `embedding` table and the partition. Marks its ledger row and rethrows on
 * failure so BullMQ retries (and, once exhausted, leaves the row `failed` for
 * finalize to report).
 */
export async function processEmbedBatch(
  payload: EmbedBatchPayload,
  signal?: AbortSignal
): Promise<void> {
  const { knowledgeBaseId, documentId, startIndex, endIndex, batchId, endpointId } = payload

  await db
    .update(documentEmbedBatch)
    .set({
      status: 'processing',
      attempt: sql`${documentEmbedBatch.attempt} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(documentEmbedBatch.id, batchId))

  try {
    const endpoint = await resolveKbEmbeddingEndpoint(endpointId)

    const staged = await db
      .select({ id: embedding.id, chunkIndex: embedding.chunkIndex, content: embedding.content })
      .from(embedding)
      .where(
        and(
          eq(embedding.documentId, documentId),
          isNull(embedding.embedding),
          gte(embedding.chunkIndex, startIndex),
          lt(embedding.chunkIndex, endIndex)
        )
      )
      .orderBy(asc(embedding.chunkIndex))

    if (staged.length === 0) {
      await db
        .update(documentEmbedBatch)
        .set({ status: 'completed', error: null, updatedAt: new Date() })
        .where(eq(documentEmbedBatch.id, batchId))
      return
    }

    const { embeddings } = await executeWorkspaceEmbedding({
      endpoint,
      input: staged.map((s) => s.content),
      signal,
    })
    if (embeddings.length !== staged.length) {
      throw new Error(
        `Embedding count mismatch for batch ${batchId}: got ${embeddings.length}, expected ${staged.length}`
      )
    }

    // lifted: `kbPartitionName` -> `kbPartitionRef`, which returns the qualified
    // `"search"."<table>"` identifier. The SQL below is otherwise byte-identical;
    // only the identifier token changed. See `kb/partition.ts` for why a bare name
    // is dangerous on a database shared with Studio.
    const partitionTable = kbPartitionRef(knowledgeBaseId)
    await db.transaction(async (tx) => {
      const writtenAt = new Date()
      for (let i = 0; i < staged.length; i++) {
        await tx
          .update(embedding)
          .set({ embedding: embeddings[i], enabled: true, updatedAt: writtenAt })
          .where(eq(embedding.id, staged[i].id))
      }
      await writePartitionChunks(tx, {
        kbId: knowledgeBaseId,
        documentId,
        partitionTable,
        records: staged.map((s, i) => ({
          id: s.id,
          chunkIndex: s.chunkIndex,
          content: s.content,
          embedding: embeddings[i],
        })),
      })
      await tx
        .update(document)
        .set({ processedChunks: sql`${document.processedChunks} + ${staged.length}` })
        .where(eq(document.id, documentId))
      await tx
        .update(documentEmbedBatch)
        .set({ status: 'completed', error: null, updatedAt: writtenAt })
        .where(eq(documentEmbedBatch.id, batchId))
    })

    logger.info(`[${documentId}] Embedded batch ${batchId}: ${staged.length} chunks`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await db
      .update(documentEmbedBatch)
      .set({ status: 'failed', error: message, updatedAt: new Date() })
      .where(eq(documentEmbedBatch.id, batchId))
    throw error
  }
}

/**
 * Stage 3 — fan-in. Decide the document's terminal state from how many chunks
 * remain unembedded after every batch has settled.
 */
export async function finalizeDocumentEmbedding(payload: EmbedFinalizePayload): Promise<void> {
  const { knowledgeBaseId, documentId } = payload

  const [remainingRow] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(embedding)
    .where(and(eq(embedding.documentId, documentId), isNull(embedding.embedding)))
  const remaining = Number(remainingRow?.c ?? 0)

  if (remaining === 0) {
    /**
     * Embedding-complete makes the document searchable (`included_in_kb`), but
     * keyword extraction is its own keyword-aware terminal phase. Hand off in
     * the `keywording` state and let `kb-keywords-extract` drive the final
     * `completed`/`failed` transition (and the clustering drain gate) — this
     * avoids a `completed → keywording` status regression. If the hand-off
     * cannot be enqueued, settle as semantic-only `completed` so the document
     * never hangs.
     */
    await db
      .update(document)
      .set({
        processingStatus: 'keywording',
        processingError: null,
        includedInKb: true,
        processedChunks: 0,
      })
      .where(eq(document.id, documentId))

    try {
      const queue = await getJobQueue()
      await queue.enqueue('kb-keywords-extract', { documentId, knowledgeBaseId })
    } catch (error) {
      logger.warn(`[${documentId}] Failed to enqueue keyword extraction; settling semantic-only`, {
        error: error instanceof Error ? error.message : String(error),
      })
      await db
        .update(document)
        .set({
          processingStatus: 'completed',
          processingCompletedAt: new Date(),
          keywordStatus: 'skipped:no-inference-endpoint',
        })
        .where(eq(document.id, documentId))
    }

    logger.info(`[${documentId}] Finalized: all chunks embedded, handed off to keywording`)
    return
  }

  const failedBatches = await db
    .select({ id: documentEmbedBatch.id, error: documentEmbedBatch.error })
    .from(documentEmbedBatch)
    .where(
      and(eq(documentEmbedBatch.documentId, documentId), eq(documentEmbedBatch.status, 'failed'))
    )

  const firstError = failedBatches.find((b) => b.error)?.error ?? 'unknown error'
  const summary = `Embedding incomplete: ${remaining} chunk(s) unembedded after ${failedBatches.length} failed batch(es). First error: ${firstError}`

  /**
   * Auto-resume (BullMQ `attempts: 3`) is exhausted at this point, so leftover
   * NULL vectors are terminal. Mark failed and pull the document out of the
   * searchable set; the chunks that did embed remain staged for a later manual
   * retry (which resumes rather than restarts).
   */
  await db
    .update(document)
    .set({
      processingStatus: 'failed',
      processingError: summary,
      processingCompletedAt: new Date(),
      includedInKb: false,
    })
    .where(eq(document.id, documentId))

  logger.error(`[${documentId}] Finalized as failed: ${summary}`)
}
