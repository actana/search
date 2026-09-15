/**
 * KB v2 ingest pipeline.
 *
 * Auth lives at the route layer. `ingestDocument` takes no session / OTP
 * context and is safe to call from the SDK runtime route, the workflow block
 * handler, and the include-toggle background job.
 *
 * Pipeline (when `includedInKb === true`):
 *   1. Load the KB row (model ids required).
 *   2. Persist a `document` row.
 *   3. Resolve text from `args.text` or the provided file buffer.
 *   4. Chunk via `selectChunker`.
 *   5. Embed all chunks via the shared token-batched embedding primitive
 *      ({@link executeWorkspaceEmbedding}), which self-batches by provider
 *      token/item caps and returns vectors in input order.
 *   6. Assign cluster ids (cold-start safe: NULL when no clusters / < 50
 *      existing chunks).
 *   7. Single transaction: insert chunk rows into the partition table, upsert
 *      keyword vocabulary, insert `kb_chunk_keyword` rows.
 *   8. Trigger `kb.clusters.validate` background job when the new-chunk
 *      threshold trips.
 */

import { db } from '../db/client.ts'
import { document, kbCluster, knowledgeBase } from '../db/schema.ts'
import { createLogger } from '@actana/search-shared/log'
import { eq, sql } from 'drizzle-orm'
import { JsonYamlChunker } from '@actana/search-shared/chunkers/json-yaml-chunker'
import { RecursiveChunker } from '@actana/search-shared/chunkers/recursive-chunker'
import { TextChunker } from '@actana/search-shared/chunkers/text-chunker'
import { getJobQueue } from '../queue/index.ts'
import { generateId } from '@actana/search-shared/short-id'
import { assignCluster } from './clustering.ts'
import { clustersValidateJobName } from './jobs/clusters-validate.ts'
import { keywordsExtractJobName } from './jobs/keywords-extract.ts'
import { kbPartitionRef } from './partition.ts'
import { resolveKbEmbeddingEndpoint } from './provider-context.ts'
import { executeWorkspaceEmbedding } from '../models/embedding.ts'

const logger = createLogger('kb/ingest')

/** Default chunk size in tokens. */
const DEFAULT_CHUNK_SIZE = 1024
/** Default overlap in tokens. */
const DEFAULT_CHUNK_OVERLAP = 128
/** Minimum chunks an empty KB must have before we run cluster assignment. */
const COLD_START_MIN_CHUNKS = 50

export interface ChunkInput {
  text: string
  index: number
}

export type ChunkerFn = (text: string | Buffer) => Promise<ChunkInput[]>

/**
 * Map a filename + mime type to one of the existing chunkers in
 * `lib/chunkers/`. Chunk size + overlap come from the KB's stored config,
 * falling back to {@link DEFAULT_CHUNK_SIZE} / {@link DEFAULT_CHUNK_OVERLAP}.
 */
export function selectChunker(
  filename: string,
  _mimeType: string | undefined,
  chunkingConfig: { chunkSize?: number; overlap?: number; method?: string } | null | undefined
): ChunkerFn {
  const chunkSize = chunkingConfig?.chunkSize ?? DEFAULT_CHUNK_SIZE
  const chunkOverlap = chunkingConfig?.overlap ?? DEFAULT_CHUNK_OVERLAP
  const lower = filename.toLowerCase()

  if (lower.endsWith('.md')) {
    const chunker = new RecursiveChunker({ chunkSize, chunkOverlap, recipe: 'markdown' })
    return async (text) => {
      const out = await chunker.chunk(typeof text === 'string' ? text : text.toString('utf8'))
      return out.map((c, i) => ({ text: c.text, index: i }))
    }
  }
  if (lower.endsWith('.txt')) {
    const chunker = new TextChunker({ chunkSize, chunkOverlap })
    return async (text) => {
      const out = await chunker.chunk(typeof text === 'string' ? text : text.toString('utf8'))
      return out.map((c, i) => ({ text: c.text, index: i }))
    }
  }
  if (lower.endsWith('.json') || lower.endsWith('.yaml') || lower.endsWith('.yml')) {
    const chunker = new JsonYamlChunker({ chunkSize })
    return async (text) => {
      const out = await chunker.chunk(typeof text === 'string' ? text : text.toString('utf8'))
      return out.map((c, i) => ({ text: c.text, index: i }))
    }
  }

  /**
   * Fallback: treat unknown types as plain text via RecursiveChunker(plain).
   * Real PDF/DOCX extraction is handled upstream in C5 routes; v1 never
   * receives raw binary for those types here.
   *
   * TODO(chunk-d): route binary types (`.pdf`, `.docx`) through DocsChunker
   * once the C5 upload pipeline lands.
   */
  const plain = new RecursiveChunker({ chunkSize, chunkOverlap, recipe: 'plain' })
  return async (text) => {
    const str = typeof text === 'string' ? text : text.toString('utf8')
    const out = await plain.chunk(str)
    return out.map((c, i) => ({ text: c.text, index: i }))
  }
}

