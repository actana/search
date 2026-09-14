import crypto from 'crypto'
import { db } from '../../db/client.ts'
import {
  document,
  embedding,
  kbCluster,
  knowledgeBase,
  knowledgeBaseTagDefinitions,
  qualified,
} from '../../db/schema.ts'
import { createLogger } from '@actana/search-shared/log'
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  or,
  type SQL,
  sql,
} from 'drizzle-orm'
import type { ChunkingStrategy, StrategyOptions } from '@actana/search-shared/chunkers/types'
import { getJobQueue } from '../../queue/index.ts'
import { env } from '../../config.ts'
import { withPromiseTimeout } from '@actana/search-shared/promise-timeout'
import { generateId } from '@actana/search-shared/short-id'
import { assignCluster } from '../../kb/clustering.ts'
import { maybeEnqueueClusteringIfDrained } from '../../kb/clustering-trigger.ts'
import { provisionKbPartition } from '../../kb/ddl.ts'
import {
  attachKeywordToChunk,
  listKbKeywords,
  recomputeDocumentKeywords,
  upsertKbKeyword,
} from '../../kb/keywords/index.ts'
import { extractKeywordsForChunk, KeywordInferenceFatalError } from '../../kb/keywords/extract.ts'
import { withKbIngestLock } from '../../kb/locks.ts'
import { resolveKbInferenceEndpoint } from '../../kb/provider-context.ts'
import type { WorkspaceInferenceEndpoint } from '../../models/inference.ts'

/** Top-N existing KB keywords surfaced to each chunk's extraction prompt. */
const KEYWORD_VOCAB_HINT_LIMIT = 100

import { kbPartitionRef, partitionExists } from '../../kb/partition.ts'
import { resolveKbEmbeddingEndpoint } from '../../kb/provider-context.ts'
import {
  MAX_CHUNKS_PER_DOCUMENT,
  processDocument,
} from './document-processor.ts'
import type { DocumentSortField, SortOrder } from './types.ts'
import {
  buildUndefinedTagsError,
  parseBooleanValue,
  parseDateValue,
  parseNumberValue,
  validateTagValue,
} from '../tags/utils.ts'
import type { DocumentProcessingStatus, ProcessedDocumentTags } from '../types.ts'
import { executeWorkspaceEmbedding } from '../../models/embedding.ts'
import { deleteFile } from '../../blob/index.ts'
import { extractStorageKey } from '../../blob/index.ts'
import { MAX_UPLOAD_SIZE_BYTES } from '../../blob/index.ts'
import type { DocumentProcessingPayload } from '../../jobs/types.ts'

const logger = createLogger('DocumentService')

const TIMEOUTS = {
  OVERALL_PROCESSING: (env.KB_CONFIG_MAX_DURATION || 600) * 1000,
} as const

/**
 * Per-document processing budget, scaled by file size.
 *
 * A flat budget (`KB_CONFIG_MAX_DURATION`, default 600s) cannot fit arbitrarily
 * large documents: a multi-MB file legitimately needs many sequential embedding
 * round-trips against a (possibly rate-limited) BYOK endpoint, and a fixed wall
 * kills it mid-flight even though it is making progress. We instead grant the
 * configured base plus an allowance per `TIMEOUT_BYTES_PER_STEP` chunk of the
 * file, clamped to {@link MAX_PROCESSING_TIMEOUT_MS}.
 *
 * The same ceiling backs the timeout-sweep safety window, so all three
 * timeout layers (this race, the worker abort, the sweep) agree on the maximum
 * a healthy document may run before it is considered dead.
 */
const TIMEOUT_BYTES_PER_STEP = 256 * 1024
const TIMEOUT_MS_PER_STEP = 120 * 1000

/** Hard ceiling on a single document's processing budget (1 hour). */
export const MAX_PROCESSING_TIMEOUT_MS = 60 * 60 * 1000

/**
 * Multiplier applied to {@link computeProcessingTimeoutMs} to derive the wall
 * past which a document is considered dead (worker death) rather than merely
 * slow. A healthy document may legitimately run up to its size-scaled budget;
 * only well beyond that is it reconciled to `failed`. Shared by the timeout
 * sweep and {@link markDocumentAsFailedTimeout} so every layer agrees.
 */
export const PROCESSING_TIMEOUT_SAFETY_FACTOR = 2

/**
 * Absolute floor (ms) for the dead-process wall, regardless of file size, so a
 * tiny document is still given a reasonable grace period before any caller may
 * mark it timed out.
 */
export const DEAD_PROCESS_MIN_WINDOW_MS = 600 * 1000

/**
 * Per-chunk allowance (ms) for the keywording phase. Keyword extraction runs
 * one sequential LLM call per chunk — each chunk's prompt is seeded with the
 * keywords chosen by earlier chunks, so the calls cannot be parallelized — so
 * its budget scales with chunk count, not file size. A 400-chunk document
 * therefore gets ~200 minutes, well clear of the byte-scaled budget that fits
 * chunking and embedding.
 */
export const KEYWORD_PER_CHUNK_TIMEOUT_MS = 30 * 1000

/**
 * Compute the processing timeout (ms) for a document of `fileSizeBytes`.
 * Returns at least the configured base budget and never more than
 * {@link MAX_PROCESSING_TIMEOUT_MS}.
 */
export function computeProcessingTimeoutMs(fileSizeBytes: number | undefined | null): number {
  const base = TIMEOUTS.OVERALL_PROCESSING
  const size = Number.isFinite(fileSizeBytes) ? Math.max(0, fileSizeBytes as number) : 0
  const steps = Math.ceil(size / TIMEOUT_BYTES_PER_STEP)
  const scaled = base + steps * TIMEOUT_MS_PER_STEP
  return Math.min(MAX_PROCESSING_TIMEOUT_MS, Math.max(base, scaled))
}

/**
 * Wall (ms) past which a document in `status` is considered dead (worker death)
 * rather than merely slow. The keywording phase scales by chunk count (one
 * sequential LLM round-trip each, {@link KEYWORD_PER_CHUNK_TIMEOUT_MS} apiece);
 * every other phase scales by file size times
 * {@link PROCESSING_TIMEOUT_SAFETY_FACTOR}. Floored at
 * {@link DEAD_PROCESS_MIN_WINDOW_MS} so tiny documents still get a grace period.
 * Shared by the timeout sweep and {@link markDocumentAsFailedTimeout}.
 */
export function computeDeadProcessWindowMs(args: {
  status: string | null | undefined
  fileSize: number | null | undefined
  chunkCount: number | null | undefined
}): number {
  if (args.status === 'keywording') {
    const chunks = Number.isFinite(args.chunkCount) ? Math.max(0, args.chunkCount as number) : 0
    return Math.max(DEAD_PROCESS_MIN_WINDOW_MS, chunks * KEYWORD_PER_CHUNK_TIMEOUT_MS)
  }
  return Math.max(
    DEAD_PROCESS_MIN_WINDOW_MS,
    computeProcessingTimeoutMs(args.fileSize) * PROCESSING_TIMEOUT_SAFETY_FACTOR
  )
}

/**
 * Processing states a document can be stuck in after a worker death. Any
 * document in one of these states past the safety window is reconciled to
 * `failed` by the timeout sweep. `keywording` is included because a doc stuck
 * there blocks the whole KB's clustering drain gate.
 */
export const NON_TERMINAL_PROCESSING_STATUSES = ['pending', 'processing', 'keywording'] as const

/**
 * Age past which a still-`pending` document (processing never started, so the
 * timeout sweep — which only reconciles started documents — will never fail
 * it) stops counting against the Workspace's in-flight ingestion cap. Keeps
 * an orphaned enqueue from wedging the Workspace at its cap forever.
 */
const PENDING_ORPHAN_WINDOW_MS = 24 * 60 * 60 * 1000

/**
 * Count a Workspace's in-flight ingestion jobs — documents in a non-terminal
 * processing status across all of its live knowledge bases (D9). Pending
 * documents older than {@link PENDING_ORPHAN_WINDOW_MS} are treated as
 * orphans and excluded.
 */
export async function countInFlightIngestionJobs(workspaceId: string): Promise<number> {
  const pendingCutoff = new Date(Date.now() - PENDING_ORPHAN_WINDOW_MS)
  const [row] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(document)
    .innerJoin(knowledgeBase, eq(document.knowledgeBaseId, knowledgeBase.id))
    .where(
      and(
        eq(knowledgeBase.pairedClientId, workspaceId),
        isNull(knowledgeBase.deletedAt),
        isNull(document.deletedAt),
        inArray(document.processingStatus, [...NON_TERMINAL_PROCESSING_STATUSES]),
        or(ne(document.processingStatus, 'pending'), gte(document.uploadedAt, pendingCutoff))
      )
    )

  return row?.value ?? 0
}

export interface IngestionCapacityCheck {
  allowed: boolean
  inFlight: number
  limit: number
}

/**
 * D9 in-flight cap: whether a Workspace may enqueue `incoming` more ingestion
 * jobs. A Workspace at its cap has further jobs refused, not run; other
 * Workspaces are unaffected. The limit is operator-tunable via
 * `WORKSPACE_MAX_INFLIGHT_INGESTION_JOBS`. Documents without a Workspace
 * (legacy personal KBs) are not capped.
 */
export async function checkWorkspaceIngestionCapacity(
  workspaceId: string | null | undefined,
  incoming: number
): Promise<IngestionCapacityCheck> {
  const limit = env.WORKSPACE_MAX_INFLIGHT_INGESTION_JOBS
  if (!workspaceId) {
    return { allowed: true, inFlight: 0, limit }
  }

  const inFlight = await countInFlightIngestionJobs(workspaceId)
  return { allowed: inFlight + incoming <= limit, inFlight, limit }
}

