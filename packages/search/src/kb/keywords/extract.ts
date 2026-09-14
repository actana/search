/**
 * Per-chunk keyword extraction (T2.3).
 *
 * Calls the workspace inference endpoint with the prompt built by
 * {@link buildKeywordExtractionPrompt} and parses the strict-JSON reply.
 * Output is validated to 3..10 entries, each non-empty, ≤ 60 chars, with at
 * least one letter, deduped by canonical form.
 */

import { createLogger } from '@actana/search-shared/log'
import { normalizeKeyword } from './normalize.ts'
import { buildKeywordExtractionPrompt } from './prompts/keyword-extraction.ts'
import { buildQueryKeywordExtractionPrompt } from './prompts/query-keyword-extraction.ts'
import { resolveKbInferenceEndpoint } from '../provider-context.ts'
import type { WorkspaceInferenceEndpoint } from '../../models/inference.ts'
import { executeWorkspaceInference } from '../../models/inference.ts'

const logger = createLogger('kb/keywords/extract')

const MIN_KEYWORDS = 3
const MAX_KEYWORDS = 10
const MAX_KEYWORD_LEN = 60
/** Minimum keyword count when extracting from a query (vs a chunk). */
const QUERY_MIN_KEYWORDS = 1

/** Input to {@link extractKeywordsForChunk}. */
export interface ExtractKeywordsForChunkInput {
  chunkText: string
  filename: string
  chunkIndex: number
  totalChunks: number
  /** Top-N existing KB keyword display labels — passed verbatim to the prompt. */
  existingTopKeywords: string[]
  workspaceId: string
  /** The KB's inference endpoint row id (workspace_model_endpoints.id). */
  inferenceEndpointId: string
  /**
   * Optional pre-resolved endpoint. When omitted the worker is expected to
   * resolve it once per document; this hook is here for tests.
   */
  endpoint?: WorkspaceInferenceEndpoint
  signal?: AbortSignal
}

/** A validated canonical/display keyword pair. */
export interface ExtractedKeyword {
  canonical: string
  display: string
}

/**
 * Raised when the inference call fails for a reason that is the same for every
 * chunk of the document — an authentication/credential error (401/403) or a
 * missing endpoint. Callers should stop iterating chunks and fail the document
 * once, rather than re-issuing the identical doomed request per chunk.
 */
export class KeywordInferenceFatalError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'KeywordInferenceFatalError'
  }
}

/**
 * True when an inference error is a credential/auth failure. Such failures are
 * document-wide (the endpoint key is wrong/missing), so retrying per chunk only
 * spams the provider with hundreds of identical 401s.
 */
function isFatalInferenceError(err: unknown): boolean {
  const message = (err instanceof Error ? err.message : String(err)).toLowerCase()
  return (
    message.includes('401') ||
    message.includes('403') ||
    message.includes('unauthorized') ||
    message.includes('forbidden') ||
    message.includes('missing authentication') ||
    message.includes('invalid api key') ||
    message.includes('invalid_api_key')
  )
}

/**
 * Extract 3..10 keywords for a single chunk. Returns `[]` on inference
 * or parse failure — the caller decides whether to retry or skip.
 */
export async function extractKeywordsForChunk(
  input: ExtractKeywordsForChunkInput
): Promise<ExtractedKeyword[]> {
  const prompt = buildKeywordExtractionPrompt({
    chunkText: input.chunkText,
    filename: input.filename,
    chunkIndex: input.chunkIndex,
    totalChunks: input.totalChunks,
    existingTopKeywords: input.existingTopKeywords,
  })

  const endpoint = input.endpoint ?? (await resolveInferenceEndpoint(input))
  if (!endpoint) return []

  let raw = ''
  try {
    const res = await executeWorkspaceInference({
      endpoint,
      messages: [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user },
      ],
      options: { temperature: 0 },
    })
    raw = res.content ?? ''
  } catch (err) {
    /**
     * A credential/auth failure is the same for every chunk — surface it as a
     * fatal error so the caller stops the per-chunk loop and fails the document
     * once, instead of issuing hundreds of identical 401s.
     */
    if (isFatalInferenceError(err)) {
      throw new KeywordInferenceFatalError(err instanceof Error ? err.message : String(err))
    }
    logger.warn('extractKeywordsForChunk: inference failed', {
      workspaceId: input.workspaceId,
      err: err instanceof Error ? err.message : String(err),
    })
    return []
  }

  const parsed = safeParseKeywordsJson(raw)
  if (!parsed) {
    logger.warn('extractKeywordsForChunk: parse failed', {
      workspaceId: input.workspaceId,
    })
    return []
  }

  return validateAndDedupe(parsed)
}

/**
 * Fallback resolver used only when the caller did not pass `endpoint`. The
 * worker (T3) pre-resolves the endpoint once per document and passes it via
 * `input.endpoint`, so this path is rarely hit in production.
 */