export interface IngestDocumentArgs {
  kbId: string
  file?: Buffer | Blob
  text?: string
  filename: string
  mimeType?: string
  metadata?: Record<string, unknown>
  /**
   * Retained for backward compatibility. Embedding is now token-batched inside
   * {@link executeWorkspaceEmbedding}, so per-chunk fan-out concurrency is no
   * longer honored here.
   */
  concurrency?: number
  /**
   * Optional outer transaction. When provided, the chunk-write batch runs
   * inside it. When omitted, ingest opens its own transaction.
   */
  tx?: typeof db
  /** Defaults to `false` — uploaded but not chunked. */
  includedInKb?: boolean
  /**
   * The id to give the new document, when the caller has already told somebody
   * what it is.
   *
   * The REST ingest route answers `{ documentId }` before any of the work has
   * happened and then enqueues a `kb.ingest.document` job, so the id has to
   * exist before this function runs. {@link stageIngestedDocument} is
   * idempotent, so the row the route wrote and the row this would have written
   * are the same row.
   */
  documentId?: string
  /** Tag slot values to stamp on the document row. */
  tags?: Record<string, string | number | boolean | Date | null>
}

export interface IngestDocumentResult {
  documentId: string
  chunkCount: number
}

interface PerChunkResult {
  chunkIndex: number
  text: string
  keywords: string[]
  embedding: number[]
}

interface KbClusterRow {
  clusterId: number
  centroid: number[]
}

/** What {@link stageIngestedDocument} needs to write the row. */
export interface StageIngestedDocumentArgs {
  kbId: string
  documentId: string
  filename: string
  mimeType?: string
  /** Where the bytes are, for a document that has any. Empty for direct text. */
  fileUrl?: string
  fileSize?: number
  characterCount?: number
  includedInKb?: boolean
  tags?: Record<string, string | number | boolean | Date | null>
}

/**
 * Write the `document` row an ingest works against.
 *
 * Extracted from {@link ingestDocument} verbatim — same columns, same values —
 * so the REST route can create the row, answer with its id, and hand the work
 * to a job that calls `ingestDocument` with that same id. `onConflictDoNothing`
 * is what makes calling it twice with one id harmless, and therefore what makes
 * the route and the job agree on one row.
 *
 * The status is `pending` and not `processing` even when the document will be
 * ingested: chunking and embedding happen outside the chunk-write transaction,
 * and the document is only flipped to `completed` atomically with the chunk
 * inserts. A `processing` row here would leave a `processing` document with
 * zero chunks for the whole embed window if the process died — a `pending` row
 * with `processing_started_at` set is the cleaner stuck state, and it is the one
 * the document-timeout sweep reconciles.
 */
export async function stageIngestedDocument(args: StageIngestedDocumentArgs): Promise<void> {
  const now = new Date()
  await db
    .insert(document)
    .values({
      id: args.documentId,
      knowledgeBaseId: args.kbId,
      filename: args.filename,
      fileUrl: args.fileUrl ?? '',
      fileSize: args.fileSize ?? 0,
      mimeType: args.mimeType ?? 'application/octet-stream',
      chunkCount: 0,
      tokenCount: 0,
      characterCount: args.characterCount ?? 0,
      processingStatus: 'pending',
      processingStartedAt: args.includedInKb ? now : null,
      enabled: true,
      includedInKb: args.includedInKb ?? false,
      uploadedAt: now,
      ...(args.tags ?? {}),
    })
    .onConflictDoNothing()
}