const LARGE_DOC_CONFIG = {
  MAX_CHUNKS_PER_BATCH: 500,
  MAX_EMBEDDING_BATCH: env.KB_CONFIG_BATCH_SIZE || 2000,
  MAX_FILE_SIZE: MAX_UPLOAD_SIZE_BYTES,
  MAX_CHUNKS_PER_DOCUMENT,
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  operation = 'Operation'
): Promise<T> {
  return withPromiseTimeout(promise, timeoutMs, `${operation} timed out after ${timeoutMs}ms`)
}

const PROCESSING_CONFIG = {
  maxConcurrentDocuments: Math.max(1, Math.floor((env.KB_CONFIG_CONCURRENCY_LIMIT || 20) / 5)) || 4,
  batchSize: Math.max(1, Math.floor((env.KB_CONFIG_BATCH_SIZE || 20) / 2)) || 10,
  delayBetweenBatches: (env.KB_CONFIG_DELAY_BETWEEN_BATCHES || 100) * 2,
  delayBetweenDocuments: (env.KB_CONFIG_DELAY_BETWEEN_DOCUMENTS || 50) * 2,
}

export function getProcessingConfig() {
  return PROCESSING_CONFIG
}

export interface DocumentData {
  documentId: string
  filename: string
  fileUrl: string
  fileSize: number
  mimeType: string
}

export interface ProcessingOptions {
  recipe?: string
  lang?: string
}

export interface DocumentJobData {
  knowledgeBaseId: string
  documentId: string
  docData: {
    filename: string
    fileUrl: string
    fileSize: number
    mimeType: string
  }
  processingOptions: ProcessingOptions
  requestId: string
}

export async function dispatchDocumentProcessingJob(payload: DocumentJobData): Promise<void> {
  try {
    const queue = await getJobQueue()
    await queue.enqueue('knowledge-process-document', payload, {
      tags: [`knowledgeBaseId:${payload.knowledgeBaseId}`, `documentId:${payload.documentId}`],
    })
  } catch (error) {
    logger.warn('Failed to enqueue document processing, falling back to inline execution', {
      documentId: payload.documentId,
      error: error instanceof Error ? error.message : String(error),
    })
    try {
      await processDocumentAsync(
        payload.knowledgeBaseId,
        payload.documentId,
        payload.docData,
        payload.processingOptions
      )
    } catch (inlineError) {
      /**
       * Both the enqueue and the inline fallback failed. Callers run this
       * fire-and-forget, so without an explicit terminal write the document
       * would strand at `pending` with no `processing_error` and a UI spinner
       * that never resolves. Record a terminal `failed` status idempotently.
       */
      const message = inlineError instanceof Error ? inlineError.message : String(inlineError)
      logger.error('Inline document processing fallback failed; marking document as failed', {
        documentId: payload.documentId,
        error: message,
      })
      await markDocumentDispatchFailed(payload.documentId, message)
      throw inlineError
    }
  }
}

/**
 * Idempotently mark a document as `failed` after both queue dispatch and the
 * inline processing fallback fail.
 *
 * Only documents still in a non-terminal state (`pending`/`processing`) are
 * updated so a later-arriving terminal status (e.g. a retry that completed)
 * is never clobbered. Best-effort: a failure here is logged, not rethrown,
 * so it does not mask the original processing error.
 */
async function markDocumentDispatchFailed(documentId: string, error: string): Promise<void> {
  try {
    await db
      .update(document)
      .set({
        processingStatus: 'failed',
        processingError: `Failed to dispatch processing job: ${error}`,
        processingCompletedAt: new Date(),
      })
      .where(
        and(
          eq(document.id, documentId),
          inArray(document.processingStatus, ['pending', 'processing'])
        )
      )
  } catch (updateError) {
    logger.error('Failed to mark document as failed after dispatch failure', {
      documentId,
      error: updateError instanceof Error ? updateError.message : String(updateError),
    })
  }
}

export interface DocumentTagData {
  tagName: string
  fieldType: string
  value: string
}

export async function processDocumentTags(
  knowledgeBaseId: string,
  tagData: DocumentTagData[],
  requestId: string
): Promise<ProcessedDocumentTags> {
  const setTagValue = (
    tags: ProcessedDocumentTags,
    slot: string,
    value: string | number | Date | boolean | null
  ): void => {
    switch (slot) {
      case 'tag1':
        tags.tag1 = value as string | null
        break
      case 'tag2':
        tags.tag2 = value as string | null
        break
      case 'tag3':
        tags.tag3 = value as string | null
        break
      case 'tag4':
        tags.tag4 = value as string | null
        break
      case 'tag5':
        tags.tag5 = value as string | null
        break
      case 'tag6':
        tags.tag6 = value as string | null
        break
      case 'tag7':
        tags.tag7 = value as string | null
        break
      case 'number1':
        tags.number1 = value as number | null
        break
      case 'number2':
        tags.number2 = value as number | null
        break
      case 'number3':
        tags.number3 = value as number | null
        break
      case 'number4':
        tags.number4 = value as number | null
        break
      case 'number5':
        tags.number5 = value as number | null
        break
      case 'date1':
        tags.date1 = value as Date | null
        break
      case 'date2':
        tags.date2 = value as Date | null
        break
      case 'boolean1':
        tags.boolean1 = value as boolean | null
        break
      case 'boolean2':
        tags.boolean2 = value as boolean | null
        break
      case 'boolean3':
        tags.boolean3 = value as boolean | null
        break
    }
  }

  const result: ProcessedDocumentTags = {
    tag1: null,
    tag2: null,
    tag3: null,
    tag4: null,
    tag5: null,
    tag6: null,
    tag7: null,
    number1: null,
    number2: null,
    number3: null,
    number4: null,
    number5: null,
    date1: null,
    date2: null,
    boolean1: null,
    boolean2: null,
    boolean3: null,
  }

  if (!Array.isArray(tagData) || tagData.length === 0) {
    return result
  }

  const existingDefinitions = await db
    .select()
    .from(knowledgeBaseTagDefinitions)
    .where(eq(knowledgeBaseTagDefinitions.knowledgeBaseId, knowledgeBaseId))

  const existingByName = new Map(existingDefinitions.map((def) => [def.displayName, def]))

  const undefinedTags: string[] = []
  const typeErrors: string[] = []

  for (const tag of tagData) {
    if (!tag.tagName?.trim()) continue

    const tagName = tag.tagName.trim()
    const fieldType = tag.fieldType || 'text'

    const hasValue =
      fieldType === 'boolean'
        ? tag.value !== undefined && tag.value !== null && tag.value !== ''
        : tag.value?.trim && tag.value.trim().length > 0

    if (!hasValue) continue

    const existingDef = existingByName.get(tagName)
    if (!existingDef) {
      undefinedTags.push(tagName)
      continue
    }

    const rawValue = typeof tag.value === 'string' ? tag.value.trim() : tag.value
    const actualFieldType = existingDef.fieldType || fieldType
    const validationError = validateTagValue(tagName, String(rawValue), actualFieldType)
    if (validationError) {
      typeErrors.push(validationError)
    }
  }

  if (undefinedTags.length > 0 || typeErrors.length > 0) {
    const errorParts: string[] = []

    if (undefinedTags.length > 0) {
      errorParts.push(buildUndefinedTagsError(undefinedTags))
    }

    if (typeErrors.length > 0) {
      errorParts.push(...typeErrors)
    }

    throw new Error(errorParts.join('\n'))
  }

  for (const tag of tagData) {
    if (!tag.tagName?.trim()) continue

    const tagName = tag.tagName.trim()
    const fieldType = tag.fieldType || 'text'

    const hasValue =
      fieldType === 'boolean'
        ? tag.value !== undefined && tag.value !== null && tag.value !== ''
        : tag.value?.trim && tag.value.trim().length > 0

    if (!hasValue) continue

    const existingDef = existingByName.get(tagName)
    if (!existingDef) continue

    const targetSlot = existingDef.tagSlot
    const actualFieldType = existingDef.fieldType || fieldType
    const rawValue = typeof tag.value === 'string' ? tag.value.trim() : tag.value
    const stringValue = String(rawValue).trim()

    if (actualFieldType === 'boolean') {
      setTagValue(result, targetSlot, parseBooleanValue(stringValue) ?? false)
    } else if (actualFieldType === 'number') {
      setTagValue(result, targetSlot, parseNumberValue(stringValue))
    } else if (actualFieldType === 'date') {
      setTagValue(result, targetSlot, parseDateValue(stringValue))
    } else {
      setTagValue(result, targetSlot, stringValue)
    }

    logger.info(`[${requestId}] Set tag ${tagName} (${targetSlot}) = ${stringValue}`)
  }

  return result
}

export async function processDocumentsWithQueue(
  createdDocuments: DocumentData[],
  knowledgeBaseId: string,
  processingOptions: ProcessingOptions,
  requestId: string
): Promise<void> {
  const jobPayloads = createdDocuments.map<DocumentJobData>((doc) => ({
    knowledgeBaseId,
    documentId: doc.documentId,
    docData: {
      filename: doc.filename,
      fileUrl: doc.fileUrl,
      fileSize: doc.fileSize,
      mimeType: doc.mimeType,
    },
    processingOptions,
    requestId,
  }))

  logger.info(
    `[${requestId}] Dispatching background processing for ${jobPayloads.length} documents`
  )

  const results = await Promise.allSettled(
    jobPayloads.map((payload) => dispatchDocumentProcessingJob(payload))
  )

  const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
  if (failures.length > 0) {
    logger.error(`[${requestId}] ${failures.length}/${results.length} document dispatches failed`, {
      errors: failures.map((f) =>
        f.reason instanceof Error ? f.reason.message : String(f.reason)
      ),
    })
  }

  logger.info(
    `[${requestId}] Document dispatch complete: ${results.length - failures.length}/${results.length} succeeded`
  )

  if (failures.length === results.length) {
    throw new Error(`All ${failures.length} document processing dispatches failed`)
  }

  return
}