async function resolveInferenceEndpoint(
  input: ExtractKeywordsForChunkInput
): Promise<WorkspaceInferenceEndpoint | null> {
  if (!input.inferenceEndpointId) return null
  try {
    return await resolveKbInferenceEndpoint(input.inferenceEndpointId)
  } catch (err) {
    logger.warn('extractKeywordsForChunk: failed to resolve inference endpoint', {
      workspaceId: input.workspaceId,
      err: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

/**
 * Validate the parsed `{ keywords: string[] }` array per the T2.3 rules:
 *  - drop empties, > 60-char entries, entries without any letter
 *  - dedupe by canonical form
 *  - require [minSize, 10] survivors; otherwise return `[]`
 */
function validateAndDedupe(raws: string[], minSize = MIN_KEYWORDS): ExtractedKeyword[] {
  const seen = new Set<string>()
  const out: ExtractedKeyword[] = []
  for (const raw of raws) {
    if (typeof raw !== 'string') continue
    if (raw.length > MAX_KEYWORD_LEN) continue
    const norm = normalizeKeyword(raw)
    if (!norm) continue
    if (norm.canonical.length > MAX_KEYWORD_LEN) continue
    if (seen.has(norm.canonical)) continue
    seen.add(norm.canonical)
    out.push(norm)
    if (out.length >= MAX_KEYWORDS) break
  }
  if (out.length < minSize) return []
  return out
}

/** Input to {@link extractKeywordsForQuery}. */
export interface ExtractKeywordsForQueryInput {
  query: string
  /** Existing KB keyword display labels — surfaced as the menu in the prompt. */
  existingTopKeywords: string[]
  /**
   * Canonical form of every menu entry (same order/length as
   * `existingTopKeywords`). The selection is hard-filtered against this
   * set, so any keyword the model invents is dropped.
   */
  existingTopCanonicals: string[]
  workspaceId: string
  /** The KB's inference endpoint row id (workspace_model_endpoints.id). */
  inferenceEndpointId: string
  /** Optional pre-resolved endpoint. Hook for tests. */
  endpoint?: WorkspaceInferenceEndpoint
  signal?: AbortSignal
}

/**
 * Select 0..10 keywords for a user query from the KB's existing
 * vocabulary. Unlike {@link extractKeywordsForChunk}, this is a
 * **closed-set** task: the model picks from `existingTopKeywords` and any
 * keyword not present in `existingTopCanonicals` is dropped after the
 * call. Returns `[]` when the menu is empty, the LLM fails, or the model
 * picked nothing that matched the menu — callers then fall back to
 * whitespace tokenisation.
 */
export async function extractKeywordsForQuery(
  input: ExtractKeywordsForQueryInput
): Promise<ExtractedKeyword[]> {
  if (input.existingTopCanonicals.length === 0) return []

  const prompt = buildQueryKeywordExtractionPrompt({
    query: input.query,
    existingTopKeywords: input.existingTopKeywords,
  })

  const endpoint =
    input.endpoint ??
    (await (async () => {
      if (!input.inferenceEndpointId) return null
      try {
        return await resolveKbInferenceEndpoint(input.inferenceEndpointId)
      } catch (err) {
        logger.warn('extractKeywordsForQuery: failed to resolve inference endpoint', {
          workspaceId: input.workspaceId,
          err: err instanceof Error ? err.message : String(err),
        })
        return null
      }
    })())
  if (!endpoint) return []

  let raw = ''
  try {
    const res = await executeWorkspaceInference({
      endpoint,
      messages: [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user },
      ],
      options: { temperature: 0 },
    })
    raw = res.content ?? ''
  } catch (err) {
    logger.warn('extractKeywordsForQuery: inference failed', {
      workspaceId: input.workspaceId,
      err: err instanceof Error ? err.message : String(err),
    })
    return []
  }

  const parsed = safeParseKeywordsJson(raw)
  if (!parsed) {
    logger.warn('extractKeywordsForQuery: parse failed', { workspaceId: input.workspaceId })
    return []
  }

  const allowed = new Set(input.existingTopCanonicals)
  const validated = validateAndDedupe(parsed, QUERY_MIN_KEYWORDS)
  return validated.filter((kw) => allowed.has(kw.canonical))
}

/** Parse a `{ keywords: string[] }` payload, tolerating markdown fences. */
function safeParseKeywordsJson(raw: string): string[] | null {
  if (!raw) return null
  const candidates: string[] = [raw.trim()]
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence?.[1]) candidates.push(fence[1].trim())
  const firstBrace = raw.indexOf('{')
  const lastBrace = raw.lastIndexOf('}')
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(raw.slice(firstBrace, lastBrace + 1))
  }
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate)
      if (
        parsed &&
        typeof parsed === 'object' &&
        Array.isArray((parsed as { keywords?: unknown }).keywords)
      ) {
        return (parsed as { keywords: unknown[] }).keywords.filter(
          (x): x is string => typeof x === 'string'
        )
      }
    } catch {
      // try next candidate
    }
  }
  return null
}
