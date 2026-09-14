/**
 * Background job: extract KB keywords for every chunk of a document (T3).
 *
 * Enqueued from `lib/kb/ingest.ts` at the end of chunk embedding and from
 * `POST /api/knowledge/[id]/extract-keywords`. Reads the KB's inference
 * endpoint, walks the document's enabled chunks, runs
 * {@link extractKeywordsForChunk} on each, then upserts + attaches keyword
 * rows and finally re-aggregates `document_keyword`.
 */

import { db } from '../../db/client.ts'
import { document, embedding, knowledgeBase } from '../../db/schema.ts'
import { createLogger } from '@actana/search-shared/log'
import { and, eq } from 'drizzle-orm'
import { maybeEnqueueClusteringIfDrained } from '../clustering-trigger.ts'
import {
  attachKeywordToChunk,
  extractKeywordsForChunk,
  KB_KEYWORDS_EXTRACT_JOB_NAME,
  type KbKeywordRow,
  KeywordInferenceFatalError,
  listKbKeywords,
  recomputeDocumentKeywords,
  upsertKbKeyword,
} from '../keywords/index.ts'
import { resolveKbInferenceEndpoint } from '../provider-context.ts'

const logger = createLogger('kb/jobs/keywords-extract')

/** Canonical BullMQ job name. Re-exported for convenience. */
export const keywordsExtractJobName = KB_KEYWORDS_EXTRACT_JOB_NAME

/** Top-N existing keywords surfaced to the prompt per chunk. */
const TOP_KEYWORDS_HINT_LIMIT = 100

/**
 * Consecutive hard-failure (auth/crash) chunks that fail the whole document.
 *
 * An empty model result is acceptable (the chunk simply has no keywords). A
 * thrown inference call is a hard failure; this many in a row is read as
 * document-wide breakage (e.g. a bad API key hitting every chunk) and fails the
 * document rather than hammering a doomed endpoint for every remaining chunk. A
 * single successful call (even one returning no keywords) resets the streak.
 */
const MAX_CONSECUTIVE_KEYWORD_FAILURES = 3

/** Payload accepted by {@link handleKeywordsExtract}. */
export interface KeywordsExtractPayload {
  documentId: string
  knowledgeBaseId: string
  requestedByUserId?: string
}

/**
 * Possible terminal values written to `document.keyword_status` by the
 * worker. The `'pending'` value is reserved for the enqueue path.
 */
export type DocumentKeywordStatus =
  | 'pending'
  | 'extracted'
  | 'skipped:no-inference-endpoint'
  | 'failed'

/**
 * Handler entry point. Per-chunk failures are logged but never fail the
 * job — the job succeeds as long as at least one chunk produced
 * keywords, otherwise it lands as `'failed'`.
 */