export async function processDocumentAsync(
  knowledgeBaseId: string,
  documentId: string,
  docData: {
    filename: string
    fileUrl: string
    fileSize: number
    mimeType: string
  },
  processingOptions: ProcessingOptions = {},
  signal?: AbortSignal
): Promise<void> {
  /**
   * Hold the per-KB ingest lock for the full chunk → embed → keyword
   * lifecycle of this document. The lock serializes all docs targeting
   * the same KB so resource usage stays bounded and so the keyword
   * extractor can reuse vocabulary learned from earlier files in the
   * same batch. Different KBs are unaffected.
   */
  await withKbIngestLock(knowledgeBaseId, () =>
    processDocumentAsyncLocked(knowledgeBaseId, documentId, docData, processingOptions, signal)
  )

  /**
   * Re-cluster only when the per-KB ingestion queue has fully drained —
   * see `maybeEnqueueClusteringIfDrained` for the threshold logic. The
   * keyword-extract job calls the same helper after it marks the doc
   * `completed`, so this only fires for docs that bypass keywording.
   */
  try {
    await maybeEnqueueClusteringIfDrained(knowledgeBaseId)
  } catch (err) {
    logger.warn(`[${documentId}] clustering-drain check failed`, {
      err: err instanceof Error ? err.message : String(err),
    })
  }
}