/**
 * Ingest a document into a KB. Returns the new `document.id` and the number
 * of partition rows written.
 */
export async function ingestDocument(args: IngestDocumentArgs): Promise<IngestDocumentResult> {
  const {
    kbId,
    file,
    text: directText,
    filename,
    mimeType,
    metadata = {},
    includedInKb = false,
  } = args

  const [kb] = await db.select().from(knowledgeBase).where(eq(knowledgeBase.id, kbId)).limit(1)
  if (!kb) {
    throw new Error(`ingestDocument: knowledge base not found: ${kbId}`)
  }
  if (!kb.embeddingEndpointId) {
    throw new Error(`ingestDocument: kb ${kbId} has no embedding endpoint configured`)
  }
  /**
   * Note: ingest does NOT require an inference model. Inference is only used for
   * keyword extraction, which runs later in the `kb-keywords-extract` worker and
   * soft-skips when no inference endpoint is configured. A KB with just an
   * embedding endpoint ingests fine and is semantically searchable.
   */

  const documentId = args.documentId ?? generateId()
  await stageIngestedDocument({
    kbId,
    documentId,
    filename,
    mimeType,
    fileSize: file instanceof Buffer ? file.length : 0,
    characterCount: directText?.length ?? 0,
    includedInKb,
    tags: args.tags,
  })

  if (!includedInKb) {
    logger.info('ingest: includedInKb=false, persisting metadata only', { kbId, documentId })
    return { documentId, chunkCount: 0 }
  }

  let totalExisting = 0
  let chunkRows: Array<{
    id: string
    kbId: string
    documentId: string
    chunkIndex: number
    content: string
    clusterId: number | null
    metadata: Record<string, unknown>
    embedding: number[]
    keywords: string[]
  }> = []

  try {
    let text: string
    if (typeof directText === 'string') {
      text = directText
    } else if (file instanceof Buffer) {
      text = file.toString('utf8')
    } else if (file && typeof (file as Blob).text === 'function') {
      text = await (file as Blob).text()
    } else {
      throw new Error('ingestDocument: no text or file provided')
    }

    const chunker = selectChunker(
      filename,
      mimeType,
      kb.chunkingConfig as { chunkSize?: number; overlap?: number; method?: string } | null
    )
    const chunks = await chunker(text)
    logger.info('ingest: chunked', { kbId, documentId, chunkCount: chunks.length })

    /**
     * Ingest resolves only the embedding endpoint. Keyword extraction (which
     * needs an inference model) runs afterward in the `kb-keywords-extract`
     * worker enqueued at the end of ingest; it walks the persisted chunks and
     * soft-skips when no inference endpoint is configured.
     */
    const embeddingEndpoint = await resolveKbEmbeddingEndpoint(kb.embeddingEndpointId)

    /**
     * Embed every chunk through the shared batched primitive, which self-batches
     * by provider token + item caps and concatenates vectors in input order.
     * A failure rejects and is caught by the outer try/catch below — which marks
     * the document as `'failed'` with the error message so the caller and the UI
     * can see what went wrong instead of the document being stuck in
     * `'processing'`.
     */
    const embRes = await executeWorkspaceEmbedding({
      endpoint: embeddingEndpoint,
      input: chunks.map((chunk) => chunk.text),
    })
    const perChunk: PerChunkResult[] = chunks.map((chunk, i) => {
      const embedding = embRes.embeddings[i]
      if (!embedding || embedding.length === 0) {
        throw new Error(
          `ingestDocument: embedding provider returned no vector for chunk ${chunk.index}`
        )
      }
      return {
        chunkIndex: chunk.index,
        text: chunk.text,
        keywords: [],
        embedding,
      }
    })

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
    const totalExistingRows = Array.isArray(totalExistingResult)
      ? totalExistingResult
      : (totalExistingResult.rows ?? [])
    totalExisting = Number(totalExistingRows[0]?.c ?? 0)

    const useClusters = clusters.length > 0 && totalExisting >= COLD_START_MIN_CHUNKS
    const centroidVectors = clusters.map((c) => c.centroid)
    const clusterIdLookup = clusters.map((c) => c.clusterId)

    chunkRows = perChunk.map((c) => {
      let clusterIdValue: number | null = null
      if (useClusters) {
        const idx = assignCluster(c.embedding, centroidVectors)
        if (idx !== null && idx >= 0 && idx < clusterIdLookup.length) {
          clusterIdValue = clusterIdLookup[idx]
        }
      }
      return {
        id: generateId(),
        kbId,
        documentId,
        chunkIndex: c.chunkIndex,
        content: c.text,
        clusterId: clusterIdValue,
        metadata,
        embedding: c.embedding,
        keywords: c.keywords,
      }
    })

    await db.transaction(async (tx) => {
      if (chunkRows.length > 0) {
        for (const row of chunkRows) {
          const embeddingLit = `[${row.embedding.join(',')}]`
          await tx.execute(sql`
            INSERT INTO ${sql.raw(partitionTable)}
              (id, kb_id, document_id, chunk_index, content, cluster_id, metadata, embedding)
            VALUES (
              ${row.id},
              ${row.kbId},
              ${row.documentId},
              ${row.chunkIndex},
              ${row.content},
              ${row.clusterId},
              ${JSON.stringify(row.metadata)}::jsonb,
              ${embeddingLit}::vector
            )
          `)
        }
      }

      // TODO(γ — T3): keyword inserts moved to the `kb-keywords-extract`
      // worker, which writes `embedding_keyword` rows after chunks land.

      await tx
        .update(document)
        .set({
          chunkCount: chunkRows.length,
          processingStatus: 'completed',
          processingCompletedAt: new Date(),
        })
        .where(eq(document.id, documentId))
    })
  } catch (err) {
    await markDocumentFailed(kbId, documentId, err)
    throw err
  }

  if (chunkRows.length > 0) {
    try {
      const queue = await getJobQueue()
      await queue.enqueue(keywordsExtractJobName, { documentId, knowledgeBaseId: kbId })
      logger.info('ingest: enqueued kb-keywords-extract', { kbId, documentId })
    } catch (err) {
      logger.warn('ingest: failed to enqueue kb-keywords-extract', {
        kbId,
        documentId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const totalAfter = totalExisting + chunkRows.length
  const sinceLastValidation = kb.kmeansUpdatedAt ? chunkRows.length : totalAfter
  const threshold = Math.max(500, Math.floor(0.2 * totalAfter))
  if (sinceLastValidation > threshold) {
    try {
      const queue = await getJobQueue()
      await queue.enqueue(clustersValidateJobName, { kbId })
      logger.info('ingest: enqueued clusters validate', {
        kbId,
        sinceLastValidation,
        threshold,
      })
    } catch (err) {
      logger.warn('ingest: failed to enqueue clusters validate', {
        kbId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return { documentId, chunkCount: chunkRows.length }
}

/**
 * Maximum length we store in `document.processing_error`. Drivers and
 * downstream UIs choke on multi-kilobyte stack traces; capping at 2 KB
 * preserves the most useful prefix without blowing up the row.
 */
const MAX_ERROR_LENGTH = 2000

/**
 * Mark a document as failed-to-ingest. Writes `processing_status = 'failed'`,
 * captures a truncated error message in `processing_error`, and stamps
 * `processing_completed_at` so the doc leaves the active processing set.
 *
 * Failures inside this helper are swallowed (logged only) — the caller
 * will rethrow the original ingest error, and we never want a status-write
 * failure to mask the real problem.
 */
async function markDocumentFailed(kbId: string, documentId: string, err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : String(err)
  const truncated =
    message.length > MAX_ERROR_LENGTH ? `${message.slice(0, MAX_ERROR_LENGTH)}…` : message

  logger.error('ingest: marking document as failed', {
    kbId,
    documentId,
    error: message,
  })

  try {
    await db
      .update(document)
      .set({
        processingStatus: 'failed',
        processingError: truncated,
        processingCompletedAt: new Date(),
      })
      .where(eq(document.id, documentId))
  } catch (updateErr) {
    logger.error('ingest: failed to persist failed status', {
      kbId,
      documentId,
      updateErr: updateErr instanceof Error ? updateErr.message : String(updateErr),
    })
  }
}