export async function handleKeywordsExtract(payload: KeywordsExtractPayload): Promise<void> {
  const { documentId, knowledgeBaseId } = payload

  const [doc] = await db
    .select()
    .from(document)
    .where(and(eq(document.id, documentId), eq(document.knowledgeBaseId, knowledgeBaseId)))
    .limit(1)
  if (!doc) {
    logger.warn('keywords-extract: document not found', { documentId, knowledgeBaseId })
    return
  }

  const [kb] = await db
    .select()
    .from(knowledgeBase)
    .where(eq(knowledgeBase.id, knowledgeBaseId))
    .limit(1)
  if (!kb) {
    logger.warn('keywords-extract: kb not found', { documentId, knowledgeBaseId })
    return
  }

  await setDocumentProcessingStatus(documentId, 'keywording')
  /** Restart the progress counter for the keywording phase (0 → chunkCount). */
  await db.update(document).set({ processedChunks: 0 }).where(eq(document.id, documentId))

  if (!kb.inferenceEndpointId) {
    await setDocumentStatus(documentId, 'skipped:no-inference-endpoint')
    await setDocumentProcessingStatus(documentId, 'completed', { completedAt: new Date() })
    logger.info('keywords-extract: no inference endpoint configured', {
      documentId,
      knowledgeBaseId,
    })
    await runClusteringDrainCheck(documentId, knowledgeBaseId)
    return
  }

  let resolvedEndpoint
  try {
    resolvedEndpoint = await resolveKbInferenceEndpoint(kb.inferenceEndpointId)
  } catch (err) {
    await setDocumentStatus(documentId, 'skipped:no-inference-endpoint')
    await setDocumentProcessingStatus(documentId, 'completed', { completedAt: new Date() })
    logger.info('keywords-extract: failed to resolve inference endpoint', {
      documentId,
      knowledgeBaseId,
      err: err instanceof Error ? err.message : String(err),
    })
    await runClusteringDrainCheck(documentId, knowledgeBaseId)
    return
  }

  const chunks = await db
    .select({
      id: embedding.id,
      chunkIndex: embedding.chunkIndex,
      content: embedding.content,
    })
    .from(embedding)
    .where(and(eq(embedding.documentId, documentId), eq(embedding.enabled, true)))
    .orderBy(embedding.chunkIndex)

  if (chunks.length === 0) {
    await setDocumentStatus(documentId, 'extracted')
    await setDocumentProcessingStatus(documentId, 'completed', { completedAt: new Date() })
    logger.info('keywords-extract: no enabled chunks', { documentId, knowledgeBaseId })
    await runClusteringDrainCheck(documentId, knowledgeBaseId)
    return
  }

  const topKeywords: KbKeywordRow[] = await listKbKeywords({
    kbId: knowledgeBaseId,
    limit: TOP_KEYWORDS_HINT_LIMIT,
    sort: 'usage_desc',
  })
  /** In-memory cache of canonical → row id to avoid re-querying per chunk. */
  const dictionary = new Map<string, string>()
  for (const k of topKeywords) dictionary.set(k.keyword, k.id)

  /**
   * Running list of `display` labels passed into each chunk's prompt as
   * `existingTopKeywords`. Seeded with the KB-wide top-N and grown with
   * every successful chunk so later chunks see the keywords picked by
   * earlier ones — keeping the per-document vocabulary coherent.
   */
  const accumulatedDisplay: string[] = []
  /** Canonical-form guard against duplicate entries in `accumulatedDisplay`. */
  const accumulatedSeen = new Set<string>()
  for (const k of topKeywords) {
    if (!accumulatedSeen.has(k.keyword)) {
      accumulatedSeen.add(k.keyword)
      accumulatedDisplay.push(k.displayLabel)
    }
  }

  const filename = doc.filename || doc.id
  const totalChunks = chunks.length

  let succeeded = 0
  /** Chunks where the call completed but returned no keywords — acceptable. */
  let emptyResults = 0
  /** Total chunks whose inference call threw (auth/crash/etc.). */
  let hardErrored = 0
  /** Thrown failures in a row; reset by any completed call (even an empty one). */
  let consecutiveFailures = 0
  let lastHardError: string | undefined
  /** Set once {@link MAX_CONSECUTIVE_KEYWORD_FAILURES} is reached. */
  let abortedOnFailures = false

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]
    let extracted: Awaited<ReturnType<typeof extractKeywordsForChunk>>
    try {
      extracted = await extractKeywordsForChunk({
        chunkText: chunk.content,
        filename,
        chunkIndex: chunk.chunkIndex,
        totalChunks,
        existingTopKeywords: accumulatedDisplay.slice(0, TOP_KEYWORDS_HINT_LIMIT),
        workspaceId: kb.pairedClientId ?? '',
        inferenceEndpointId: kb.inferenceEndpointId,
        endpoint: resolvedEndpoint,
      })
    } catch (err) {
      hardErrored += 1
      consecutiveFailures += 1
      lastHardError = err instanceof Error ? err.message : String(err)
      const fatal = err instanceof KeywordInferenceFatalError
      logger[fatal ? 'error' : 'warn']('keywords-extract: chunk inference failed', {
        documentId,
        chunkId: chunk.id,
        chunkIndex: chunk.chunkIndex,
        consecutiveFailures,
        fatal,
        err: lastHardError,
      })
      if (consecutiveFailures >= MAX_CONSECUTIVE_KEYWORD_FAILURES) {
        abortedOnFailures = true
        break
      }
      await bumpKeywordProgress(documentId, i + 1)
      continue
    }

    /** A completed call clears the failure streak, keywords or not. */
    consecutiveFailures = 0

    if (extracted.length === 0) {
      emptyResults += 1
      await bumpKeywordProgress(documentId, i + 1)
      continue
    }

    for (const { canonical, display } of extracted) {
      let kbKeywordId = dictionary.get(canonical)
      if (!kbKeywordId) {
        const row = await upsertKbKeyword({
          kbId: knowledgeBaseId,
          displayLabel: display,
          createdByUserId: payload.requestedByUserId ?? null,
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
    succeeded += 1
    await bumpKeywordProgress(documentId, i + 1)
  }

  if (abortedOnFailures) {
    await setDocumentStatus(documentId, 'failed')
    await setDocumentProcessingStatus(documentId, 'failed', {
      completedAt: new Date(),
      processingError: `Keyword extraction failed: ${MAX_CONSECUTIVE_KEYWORD_FAILURES} consecutive chunks errored (${lastHardError ?? 'unknown error'}). Check the inference endpoint API key, then retry.`,
    })
    await runClusteringDrainCheck(documentId, knowledgeBaseId)
    return
  }

  try {
    await recomputeDocumentKeywords({ documentId })
  } catch (err) {
    logger.warn('keywords-extract: rollup failed', {
      documentId,
      err: err instanceof Error ? err.message : String(err),
    })
  }

  /**
   * Reaching here means no document-wide breakage: keywords were extracted for
   * some chunks and/or other chunks legitimately had none. Either way the
   * document keyworded successfully. Scattered (non-consecutive) hard errors are
   * surfaced as a non-fatal note so the UI can offer a re-run, but they never
   * fail an otherwise-searchable document.
   */
  const finalStatus: DocumentKeywordStatus = 'extracted'
  await setDocumentStatus(documentId, finalStatus)

  await setDocumentProcessingStatus(documentId, 'completed', {
    completedAt: new Date(),
    processingError:
      hardErrored > 0
        ? `Keyword extraction skipped ${hardErrored} chunk(s) due to inference errors; the document is searchable. Retry extraction to fill them in.`
        : null,
  })

  logger.info('keywords-extract: completed', {
    documentId,
    knowledgeBaseId,
    totalChunks,
    succeeded,
    emptyResults,
    hardErrored,
    status: finalStatus,
  })

  await runClusteringDrainCheck(documentId, knowledgeBaseId)
}

/**
 * Clustering is gated on the per-KB ingestion queue draining; every
 * code path that transitions a doc into terminal state must call this
 * so the last doc out of the gate triggers the clustering job.
 */
async function runClusteringDrainCheck(documentId: string, knowledgeBaseId: string): Promise<void> {
  try {
    await maybeEnqueueClusteringIfDrained(knowledgeBaseId)
  } catch (err) {
    logger.warn('keywords-extract: clustering-drain check failed', {
      documentId,
      knowledgeBaseId,
      err: err instanceof Error ? err.message : String(err),
    })
  }
}

/**
 * Advance the keywording-phase progress counter (`document.processed_chunks`),
 * which the UI renders as "Keywording N/M". Reset to 0 when the phase begins.
 */
async function bumpKeywordProgress(documentId: string, processed: number): Promise<void> {
  await db.update(document).set({ processedChunks: processed }).where(eq(document.id, documentId))
}

/** Persist the terminal `document.keyword_status` value. */
async function setDocumentStatus(documentId: string, status: DocumentKeywordStatus): Promise<void> {
  await db.update(document).set({ keywordStatus: status }).where(eq(document.id, documentId))
}

/**
 * Persist `document.processing_status` (and optionally
 * `processing_completed_at` / `processing_error`).
 *
 * Pass `processingError: null` to explicitly clear a stale error on success;
 * omit it to leave any existing error untouched.
 */
async function setDocumentProcessingStatus(
  documentId: string,
  status: 'keywording' | 'completed' | 'failed',
  opts?: { completedAt?: Date; processingError?: string | null }
): Promise<void> {
  const update: {
    processingStatus: 'keywording' | 'completed' | 'failed'
    processingCompletedAt?: Date
    processingError?: string | null
  } = {
    processingStatus: status,
  }
  if (opts?.completedAt) update.processingCompletedAt = opts.completedAt
  if (opts && 'processingError' in opts) update.processingError = opts.processingError ?? null
  try {
    await db.update(document).set(update).where(eq(document.id, documentId))
  } catch (err) {
    logger.warn('keywords-extract: failed to write processing status', {
      documentId,
      status,
      err: err instanceof Error ? err.message : String(err),
    })
  }
}