async function processDocumentAsyncLocked(
  knowledgeBaseId: string,
  documentId: string,
  docData: {
    filename: string
    fileUrl: string
    fileSize: number
    mimeType: string
  },
  _processingOptions: ProcessingOptions = {},
  signal?: AbortSignal
): Promise<void> {
  const startTime = Date.now()
  try {
    logger.info(`[${documentId}] Starting document processing: ${docData.filename}`)

    /**
     * Enforce the shared upload cap at the processing gate too — the declared
     * fileSize is route-validated, but the worker path must not parse a larger
     * blob however it was enqueued.
     */
    if (docData.fileSize > LARGE_DOC_CONFIG.MAX_FILE_SIZE) {
      throw new Error(
        `Document exceeds the ${Math.floor(LARGE_DOC_CONFIG.MAX_FILE_SIZE / (1024 * 1024))}MB file size limit (${docData.fileSize} bytes)`
      )
    }

    const kb = await db
      .select({
        userId: knowledgeBase.ownerId,
        workspaceId: knowledgeBase.pairedClientId,
        chunkingConfig: knowledgeBase.chunkingConfig,
        embeddingEndpointId: knowledgeBase.embeddingEndpointId,
        inferenceEndpointId: knowledgeBase.inferenceEndpointId,
      })
      .from(knowledgeBase)
      .where(and(eq(knowledgeBase.id, knowledgeBaseId), isNull(knowledgeBase.deletedAt)))
      .limit(1)

    if (kb.length === 0) {
      throw new Error(`Knowledge base not found: ${knowledgeBaseId}`)
    }

    if (!kb[0].embeddingEndpointId) {
      throw new Error(
        `Knowledge base ${knowledgeBaseId} has no embedding endpoint configured. Set one in the KB settings.`
      )
    }

    const embeddingEndpoint = await resolveKbEmbeddingEndpoint(kb[0].embeddingEndpointId)

    /**
     * Unified `'processing'` status replaces the previous
     * chunking/embedding/keywording transitions. The UI now reads
     * `processedChunks / chunkCount` for granular progress instead of
     * watching for sub-status changes. `includedInKb` is reset to true
     * here too: a fresh process attempt clears any prior `failed`
     * exclusion.
     */
    await db
      .update(document)
      .set({
        processingStatus: 'processing',
        processingStartedAt: new Date(),
        processingCompletedAt: null,
        processingError: null,
        processedChunks: 0,
        includedInKb: true,
      })
      .where(
        and(eq(document.id, documentId), isNull(document.archivedAt), isNull(document.deletedAt))
      )

    let inferenceEndpoint: WorkspaceInferenceEndpoint | null = null
    if (kb[0].inferenceEndpointId) {
      try {
        inferenceEndpoint = await resolveKbInferenceEndpoint(kb[0].inferenceEndpointId)
      } catch (err) {
        logger.warn(`[${documentId}] Failed to resolve inference endpoint`, {
          err: err instanceof Error ? err.message : String(err),
        })
        inferenceEndpoint = null
      }
    }

    logger.info(`[${documentId}] Status updated to 'processing', starting document processor`)

    const rawConfig = kb[0].chunkingConfig as {
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

    let totalEmbeddingTokens = 0
    const embeddingModelName = embeddingEndpoint.modelName ?? 'embedding'
    let partitionInsertedCount = 0
    let _kbTotalAfterInsert = 0

    await withTimeout(
      (async () => {
        const processed = await processDocument(
          docData.fileUrl,
          docData.filename,
          docData.mimeType,
          kbConfig.maxSize,
          kbConfig.overlap,
          kbConfig.minSize,
          kb[0].userId,
          kb[0].workspaceId,
          rawConfig?.strategy,
          rawConfig?.strategyOptions
        )

        if (processed.chunks.length > LARGE_DOC_CONFIG.MAX_CHUNKS_PER_DOCUMENT) {
          throw new Error(
            `Document has ${processed.chunks.length.toLocaleString()} chunks, exceeding maximum of ${LARGE_DOC_CONFIG.MAX_CHUNKS_PER_DOCUMENT.toLocaleString()}. ` +
              `This document is unusually large and may need to be split into multiple files or preprocessed to reduce content.`
          )
        }

        const now = new Date()

        logger.info(
          `[${documentId}] Document parsed successfully, generating embeddings for ${processed.chunks.length} chunks`
        )

        const chunkTexts = processed.chunks.map((chunk) => chunk.text)
        const embeddings: number[][] = []

        if (chunkTexts.length > 0) {
          /**
           * `executeWorkspaceEmbedding` now self-batches by provider token and
           * item caps, so this outer slice is only a memory/streaming
           * convenience — it bounds how many chunks we hold in flight, not the
           * request size. The token-cap safety is enforced inside the primitive.
           */
          const batchSize = LARGE_DOC_CONFIG.MAX_EMBEDDING_BATCH
          const totalBatches = Math.ceil(chunkTexts.length / batchSize)

          logger.info(`[${documentId}] Generating embeddings in ${totalBatches} batches`)

          for (let i = 0; i < chunkTexts.length; i += batchSize) {
            const batch = chunkTexts.slice(i, i + batchSize)
            const batchNum = Math.floor(i / batchSize) + 1

            logger.info(`[${documentId}] Processing embedding batch ${batchNum}/${totalBatches}`)
            const { embeddings: batchEmbeddings, usage } = await executeWorkspaceEmbedding({
              endpoint: embeddingEndpoint,
              input: batch,
              signal,
            })
            for (const emb of batchEmbeddings) {
              embeddings.push(emb)
            }
            totalEmbeddingTokens += usage?.totalTokens ?? 0
          }
        }

        logger.info(`[${documentId}] Embeddings generated, fetching document tags`)

        const documentRecord = await db
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
          .where(
            and(
              eq(document.id, documentId),
              isNull(document.archivedAt),
              isNull(document.deletedAt)
            )
          )
          .limit(1)

        const documentTags = documentRecord[0] || {}

        logger.info(`[${documentId}] Creating embedding records with tags`)

        const embeddingRecords = processed.chunks.map((chunk, chunkIndex) => ({
          id: generateId(),
          knowledgeBaseId,
          documentId,
          chunkIndex,
          chunkHash: crypto.createHash('sha256').update(chunk.text).digest('hex'),
          content: chunk.text,
          contentLength: chunk.text.length,
          tokenCount: Math.ceil(chunk.text.length / 4),
          embedding: embeddings[chunkIndex] || null,
          embeddingModel: embeddingModelName,
          startOffset: chunk.metadata.startIndex,
          endOffset: chunk.metadata.endIndex,
          tag1: documentTags.tag1,
          tag2: documentTags.tag2,
          tag3: documentTags.tag3,
          tag4: documentTags.tag4,
          tag5: documentTags.tag5,
          tag6: documentTags.tag6,
          tag7: documentTags.tag7,
          number1: documentTags.number1,
          number2: documentTags.number2,
          number3: documentTags.number3,
          number4: documentTags.number4,
          number5: documentTags.number5,
          date1: documentTags.date1,
          date2: documentTags.date2,
          boolean1: documentTags.boolean1,
          boolean2: documentTags.boolean2,
          boolean3: documentTags.boolean3,
          createdAt: now,
          updatedAt: now,
        }))

        await db.transaction(async (tx) => {
          const activeDocument = await tx
            .select({ id: document.id })
            .from(document)
            .innerJoin(knowledgeBase, eq(document.knowledgeBaseId, knowledgeBase.id))
            .where(
              and(
                eq(document.id, documentId),
                isNull(document.archivedAt),
                isNull(document.deletedAt),
                isNull(knowledgeBase.deletedAt)
              )
            )
            .limit(1)

          if (activeDocument.length === 0) {
            return
          }

          if (embeddingRecords.length > 0) {
            await tx.delete(embedding).where(eq(embedding.documentId, documentId))

            const insertBatchSize = LARGE_DOC_CONFIG.MAX_CHUNKS_PER_BATCH
            const batches: (typeof embeddingRecords)[] = []
            for (let i = 0; i < embeddingRecords.length; i += insertBatchSize) {
              batches.push(embeddingRecords.slice(i, i + insertBatchSize))
            }

            logger.info(`[${documentId}] Inserting ${embeddingRecords.length} embeddings`)
            for (const batch of batches) {
              await tx.insert(embedding).values(batch)
            }

            // lifted: `kbPartitionName` -> `kbPartitionRef`, which returns the qualified
            // `"search"."<table>"` identifier. The SQL below is otherwise byte-identical;
            // only the identifier token changed. See `kb/partition.ts` for why a bare name
            // is dangerous on a database shared with Studio.
            const partitionTable = kbPartitionRef(knowledgeBaseId)
            const partitionReady = await partitionExists(knowledgeBaseId, tx)
            if (!partitionReady) {
              const dim = embeddingEndpoint.dimensions ?? embeddings[0]?.length
              if (!Number.isInteger(dim) || (dim as number) < 1) {
                throw new Error(
                  `Cannot provision KB partition: invalid embedding dimensions ${String(dim)}`
                )
              }
              await provisionKbPartition({ kbId: knowledgeBaseId, dim: dim as number, tx })
            }

            const clusterRows = await tx
              .select({ clusterId: kbCluster.clusterId, centroid: kbCluster.centroid })
              .from(kbCluster)
              .where(eq(kbCluster.kbId, knowledgeBaseId))
            const centroids = clusterRows.map((c) => c.centroid as number[])
            const clusterIds = clusterRows.map((c) => c.clusterId)

            const existingResult = (await tx.execute(
              sql.raw(
                `SELECT count(*)::int AS c FROM ${partitionTable} WHERE document_id <> '${documentId.replace(/'/g, "''")}'`
              )
            )) as { rows?: Array<{ c: number }> } | Array<{ c: number }>
            const existingRows = Array.isArray(existingResult)
              ? existingResult
              : (existingResult.rows ?? [])
            const totalExistingOther = Number(existingRows[0]?.c ?? 0)
            const COLD_START_MIN = 50
            const useClusters = centroids.length > 0 && totalExistingOther >= COLD_START_MIN

            await tx.execute(
              sql`DELETE FROM ${sql.raw(partitionTable)} WHERE document_id = ${documentId}`
            )

            for (let i = 0; i < embeddingRecords.length; i++) {
              const rec = embeddingRecords[i]
              if (!rec.embedding) continue
              let clusterIdValue: number | null = null
              if (useClusters) {
                const idx = assignCluster(rec.embedding as number[], centroids)
                if (idx !== null && idx >= 0 && idx < clusterIds.length) {
                  clusterIdValue = clusterIds[idx]
                }
              }
              const embeddingLit = `[${(rec.embedding as number[]).join(',')}]`
              await tx.execute(sql`
                INSERT INTO ${sql.raw(partitionTable)}
                  (id, kb_id, document_id, chunk_index, content, cluster_id, metadata, embedding)
                VALUES (
                  ${rec.id},
                  ${knowledgeBaseId},
                  ${documentId},
                  ${rec.chunkIndex},
                  ${rec.content},
                  ${clusterIdValue},
                  '{}'::jsonb,
                  ${embeddingLit}::vector
                )
              `)
            }
            partitionInsertedCount = embeddingRecords.length
            _kbTotalAfterInsert = totalExistingOther + embeddingRecords.length
          }

          await tx
            .update(document)
            .set({
              chunkCount: processed.metadata.chunkCount,
              tokenCount: processed.metadata.tokenCount,
              characterCount: processed.metadata.characterCount,
              processingCompletedAt: null,
              processingError: null,
            })
            .where(eq(document.id, documentId))
        })
      })(),
      computeProcessingTimeoutMs(docData.fileSize),
      'Document processing'
    )

    const processingTime = Date.now() - startTime
    logger.info(`[${documentId}] Successfully processed document in ${processingTime}ms`)

    logger.info(`[${documentId}] BYOK embedding endpoint used; skipping platform billing`, {
      totalEmbeddingTokens,
      embeddingModelName,
    })

    if (partitionInsertedCount === 0) {
      await db
        .update(document)
        .set({ processingStatus: 'completed', processingCompletedAt: new Date() })
        .where(eq(document.id, documentId))
    }

    if (partitionInsertedCount > 0) {
      /**
       * Per-chunk keyword extraction is inline (no separate job). For each
       * chunk we extract → upsert kb_keyword → attach to chunk → increment
       * `processed_chunks` so the UI can render "Processing N/M". Earlier
       * chunks' keywords feed forward into later chunks' prompts to keep
       * the per-document vocabulary coherent. Keyword extraction is best-effort
       * enrichment: a chunk that yields no keywords (or a failed inference call,
       * e.g. a misconfigured endpoint) is skipped and the document still
       * completes as semantic-only, rather than failing the whole document.
       */
      if (inferenceEndpoint) {
        const chunkRows = await db
          .select({
            id: embedding.id,
            chunkIndex: embedding.chunkIndex,
            content: embedding.content,
          })
          .from(embedding)
          .where(and(eq(embedding.documentId, documentId), eq(embedding.enabled, true)))
          .orderBy(embedding.chunkIndex)

        const totalChunks = chunkRows.length
        if (totalChunks > 0) {
          const topKeywords = await listKbKeywords({
            kbId: knowledgeBaseId,
            limit: KEYWORD_VOCAB_HINT_LIMIT,
            sort: 'usage_desc',
          })
          const dictionary = new Map<string, string>()
          const accumulatedDisplay: string[] = []
          const accumulatedSeen = new Set<string>()
          for (const k of topKeywords) {
            dictionary.set(k.keyword, k.id)
            if (!accumulatedSeen.has(k.keyword)) {
              accumulatedSeen.add(k.keyword)
              accumulatedDisplay.push(k.displayLabel)
            }
          }

          let chunksWithKeywords = 0
          let lastKeywordError: string | undefined
          for (let i = 0; i < chunkRows.length; i++) {
            const chunk = chunkRows[i]
            let extracted: Awaited<ReturnType<typeof extractKeywordsForChunk>> = []
            try {
              extracted = await extractKeywordsForChunk({
                chunkText: chunk.content,
                filename: docData.filename,
                chunkIndex: chunk.chunkIndex,
                totalChunks,
                existingTopKeywords: accumulatedDisplay.slice(0, KEYWORD_VOCAB_HINT_LIMIT),
                workspaceId: kb[0].workspaceId ?? '',
                inferenceEndpointId: kb[0].inferenceEndpointId as string,
                endpoint: inferenceEndpoint,
              })
            } catch (keywordError) {
              /**
               * A credential/auth failure is document-wide — every remaining
               * chunk hits the identical 401. Rethrow so the outer catch fails
               * the document once instead of looping the doomed call per chunk.
               */
              if (keywordError instanceof KeywordInferenceFatalError) {
                throw keywordError
              }
              lastKeywordError =
                keywordError instanceof Error ? keywordError.message : String(keywordError)
              logger.warn(
                `[${documentId}] Keyword extraction threw for chunk ${chunk.chunkIndex}; continuing semantic-only`,
                { error: lastKeywordError }
              )
            }

            /**
             * Best-effort: a chunk that produced no keywords (empty result or a
             * failed inference call) is skipped, not fatal — the embeddings are
             * already persisted, so the document stays semantically searchable.
             */
            if (extracted.length === 0) {
              if (!lastKeywordError) {
                lastKeywordError = `Keyword extraction returned no keywords for chunk ${chunk.chunkIndex} of ${docData.filename}`
              }
              await db
                .update(document)
                .set({ processedChunks: i + 1 })
                .where(eq(document.id, documentId))
              continue
            }

            chunksWithKeywords += 1
            for (const { canonical, display } of extracted) {
              let kbKeywordId = dictionary.get(canonical)
              if (!kbKeywordId) {
                const row = await upsertKbKeyword({
                  kbId: knowledgeBaseId,
                  displayLabel: display,
                  createdByUserId: null,
                })
                if (!row) continue
                kbKeywordId = row.id
                dictionary.set(row.keyword, row.id)
              }
              await attachKeywordToChunk({
                embeddingId: chunk.id,
                kbKeywordId,
                source: 'llm',
              })
              if (!accumulatedSeen.has(canonical)) {
                accumulatedSeen.add(canonical)
                accumulatedDisplay.push(display)
              }
            }

            await db
              .update(document)
              .set({ processedChunks: i + 1 })
              .where(eq(document.id, documentId))
          }

          await recomputeDocumentKeywords({ documentId })
          /**
           * If no chunk yielded keywords (e.g. inference misconfigured / 401),
           * the document still completes as semantic-only. Surface the degraded
           * keyword state so it is visible and retryable — never a hard failure
           * that pulls an already-embedded document out of the KB.
           */
          await db
            .update(document)
            .set(
              chunksWithKeywords > 0
                ? { keywordStatus: 'extracted' }
                : {
                    keywordStatus: 'failed',
                    processingError: lastKeywordError ?? 'Keyword extraction produced no keywords',
                  }
            )
            .where(eq(document.id, documentId))
        }
      } else {
        /**
         * No inference endpoint configured: keywords are skipped entirely.
         * Treat all chunks as "processed" for the progress indicator so the
         * UI doesn't stall at 0/N.
         */
        await db
          .update(document)
          .set({
            processedChunks: partitionInsertedCount,
            keywordStatus: 'skipped:no-inference-endpoint',
          })
          .where(eq(document.id, documentId))
      }

      await db
        .update(document)
        .set({ processingStatus: 'completed', processingCompletedAt: new Date() })
        .where(eq(document.id, documentId))
      logger.info(`[${documentId}] Document completed`, {
        chunks: partitionInsertedCount,
        inference: inferenceEndpoint ? 'used' : 'skipped',
      })
    }
  } catch (error) {
    const processingTime = Date.now() - startTime
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    logger.error(`[${documentId}] Failed to process document after ${processingTime}ms:`, {
      error: errorMessage,
      stack: error instanceof Error ? error.stack : undefined,
      filename: docData.filename,
      fileUrl: docData.fileUrl,
      mimeType: docData.mimeType,
    })

    /**
     * Any failure mid-pipeline marks the doc `failed` and pulls it out of
     * the searchable set via `includedInKb = false`. Partially-inserted
     * chunks remain in the partition table but are invisible to queries
     * (semantic and keyword paths both gate on `included_in_kb`).
     */
    await db
      .update(document)
      .set({
        processingStatus: 'failed',
        processingError: errorMessage,
        processingCompletedAt: new Date(),
        includedInKb: false,
      })
      .where(eq(document.id, documentId))

    throw error
  }
}

export function isTriggerAvailable(): boolean {
  return false
}

export async function processDocumentsWithTrigger(
  documents: DocumentProcessingPayload[],
  requestId: string
): Promise<{ success: boolean; message: string; jobIds?: string[] }> {
  try {
    logger.info(`[${requestId}] Enqueuing background processing for ${documents.length} documents`)

    const queue = await getJobQueue()
    const jobs = documents.map((doc) => ({
      type: 'knowledge-process-document' as const,
      payload: doc,
      options: {
        tags: [`knowledgeBaseId:${doc.knowledgeBaseId}`, `documentId:${doc.documentId}`],
      },
    }))

    const jobIds = await queue.enqueueBulk(jobs)

    logger.info(
      `[${requestId}] Enqueued ${documents.length} document processing jobs (${jobIds.length} ids returned)`
    )

    return {
      success: true,
      message: `${documents.length} document processing jobs enqueued`,
      jobIds,
    }
  } catch (error) {
    logger.error(`[${requestId}] Failed to enqueue document processing jobs:`, error)

    return {
      success: false,
      message: error instanceof Error ? error.message : 'Failed to enqueue background jobs',
    }
  }
}

export async function createDocumentRecords(
  documents: Array<{
    filename: string
    fileUrl: string
    fileSize: number
    mimeType: string
    documentTagsData?: string
    tag1?: string
    tag2?: string
    tag3?: string
    tag4?: string
    tag5?: string
    tag6?: string
    tag7?: string
  }>,
  knowledgeBaseId: string,
  requestId: string
): Promise<DocumentData[]> {
  return await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT 1 FROM ${sql.raw(qualified('knowledge_base'))} WHERE id = ${knowledgeBaseId} FOR UPDATE`)

    const kb = await tx
      .select({ id: knowledgeBase.id })
      .from(knowledgeBase)
      .where(and(eq(knowledgeBase.id, knowledgeBaseId), isNull(knowledgeBase.deletedAt)))
      .limit(1)

    if (kb.length === 0) {
      throw new Error('Knowledge base not found')
    }

    const now = new Date()
    const documentRecords = []
    const returnData: DocumentData[] = []

    for (const docData of documents) {
      const documentId = generateId()

      let processedTags: Partial<ProcessedDocumentTags> = {}

      if (docData.documentTagsData) {
        try {
          const tagData = JSON.parse(docData.documentTagsData)
          if (Array.isArray(tagData)) {
            processedTags = await processDocumentTags(knowledgeBaseId, tagData, requestId)
          }
        } catch (error) {
          if (error instanceof SyntaxError) {
            logger.warn(`[${requestId}] Failed to parse documentTagsData for bulk document:`, error)
          } else {
            throw error
          }
        }
      }

      const newDocument = {
        id: documentId,
        knowledgeBaseId,
        filename: docData.filename,
        fileUrl: docData.fileUrl,
        fileSize: docData.fileSize,
        mimeType: docData.mimeType,
        chunkCount: 0,
        tokenCount: 0,
        characterCount: 0,
        processingStatus: 'pending' as const,
        enabled: true,
        /**
         * UI uploads are explicit "index this in the KB" intents, so flip
         * the v2 opt-in flag on at insert time. The toggle endpoint
         * (`PATCH /api/knowledge/[id]/documents/[documentId]/include`)
         * remains the way to opt out later.
         */
        includedInKb: true,
        uploadedAt: now,
        tag1: processedTags.tag1 ?? docData.tag1 ?? null,
        tag2: processedTags.tag2 ?? docData.tag2 ?? null,
        tag3: processedTags.tag3 ?? docData.tag3 ?? null,
        tag4: processedTags.tag4 ?? docData.tag4 ?? null,
        tag5: processedTags.tag5 ?? docData.tag5 ?? null,
        tag6: processedTags.tag6 ?? docData.tag6 ?? null,
        tag7: processedTags.tag7 ?? docData.tag7 ?? null,
        number1: processedTags.number1 ?? null,
        number2: processedTags.number2 ?? null,
        number3: processedTags.number3 ?? null,
        number4: processedTags.number4 ?? null,
        number5: processedTags.number5 ?? null,
        date1: processedTags.date1 ?? null,
        date2: processedTags.date2 ?? null,
        boolean1: processedTags.boolean1 ?? null,
        boolean2: processedTags.boolean2 ?? null,
        boolean3: processedTags.boolean3 ?? null,
      }

      documentRecords.push(newDocument)
      returnData.push({
        documentId,
        filename: docData.filename,
        fileUrl: docData.fileUrl,
        fileSize: docData.fileSize,
        mimeType: docData.mimeType,
      })
    }

    if (documentRecords.length > 0) {
      await tx.insert(document).values(documentRecords)
      logger.info(
        `[${requestId}] Bulk created ${documentRecords.length} document records in knowledge base ${knowledgeBaseId}`
      )

      await tx
        .update(knowledgeBase)
        .set({ updatedAt: now })
        .where(eq(knowledgeBase.id, knowledgeBaseId))
    }

    return returnData
  })
}

export interface TagFilterCondition {
  tagSlot: string
  fieldType: 'text' | 'number' | 'date' | 'boolean'
  operator: string
  value: string
  valueTo?: string
}

const ALLOWED_TAG_SLOTS = new Set([
  'tag1',
  'tag2',
  'tag3',
  'tag4',
  'tag5',
  'tag6',
  'tag7',
  'number1',
  'number2',
  'number3',
  'number4',
  'number5',
  'date1',
  'date2',
  'boolean1',
  'boolean2',
  'boolean3',
])

function escapeLikePattern(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
}

function buildTagFilterCondition(filter: TagFilterCondition): SQL | undefined {
  if (!ALLOWED_TAG_SLOTS.has(filter.tagSlot)) return undefined

  const col = document[filter.tagSlot as keyof typeof document]

  if (filter.fieldType === 'text') {
    const v = filter.value
    switch (filter.operator) {
      case 'eq':
        return eq(col as typeof document.tag1, v)
      case 'neq':
        return ne(col as typeof document.tag1, v)
      case 'contains': {
        const escaped = escapeLikePattern(v)
        return sql`LOWER(${col}) LIKE LOWER(${`%${escaped}%`}) ESCAPE '\\'`
      }
      case 'not_contains': {
        const escaped = escapeLikePattern(v)
        return sql`LOWER(${col}) NOT LIKE LOWER(${`%${escaped}%`}) ESCAPE '\\'`
      }
      case 'starts_with': {
        const escaped = escapeLikePattern(v)
        return sql`LOWER(${col}) LIKE LOWER(${`${escaped}%`}) ESCAPE '\\'`
      }
      case 'ends_with': {
        const escaped = escapeLikePattern(v)
        return sql`LOWER(${col}) LIKE LOWER(${`%${escaped}`}) ESCAPE '\\'`
      }
      default:
        return undefined
    }
  }

  if (filter.fieldType === 'number') {
    const num = Number(filter.value)
    if (Number.isNaN(num)) return undefined
    switch (filter.operator) {
      case 'eq':
        return eq(col as typeof document.number1, num)
      case 'neq':
        return ne(col as typeof document.number1, num)
      case 'gt':
        return gt(col as typeof document.number1, num)
      case 'gte':
        return gte(col as typeof document.number1, num)
      case 'lt':
        return lt(col as typeof document.number1, num)
      case 'lte':
        return lte(col as typeof document.number1, num)
      case 'between': {
        const numTo = Number(filter.valueTo)
        if (Number.isNaN(numTo)) return undefined
        return and(
          gte(col as typeof document.number1, num),
          lte(col as typeof document.number1, numTo)
        )
      }
      default:
        return undefined
    }
  }

  if (filter.fieldType === 'date') {
    const v = filter.value
    switch (filter.operator) {
      case 'eq':
        return eq(col as typeof document.date1, new Date(v))
      case 'neq':
        return ne(col as typeof document.date1, new Date(v))
      case 'gt':
        return gt(col as typeof document.date1, new Date(v))
      case 'gte':
        return gte(col as typeof document.date1, new Date(v))
      case 'lt':
        return lt(col as typeof document.date1, new Date(v))
      case 'lte':
        return lte(col as typeof document.date1, new Date(v))
      case 'between': {
        if (!filter.valueTo) return undefined
        return and(
          gte(col as typeof document.date1, new Date(v)),
          lte(col as typeof document.date1, new Date(filter.valueTo))
        )
      }
      default:
        return undefined
    }
  }

  if (filter.fieldType === 'boolean') {
    const boolVal = filter.value === 'true'
    switch (filter.operator) {
      case 'eq':
        return eq(col as typeof document.boolean1, boolVal)
      case 'neq':
        return ne(col as typeof document.boolean1, boolVal)
      default:
        return undefined
    }
  }

  return undefined
}

export async function getDocuments(
  knowledgeBaseId: string,
  options: {
    enabledFilter?: 'all' | 'enabled' | 'disabled'
    search?: string
    limit?: number
    offset?: number
    sortBy?: DocumentSortField
    sortOrder?: SortOrder
    tagFilters?: TagFilterCondition[]
  },
  requestId: string
): Promise<{
  documents: Array<{
    id: string
    filename: string
    fileUrl: string
    fileSize: number
    mimeType: string
    chunkCount: number
    tokenCount: number
    characterCount: number
    processingStatus: DocumentProcessingStatus
    processingStartedAt: Date | null
    processingCompletedAt: Date | null
    processingError: string | null
    enabled: boolean
    uploadedAt: Date
    tag1: string | null
    tag2: string | null
    tag3: string | null
    tag4: string | null
    tag5: string | null
    tag6: string | null
    tag7: string | null
    number1: number | null
    number2: number | null
    number3: number | null
    number4: number | null
    number5: number | null
    date1: Date | null
    date2: Date | null
    boolean1: boolean | null
    boolean2: boolean | null
    boolean3: boolean | null
    connectorId: string | null
    connectorType: string | null
    sourceUrl: string | null
  }>
  pagination: {
    total: number
    limit: number
    offset: number
    hasMore: boolean
  }
}> {
  const {
    enabledFilter = 'all',
    search,
    limit = 50,
    offset = 0,
    sortBy = 'filename',
    sortOrder = 'asc',
    tagFilters,
  } = options

  const whereConditions: (SQL | undefined)[] = [
    eq(document.knowledgeBaseId, knowledgeBaseId),
    eq(document.userExcluded, false),
    isNull(document.archivedAt),
    isNull(document.deletedAt),
  ]

  if (enabledFilter === 'enabled') {
    whereConditions.push(eq(document.enabled, true))
  } else if (enabledFilter === 'disabled') {
    whereConditions.push(eq(document.enabled, false))
  }

  if (search) {
    whereConditions.push(sql`LOWER(${document.filename}) LIKE LOWER(${`%${search}%`})`)
  }

  if (tagFilters && tagFilters.length > 0) {
    for (const filter of tagFilters) {
      const condition = buildTagFilterCondition(filter)
      if (condition) {
        whereConditions.push(condition)
      }
    }
  }

  const totalResult = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(document)
    .where(and(...whereConditions))

  const total = totalResult[0]?.count || 0
  const hasMore = offset + limit < total

  const getOrderByColumn = () => {
    switch (sortBy) {
      case 'filename':
        return document.filename
      case 'fileSize':
        return document.fileSize
      case 'tokenCount':
        return document.tokenCount
      case 'chunkCount':
        return document.chunkCount
      case 'uploadedAt':
        return document.uploadedAt
      case 'processingStatus':
        return document.processingStatus
      case 'enabled':
        return document.enabled
      default:
        return document.uploadedAt
    }
  }

  const primaryOrderBy = sortOrder === 'asc' ? asc(getOrderByColumn()) : desc(getOrderByColumn())
  const secondaryOrderBy =
    sortBy === 'filename' ? desc(document.uploadedAt) : asc(document.filename)

  const documents = await db
    .select({
      id: document.id,
      filename: document.filename,
      fileUrl: document.fileUrl,
      fileSize: document.fileSize,
      mimeType: document.mimeType,
      chunkCount: document.chunkCount,
      processedChunks: document.processedChunks,
      tokenCount: document.tokenCount,
      characterCount: document.characterCount,
      processingStatus: document.processingStatus,
      processingStartedAt: document.processingStartedAt,
      processingCompletedAt: document.processingCompletedAt,
      processingError: document.processingError,
      enabled: document.enabled,
      uploadedAt: document.uploadedAt,
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
      connectorId: document.connectorId,
      // lifted: was `knowledgeConnector.connectorType` through a LEFT JOIN.
      // `knowledge_connector` stays in Studio (ADR 0002) and `connector_id` is a
      // plain remote id here, so there is no row to join to. The column stays in
      // the response — a listing caller reads it — and is null, which is what the
      // join returned for a document no connector wrote.
      connectorType: sql<string | null>`NULL`,
      sourceUrl: document.sourceUrl,
    })
    .from(document)
    .where(and(...whereConditions))
    .orderBy(primaryOrderBy, secondaryOrderBy)
    .limit(limit)
    .offset(offset)

  logger.info(
    `[${requestId}] Retrieved ${documents.length} documents (${offset}-${offset + documents.length} of ${total}) for knowledge base ${knowledgeBaseId}`
  )

  return {
    documents: documents.map((doc) => ({
      id: doc.id,
      filename: doc.filename,
      fileUrl: doc.fileUrl,
      fileSize: doc.fileSize,
      mimeType: doc.mimeType,
      chunkCount: doc.chunkCount,
      processedChunks: doc.processedChunks,
      tokenCount: doc.tokenCount,
      characterCount: doc.characterCount,
      processingStatus: doc.processingStatus as DocumentProcessingStatus,
      processingStartedAt: doc.processingStartedAt,
      processingCompletedAt: doc.processingCompletedAt,
      processingError: doc.processingError,
      enabled: doc.enabled,
      uploadedAt: doc.uploadedAt,
      tag1: doc.tag1,
      tag2: doc.tag2,
      tag3: doc.tag3,
      tag4: doc.tag4,
      tag5: doc.tag5,
      tag6: doc.tag6,
      tag7: doc.tag7,
      number1: doc.number1,
      number2: doc.number2,
      number3: doc.number3,
      number4: doc.number4,
      number5: doc.number5,
      date1: doc.date1,
      date2: doc.date2,
      boolean1: doc.boolean1,
      boolean2: doc.boolean2,
      boolean3: doc.boolean3,
      connectorId: doc.connectorId,
      connectorType: doc.connectorType ?? null,
      sourceUrl: doc.sourceUrl,
    })),
    pagination: {
      total,
      limit,
      offset,
      hasMore,
    },
  }
}

export async function createSingleDocument(
  documentData: {
    filename: string
    fileUrl: string
    fileSize: number
    mimeType: string
    documentTagsData?: string
    tag1?: string
    tag2?: string
    tag3?: string
    tag4?: string
    tag5?: string
    tag6?: string
    tag7?: string
  },
  knowledgeBaseId: string,
  requestId: string
): Promise<{
  id: string
  knowledgeBaseId: string
  filename: string
  fileUrl: string
  fileSize: number
  mimeType: string
  chunkCount: number
  tokenCount: number
  characterCount: number
  enabled: boolean
  uploadedAt: Date
  tag1: string | null
  tag2: string | null
  tag3: string | null
  tag4: string | null
  tag5: string | null
  tag6: string | null
  tag7: string | null
}> {
  const documentId = generateId()
  const now = new Date()

  let processedTags: ProcessedDocumentTags = {
    tag1: documentData.tag1 ?? null,
    tag2: documentData.tag2 ?? null,
    tag3: documentData.tag3 ?? null,
    tag4: documentData.tag4 ?? null,
    tag5: documentData.tag5 ?? null,
    tag6: documentData.tag6 ?? null,
    tag7: documentData.tag7 ?? null,
    number1: null,
    number2: null,
    number3: null,
    number4: null,
    number5: null,
    date1: null,
    date2: null,
    boolean1: null,
    boolean2: null,
    boolean3: null,
  }

  if (documentData.documentTagsData) {
    try {
      const tagData = JSON.parse(documentData.documentTagsData)
      if (Array.isArray(tagData)) {
        processedTags = await processDocumentTags(knowledgeBaseId, tagData, requestId)
      }
    } catch (error) {
      if (error instanceof SyntaxError) {
        logger.warn(`[${requestId}] Failed to parse documentTagsData:`, error)
      } else {
        throw error
      }
    }
  }

  const newDocument = {
    id: documentId,
    knowledgeBaseId,
    filename: documentData.filename,
    fileUrl: documentData.fileUrl,
    fileSize: documentData.fileSize,
    mimeType: documentData.mimeType,
    chunkCount: 0,
    tokenCount: 0,
    characterCount: 0,
    enabled: true,
    /**
     * Single-doc upload path: same v2 opt-in default as the bulk path —
     * an explicit upload means "index this".
     */
    includedInKb: true,
    uploadedAt: now,
    ...processedTags,
  }

  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT 1 FROM ${sql.raw(qualified('knowledge_base'))} WHERE id = ${knowledgeBaseId} FOR UPDATE`)

    const kb = await tx
      .select({ id: knowledgeBase.id })
      .from(knowledgeBase)
      .where(and(eq(knowledgeBase.id, knowledgeBaseId), isNull(knowledgeBase.deletedAt)))
      .limit(1)

    if (kb.length === 0) {
      throw new Error('Knowledge base not found')
    }

    await tx.insert(document).values(newDocument)

    await tx
      .update(knowledgeBase)
      .set({ updatedAt: now })
      .where(eq(knowledgeBase.id, knowledgeBaseId))
  })
  logger.info(`[${requestId}] Document created: ${documentId} in knowledge base ${knowledgeBaseId}`)

  return newDocument as {
    id: string
    knowledgeBaseId: string
    filename: string
    fileUrl: string
    fileSize: number
    mimeType: string
    chunkCount: number
    tokenCount: number
    characterCount: number
    enabled: boolean
    uploadedAt: Date
    tag1: string | null
    tag2: string | null
    tag3: string | null
    tag4: string | null
    tag5: string | null
    tag6: string | null
    tag7: string | null
  }
}

export async function bulkDocumentOperation(
  knowledgeBaseId: string,
  operation: 'enable' | 'disable' | 'delete',
  documentIds: string[],
  requestId: string
): Promise<{
  success: boolean
  successCount: number
  updatedDocuments: Array<{
    id: string
    enabled?: boolean
    deletedAt?: Date | null
    processingStatus?: string
  }>
}> {
  logger.info(
    `[${requestId}] Starting bulk ${operation} operation on ${documentIds.length} documents in knowledge base ${knowledgeBaseId}`
  )

  const documentsToUpdate = await db
    .select({
      id: document.id,
      enabled: document.enabled,
    })
    .from(document)
    .where(
      and(
        eq(document.knowledgeBaseId, knowledgeBaseId),
        inArray(document.id, documentIds),
        eq(document.userExcluded, false),
        isNull(document.archivedAt),
        isNull(document.deletedAt)
      )
    )

  if (documentsToUpdate.length === 0) {
    throw new Error('No valid documents found to update')
  }

  if (documentsToUpdate.length !== documentIds.length) {
    logger.warn(
      `[${requestId}] Some documents not found or don't belong to knowledge base. Requested: ${documentIds.length}, Found: ${documentsToUpdate.length}`
    )
  }

  let updateResult: Array<{
    id: string
    enabled?: boolean
    deletedAt?: Date | null
    processingStatus?: string
  }>

  if (operation === 'delete') {
    const deletedIds = documentsToUpdate.map((doc) => doc.id)
    const deletedCount = await deleteDocumentsByLifecyclePolicy(deletedIds, requestId)
    updateResult = deletedIds.slice(0, deletedCount).map((id) => ({ id }))
  } else {
    const enabled = operation === 'enable'

    updateResult = await db
      .update(document)
      .set({
        enabled,
      })
      .where(
        and(
          eq(document.knowledgeBaseId, knowledgeBaseId),
          inArray(document.id, documentIds),
          eq(document.userExcluded, false),
          isNull(document.archivedAt),
          isNull(document.deletedAt)
        )
      )
      .returning({ id: document.id, enabled: document.enabled })
  }

  const successCount = updateResult.length

  logger.info(
    `[${requestId}] Bulk ${operation} operation completed: ${successCount} documents updated in knowledge base ${knowledgeBaseId}`
  )

  return {
    success: true,
    successCount,
    updatedDocuments: updateResult,
  }
}

export async function bulkDocumentOperationByFilter(
  knowledgeBaseId: string,
  operation: 'enable' | 'disable' | 'delete',
  enabledFilter: 'all' | 'enabled' | 'disabled' | undefined,
  requestId: string
): Promise<{
  success: boolean
  successCount: number
  updatedDocuments: Array<{
    id: string
    enabled?: boolean
    deletedAt?: Date | null
  }>
}> {
  logger.info(
    `[${requestId}] Starting bulk ${operation} operation on all documents (filter: ${enabledFilter || 'all'}) in knowledge base ${knowledgeBaseId}`
  )

  const whereConditions = [
    eq(document.knowledgeBaseId, knowledgeBaseId),
    eq(document.userExcluded, false),
    isNull(document.archivedAt),
    isNull(document.deletedAt),
  ]

  if (enabledFilter === 'enabled') {
    whereConditions.push(eq(document.enabled, true))
  } else if (enabledFilter === 'disabled') {
    whereConditions.push(eq(document.enabled, false))
  }

  let updateResult: Array<{
    id: string
    enabled?: boolean
    deletedAt?: Date | null
  }>

  if (operation === 'delete') {
    const matchingDocs = await db
      .select({ id: document.id })
      .from(document)
      .where(and(...whereConditions))

    const deletedIds = matchingDocs.map((doc) => doc.id)
    const deletedCount = await deleteDocumentsByLifecyclePolicy(deletedIds, requestId)
    updateResult = deletedIds.slice(0, deletedCount).map((id) => ({ id }))
  } else {
    const enabled = operation === 'enable'

    updateResult = await db
      .update(document)
      .set({
        enabled,
      })
      .where(and(...whereConditions))
      .returning({ id: document.id, enabled: document.enabled })
  }

  const successCount = updateResult.length

  logger.info(
    `[${requestId}] Bulk ${operation} by filter completed: ${successCount} documents updated in knowledge base ${knowledgeBaseId}`
  )

  return {
    success: true,
    successCount,
    updatedDocuments: updateResult,
  }
}

export async function markDocumentAsFailedTimeout(
  documentId: string,
  processingStartedAt: Date,
  requestId: string
): Promise<{ success: boolean; processingDuration: number }> {
  const now = new Date()
  const processingDuration = now.getTime() - processingStartedAt.getTime()

  /**
   * The wall is phase-aware, not a flat 10 minutes. A large document
   * legitimately progresses through chunking → embedding (one round-trip per
   * batch) → keywording (one LLM call per chunk), all measured from a single
   * `processingStartedAt` that never advances across phases. A flat budget
   * therefore kills healthy large files mid-flight. We grant the same
   * window the timeout sweep uses: chunk-count-scaled while keywording (where
   * cost grows with chunk count, not bytes), size-scaled otherwise.
   */
  const [docRow] = await db
    .select({
      fileSize: document.fileSize,
      chunkCount: document.chunkCount,
      processingStatus: document.processingStatus,
    })
    .from(document)
    .where(eq(document.id, documentId))
    .limit(1)
  const deadProcessWindowMs = computeDeadProcessWindowMs({
    status: docRow?.processingStatus,
    fileSize: docRow?.fileSize,
    chunkCount: docRow?.chunkCount,
  })

  if (processingDuration <= deadProcessWindowMs) {
    throw new Error('Document has not been processing long enough to be considered dead')
  }

  await db
    .update(document)
    .set({
      processingStatus: 'failed',
      processingError: 'Processing timed out. Please retry or re-sync the connector.',
      processingCompletedAt: now,
    })
    .where(
      and(
        eq(document.id, documentId),
        inArray(document.processingStatus, NON_TERMINAL_PROCESSING_STATUSES)
      )
    )

  logger.info(
    `[${requestId}] Marked document ${documentId} as failed due to dead process (processing time: ${Math.round(processingDuration / 1000)}s)`
  )

  return {
    success: true,
    processingDuration,
  }
}

export async function retryDocumentProcessing(
  knowledgeBaseId: string,
  documentId: string,
  docData: {
    filename: string
    fileUrl: string
    fileSize: number
    mimeType: string
  },
  requestId: string
): Promise<{ success: boolean; status: string; message: string }> {
  await db.transaction(async (tx) => {
    await tx.delete(embedding).where(eq(embedding.documentId, documentId))

    const partitionTable = kbPartitionRef(knowledgeBaseId)
    if (await partitionExists(knowledgeBaseId, tx)) {
      await tx.execute(
        sql`DELETE FROM ${sql.raw(partitionTable)} WHERE document_id = ${documentId}`
      )
    }

    await tx
      .update(document)
      .set({
        processingStatus: 'pending',
        processingStartedAt: null,
        processingCompletedAt: null,
        processingError: null,
        keywordStatus: null,
        chunkCount: 0,
        tokenCount: 0,
        characterCount: 0,
      })
      .where(eq(document.id, documentId))
  })

  await processDocumentsWithQueue(
    [
      {
        documentId,
        filename: docData.filename,
        fileUrl: docData.fileUrl,
        fileSize: docData.fileSize,
        mimeType: docData.mimeType,
      },
    ],
    knowledgeBaseId,
    {},
    requestId
  )

  logger.info(`[${requestId}] Document retry initiated: ${documentId}`)

  return {
    success: true,
    status: 'pending',
    message: 'Document retry processing started',
  }
}

export async function updateDocument(
  documentId: string,
  updateData: {
    filename?: string
    enabled?: boolean
    chunkCount?: number
    tokenCount?: number
    characterCount?: number
    processingStatus?: DocumentProcessingStatus
    processingError?: string
    tag1?: string
    tag2?: string
    tag3?: string
    tag4?: string
    tag5?: string
    tag6?: string
    tag7?: string
    number1?: string
    number2?: string
    number3?: string
    number4?: string
    number5?: string
    date1?: string
    date2?: string
    boolean1?: string
    boolean2?: string
    boolean3?: string
  },
  requestId: string
): Promise<{
  id: string
  knowledgeBaseId: string
  filename: string
  fileUrl: string
  fileSize: number
  mimeType: string
  chunkCount: number
  // lifted: absent from the declared return type while the body has always
  // returned it — latent, because Studio does not type-check this program
  // repo-wide. Declared rather than dropped: the UI's "Processing N/M" reads it.
  processedChunks: number
  tokenCount: number
  characterCount: number
  processingStatus: DocumentProcessingStatus
  processingStartedAt: Date | null
  processingCompletedAt: Date | null
  processingError: string | null
  enabled: boolean
  uploadedAt: Date
  tag1: string | null
  tag2: string | null
  tag3: string | null
  tag4: string | null
  tag5: string | null
  tag6: string | null
  tag7: string | null
  number1: number | null
  number2: number | null
  number3: number | null
  number4: number | null
  number5: number | null
  date1: Date | null
  date2: Date | null
  boolean1: boolean | null
  boolean2: boolean | null
  boolean3: boolean | null
  deletedAt: Date | null
}> {
  const dbUpdateData: Partial<{
    filename: string
    enabled: boolean
    chunkCount: number
    tokenCount: number
    characterCount: number
    processingStatus: DocumentProcessingStatus
    processingError: string | null
    processingStartedAt: Date | null
    processingCompletedAt: Date | null
    tag1: string | null
    tag2: string | null
    tag3: string | null
    tag4: string | null
    tag5: string | null
    tag6: string | null
    tag7: string | null
    number1: number | null
    number2: number | null
    number3: number | null
    number4: number | null
    number5: number | null
    date1: Date | null
    date2: Date | null
    boolean1: boolean | null
    boolean2: boolean | null
    boolean3: boolean | null
  }> = {}
  const ALL_TAG_SLOTS = [
    'tag1',
    'tag2',
    'tag3',
    'tag4',
    'tag5',
    'tag6',
    'tag7',
    'number1',
    'number2',
    'number3',
    'number4',
    'number5',
    'date1',
    'date2',
    'boolean1',
    'boolean2',
    'boolean3',
  ] as const
  type TagSlot = (typeof ALL_TAG_SLOTS)[number]

  if (updateData.filename !== undefined) dbUpdateData.filename = updateData.filename
  if (updateData.enabled !== undefined) dbUpdateData.enabled = updateData.enabled
  if (updateData.chunkCount !== undefined) dbUpdateData.chunkCount = updateData.chunkCount
  if (updateData.tokenCount !== undefined) dbUpdateData.tokenCount = updateData.tokenCount
  if (updateData.characterCount !== undefined)
    dbUpdateData.characterCount = updateData.characterCount
  if (updateData.processingStatus !== undefined)
    dbUpdateData.processingStatus = updateData.processingStatus
  if (updateData.processingError !== undefined)
    dbUpdateData.processingError = updateData.processingError

  const convertTagValue = (
    slot: string,
    value: string | undefined
  ): string | number | Date | boolean | null => {
    if (value === undefined || value === '') return null

    if (slot.startsWith('number')) {
      return parseNumberValue(value)
    }

    if (slot.startsWith('date')) {
      return parseDateValue(value)
    }

    if (slot.startsWith('boolean')) {
      return parseBooleanValue(value) ?? false
    }

    return value || null
  }

  type UpdateDataWithTags = typeof updateData & Record<TagSlot, string | undefined>
  const typedUpdateData = updateData as UpdateDataWithTags

  ALL_TAG_SLOTS.forEach((slot: TagSlot) => {
    const updateValue = typedUpdateData[slot]
    if (updateValue !== undefined) {
      ;(dbUpdateData as Record<TagSlot, string | number | Date | boolean | null>)[slot] =
        convertTagValue(slot, updateValue)
    }
  })

  await db.transaction(async (tx) => {
    await tx.update(document).set(dbUpdateData).where(eq(document.id, documentId))

    const hasTagUpdates = ALL_TAG_SLOTS.some((field) => typedUpdateData[field] !== undefined)

    if (hasTagUpdates) {
      const embeddingUpdateData: Partial<ProcessedDocumentTags> = {}
      ALL_TAG_SLOTS.forEach((field) => {
        if (typedUpdateData[field] !== undefined) {
          ;(embeddingUpdateData as Record<TagSlot, string | number | Date | boolean | null>)[
            field
          ] = convertTagValue(field, typedUpdateData[field])
        }
      })

      await tx
        .update(embedding)
        .set(embeddingUpdateData)
        .where(eq(embedding.documentId, documentId))
    }
  })

  const updatedDocument = await db
    .select()
    .from(document)
    .where(eq(document.id, documentId))
    .limit(1)

  if (updatedDocument.length === 0) {
    throw new Error(`Document ${documentId} not found`)
  }

  logger.info(`[${requestId}] Document updated: ${documentId}`)

  const doc = updatedDocument[0]
  return {
    id: doc.id,
    knowledgeBaseId: doc.knowledgeBaseId,
    filename: doc.filename,
    fileUrl: doc.fileUrl,
    fileSize: doc.fileSize,
    mimeType: doc.mimeType,
    chunkCount: doc.chunkCount,
    processedChunks: doc.processedChunks,
    tokenCount: doc.tokenCount,
    characterCount: doc.characterCount,
    processingStatus: doc.processingStatus as DocumentProcessingStatus,
    processingStartedAt: doc.processingStartedAt,
    processingCompletedAt: doc.processingCompletedAt,
    processingError: doc.processingError,
    enabled: doc.enabled,
    uploadedAt: doc.uploadedAt,
    tag1: doc.tag1,
    tag2: doc.tag2,
    tag3: doc.tag3,
    tag4: doc.tag4,
    tag5: doc.tag5,
    tag6: doc.tag6,
    tag7: doc.tag7,
    number1: doc.number1,
    number2: doc.number2,
    number3: doc.number3,
    number4: doc.number4,
    number5: doc.number5,
    date1: doc.date1,
    date2: doc.date2,
    boolean1: doc.boolean1,
    boolean2: doc.boolean2,
    boolean3: doc.boolean3,
    deletedAt: doc.deletedAt,
  }
}

function getKnowledgeBaseStorageKey(fileUrl: string | null): string | null {
  if (!fileUrl) {
    return null
  }

  try {
    const urlPath = new URL(fileUrl, 'http://localhost').pathname
    const storageKey = extractStorageKey(urlPath)
    return storageKey !== urlPath ? storageKey : null
  } catch {
    return null
  }
}

export async function deleteDocumentStorageFiles(
  documentsToDelete: Array<{ id: string; fileUrl: string | null }>,
  requestId: string
): Promise<void> {
  await Promise.allSettled(
    documentsToDelete.map(async (doc) => {
      const storageKey = getKnowledgeBaseStorageKey(doc.fileUrl)
      if (!storageKey) {
        return
      }

      try {
        await deleteFile({ key: storageKey, context: 'knowledge-base' })
      } catch (error) {
        logger.warn(`[${requestId}] Failed to delete document storage file`, {
          documentId: doc.id,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    })
  )
}

async function excludeConnectorDocuments(
  documentIds: string[],
  requestId: string
): Promise<number> {
  const ids = [...new Set(documentIds)]
  if (ids.length === 0) {
    return 0
  }

  const updated = await db
    .update(document)
    .set({
      userExcluded: true,
      enabled: false,
    })
    .where(and(inArray(document.id, ids), isNotNull(document.connectorId)))
    .returning({ id: document.id })

  if (updated.length > 0) {
    logger.info(`[${requestId}] Excluded ${updated.length} connector-backed document(s)`, {
      documentIds: updated.map((doc) => doc.id),
    })
  }

  return updated.length
}

export async function deleteDocumentsByLifecyclePolicy(
  documentIds: string[],
  requestId: string
): Promise<number> {
  const ids = [...new Set(documentIds)]
  if (ids.length === 0) {
    return 0
  }

  const docs = await db
    .select({
      id: document.id,
      connectorId: document.connectorId,
    })
    .from(document)
    .where(inArray(document.id, ids))

  const connectorBackedIds = docs.filter((doc) => doc.connectorId !== null).map((doc) => doc.id)
  const hardDeleteIds = docs.filter((doc) => doc.connectorId === null).map((doc) => doc.id)

  const [excludedCount, hardDeletedCount] = await Promise.all([
    excludeConnectorDocuments(connectorBackedIds, requestId),
    hardDeleteDocuments(hardDeleteIds, requestId),
  ])

  return excludedCount + hardDeletedCount
}

export async function hardDeleteDocuments(
  documentIds: string[],
  requestId: string
): Promise<number> {
  const ids = [...new Set(documentIds)]
  if (ids.length === 0) {
    return 0
  }

  const documentsToDelete = await db
    .select({
      id: document.id,
      fileUrl: document.fileUrl,
      knowledgeBaseId: document.knowledgeBaseId,
    })
    .from(document)
    .where(inArray(document.id, ids))

  if (documentsToDelete.length === 0) {
    return 0
  }

  const existingIds = documentsToDelete.map((doc) => doc.id)

  /**
   * Group the surviving document ids by their KB so each per-KB embedding
   * partition (`kb_embedding_<hash>`) can be cleaned in a single statement.
   * A delete batch may span multiple KBs, so we cannot assume one partition.
   */
  const idsByKb = new Map<string, string[]>()
  for (const doc of documentsToDelete) {
    const bucket = idsByKb.get(doc.knowledgeBaseId)
    if (bucket) {
      bucket.push(doc.id)
    } else {
      idsByKb.set(doc.knowledgeBaseId, [doc.id])
    }
  }

  await db.transaction(async (tx) => {
    await tx.delete(embedding).where(inArray(embedding.documentId, existingIds))

    /**
     * The per-KB partition is the search source of truth — deleting the
     * `embedding`/`document` rows alone leaves orphaned vectors that still
     * match queries. Remove the partition rows for each KB, skipping any KB
     * whose partition has not been provisioned yet.
     */
    for (const [kbId, kbDocumentIds] of idsByKb) {
      if (!(await partitionExists(kbId, tx))) {
        continue
      }
      const partitionTable = kbPartitionRef(kbId)
      const idPlaceholders = sql.join(
        kbDocumentIds.map((id) => sql`${id}`),
        sql`, `
      )
      await tx.execute(
        sql`DELETE FROM ${sql.raw(partitionTable)} WHERE document_id IN (${idPlaceholders})`
      )
    }

    await tx.delete(document).where(inArray(document.id, existingIds))
  })

  await deleteDocumentStorageFiles(documentsToDelete, requestId)

  logger.info(`[${requestId}] Hard deleted ${existingIds.length} documents`, {
    documentIds: existingIds,
  })

  return existingIds.length
}

export async function deleteDocument(
  documentId: string,
  requestId: string
): Promise<{ success: boolean; message: string }> {
  await deleteDocumentsByLifecyclePolicy([documentId], requestId)

  return {
    success: true,
    message: 'Document deleted successfully',
  }
}
