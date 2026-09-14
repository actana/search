/**
 * Workspace embedding dispatcher.
 *
 * Routes embedding requests through the `(provider, template)` registry in
 * `@/lib/models/templates`. Resolves baseUrl, headers, request body, and
 * response parser based on the template's `requestShape`.
 */

import { createLogger } from '@actana/search-shared/log'
import { config as searchConfig, env } from '../config.ts'
import { isRetryableError, retryWithExponentialBackoff } from '../knowledge/documents/utils.ts'
import { EMBEDDING_MODELS, INFORMATIONAL_EMBEDDING_IDS, parseCatalogId } from './catalog.ts'
import {
  type AuthStyle,
  getTemplate,
  type ProviderId,
  type RequestShape,
  type Template,
} from './templates.ts'
import { batchByTokenLimit } from '@actana/search-shared/tokenization/index'

const logger = createLogger('models:embedding')

// ---------------------------------------------------------------------------
// Legacy catalog-based embedding handler registry.
//
// Retained as a back-compat seam for the executor's embedding block, the
// `/api/apps/runtime/ai/embed` legacy callers, and provider-side tests. New
// code should call {@link executeWorkspaceEmbedding} below, which routes
// through the Provider × Template registry instead.
// ---------------------------------------------------------------------------

export interface EmbeddingRequest {
  model: string
  input: string | string[]
  dimensions?: number
  user?: string
}

export interface EmbeddingResponse {
  vectors: number[][]
  model: string
  dimensions: number
  usage: { promptTokens: number; totalTokens: number }
}

export interface EmbeddingHandlerContext {
  apiKey: string
  baseUrl?: string
  /** Provided when `providerType === 'custom-embedding'`. */
  customConfig?: Record<string, unknown>
}

export type EmbeddingHandler = (
  req: EmbeddingRequest,
  ctx: EmbeddingHandlerContext
) => Promise<EmbeddingResponse>

const HANDLERS = new Map<string, EmbeddingHandler>()

export function registerEmbeddingHandler(providerId: string, handler: EmbeddingHandler): void {
  HANDLERS.set(providerId, handler)
}

export function getRegisteredEmbeddingProviders(): string[] {
  return Array.from(HANDLERS.keys())
}

function stripProviderPrefix(id: string): string {
  const parsed = parseCatalogId(id)
  return parsed ? parsed.model : id
}

/** @deprecated use executeWorkspaceEmbedding / executeWorkspaceInference; retained for legacy executor + /runtime routes. */
export async function executeEmbeddingRequest(
  providerId: string,
  req: EmbeddingRequest,
  ctx: EmbeddingHandlerContext
): Promise<EmbeddingResponse> {
  const fullModelId = req.model.includes(':') ? req.model : `${providerId}:${req.model}`

  if (INFORMATIONAL_EMBEDDING_IDS.has(fullModelId)) {
    if (fullModelId.startsWith('anthropic:')) {
      throw new Error('Anthropic does not ship embedding models — use a Voyage model instead.')
    }
    throw new Error(
      'OpenRouter does not proxy embeddings — configure a custom OpenAI-compatible endpoint.'
    )
  }

  const catalogEntry = EMBEDDING_MODELS.find((m) => m.id === fullModelId)
  if (!catalogEntry && providerId !== 'custom-embedding') {
    throw new Error(`unknown embedding model: ${fullModelId}`)
  }
  if (catalogEntry && catalogEntry.kind !== 'embedding') {
    throw new Error(`model ${fullModelId} is not an embedding model`)
  }

  const handler = HANDLERS.get(providerId)
  if (!handler) {
    throw new Error(`no embedding handler registered for provider: ${providerId}`)
  }

  const bareModel = stripProviderPrefix(req.model)
  try {
    return await handler({ ...req, model: bareModel }, ctx)
  } catch (error) {
    logger.error('embedding dispatch failed', { providerId, model: fullModelId, error })
    throw error
  }
}

// ---------------------------------------------------------------------------
// Workspace-endpoint dispatcher (Provider × Template registry).
// ---------------------------------------------------------------------------

/**
 * Workspace endpoint shape required by {@link executeWorkspaceEmbedding}.
 * Mirrors the rewritten `workspaceModelEndpoints` columns (chunk T1/T2).
 */
export interface WorkspaceEmbeddingEndpoint {
  id?: string
  providerId: string
  template: string
  modelName: string | null
  apiKey: string
  baseUrl?: string | null
  config?: Record<string, unknown> | null
  dimensions?: number | null
}

export interface EmbeddingUsage {
  promptTokens?: number
  totalTokens?: number
}

export interface WorkspaceEmbeddingResult {
  embeddings: number[][]
  model: string
  dimensions: number
  usage?: EmbeddingUsage
}

export interface ExecuteWorkspaceEmbeddingParams {
  endpoint: WorkspaceEmbeddingEndpoint
  input: string | string[]
  user?: string
  /**
   * Optional caller abort signal. Composed with the internal request timeout so
   * a caller-initiated cancel propagates immediately (and is never retried),
   * while a timeout aborts the in-flight request.
   */
  signal?: AbortSignal
}

interface CustomEmbeddingConfig {
  inputField?: string
  outputPath?: string
  requestShape?: RequestShape
}

interface ResolvedConfig {
  custom?: CustomEmbeddingConfig
  extras?: Record<string, unknown>
  [key: string]: unknown
}

/** Tiny dotted-path traversal supporting `data[0].embedding` style. */
function resolvePath(root: unknown, path: string): unknown {
  if (!path) return root
  const tokens = path
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter(Boolean)
  let cur: unknown = root
  for (const token of tokens) {
    if (cur == null) return undefined
    if (Array.isArray(cur)) {
      const idx = Number(token)
      if (!Number.isFinite(idx)) return undefined
      cur = cur[idx]
    } else if (typeof cur === 'object') {
      cur = (cur as Record<string, unknown>)[token]
    } else {
      return undefined
    }
  }
  return cur
}

function buildAuthHeaders(
  auth: AuthStyle,
  apiKey: string,
  extras: Record<string, unknown> | undefined
): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  switch (auth) {
    case 'bearer':
      headers['authorization'] = `Bearer ${apiKey}`
      break
    case 'x-api-key':
      headers['x-api-key'] = apiKey
      if (extras?.anthropicVersion) {
        headers['anthropic-version'] = String(extras.anthropicVersion)
      }
      break
    case 'azure-api-key':
      headers['api-key'] = apiKey
      break
    case 'query-key':
    case 'custom-header':
    default:
      break
  }
  return headers
}

function buildAzureEmbedUrl(baseUrl: string, extras: Record<string, unknown> | undefined): string {
  const deployment = extras?.deployment
  const apiVersion = extras?.apiVersion
  if (!deployment || !apiVersion) {
    throw new Error('Azure OpenAI embedding requires extras.deployment and extras.apiVersion')
  }
  return `${baseUrl.replace(/\/$/, '')}/openai/deployments/${deployment}/embeddings?api-version=${apiVersion}`
}

function asArray(input: string | string[]): string[] {
  return Array.isArray(input) ? input : [input]
}

interface DispatchPlan {
  url: string
  body: unknown
  parse: (json: unknown) => number[][]
}

function planDispatch(args: {
  shape: RequestShape
  baseUrl: string
  model: string
  inputs: string[]
  apiKey: string
  authStyle: AuthStyle
  extras: Record<string, unknown> | undefined
  custom?: CustomEmbeddingConfig
}): DispatchPlan {
  const { shape, baseUrl, model, inputs, apiKey, authStyle, extras, custom } = args
  const trimBase = baseUrl.replace(/\/$/, '')

  switch (shape) {
    case 'openai-embed': {
      const url =
        authStyle === 'azure-api-key'
          ? buildAzureEmbedUrl(baseUrl, extras)
          : `${trimBase}/embeddings`
      return {
        url,
        body: { input: inputs, model },
        parse: (json) => {
          const data = (json as { data?: Array<{ embedding: number[] }> }).data ?? []
          return data.map((d) => d.embedding)
        },
      }
    }
    case 'google-embed': {
      if (inputs.length === 1) {
        const url = `${trimBase}/models/${model}:embedContent?key=${apiKey}`
        return {
          url,
          body: { content: { parts: [{ text: inputs[0] }] } },
          parse: (json) => {
            const v = (json as { embedding?: { values: number[] } }).embedding?.values ?? []
            return [v]
          },
        }
      }
      const url = `${trimBase}/models/${model}:batchEmbedContents?key=${apiKey}`
      return {
        url,
        body: {
          requests: inputs.map((text) => ({
            model: `models/${model}`,
            content: { parts: [{ text }] },
          })),
        },
        parse: (json) => {
          const arr = (json as { embeddings?: Array<{ values: number[] }> }).embeddings ?? []
          return arr.map((e) => e.values)
        },
      }
    }
    case 'voyage-embed': {
      const inputType = (extras?.inputType as string | undefined) ?? 'document'
      return {
        url: `${trimBase}/embeddings`,
        body: { input: inputs, model, input_type: inputType },
        parse: (json) => {
          const data = (json as { data?: Array<{ embedding: number[] }> }).data ?? []
          return data.map((d) => d.embedding)
        },
      }
    }
    case 'cohere-embed': {
      return {
        url: `${trimBase}/v2/embed`,
        body: {
          texts: inputs,
          model,
          input_type: 'search_document',
          embedding_types: ['float'],
        },
        parse: (json) => {
          const arr = (json as { embeddings?: { float?: number[][] } }).embeddings?.float ?? []
          return arr
        },
      }
    }
    case 'custom': {
      const cfg = custom ?? {}
      const inputField = cfg.inputField ?? 'input'
      const outputPath = cfg.outputPath ?? 'data[0].embedding'
      if (cfg.requestShape === 'openai-embed') {
        return planDispatch({
          shape: 'openai-embed',
          baseUrl,
          model,
          inputs,
          apiKey,
          authStyle,
          extras,
        })
      }
      return {
        url: trimBase,
        body: { [inputField]: inputs, model },
        parse: (json) => {
          const got = resolvePath(json, outputPath)
          if (Array.isArray(got) && Array.isArray((got as unknown[])[0])) {
            return got as number[][]
          }
          if (Array.isArray(got)) {
            return [got as number[]]
          }
          throw new Error(`custom embedding outputPath did not resolve to a vector: ${outputPath}`)
        },
      }
    }
    default:
      throw new Error(`unsupported embedding requestShape: ${shape}`)
  }
}

/** Abort an in-flight embedding request after this many ms. */
const EMBEDDING_REQUEST_TIMEOUT_MS = 60_000

/** Retry policy for transient embedding-provider failures (429 / 5xx / network). */
const EMBEDDING_RETRY_OPTIONS = {
  maxRetries: 3,
  initialDelayMs: 1000,
  maxDelayMs: 10000,
  retryCondition: (error: unknown): boolean => {
    const status = (error as { status?: number }).status
    if (typeof status === 'number') {
      return status === 429 || status >= 500
    }
    // Network-level failures (fetch failed, ECONNRESET, …) are retryable;
    // timeouts and caller-initiated aborts are not (they fail fast).
    return isRetryableError(error)
  },
}

/**
 * Per-provider/per-shape request caps. `maxTokens` is the binding constraint
 * that prevents the provider returning a size/token `400`; `maxItems` guards the
 * array-length limit. Unknown providers fall back to conservative defaults.
 *
 * OpenAI `text-embedding-3-*` caps a request at 300k tokens and 2048 array
 * items. We treat the token cap as authoritative and the item cap as a
 * secondary guard, mirroring `KB_CONFIG_BATCH_SIZE` for the latter where set.
 */
interface ProviderEmbeddingLimits {
  maxTokens: number
  maxItems: number
}

const PROVIDER_EMBEDDING_LIMITS: Partial<Record<RequestShape, ProviderEmbeddingLimits>> = {
  'openai-embed': { maxTokens: 300_000, maxItems: 2048 },
  'voyage-embed': { maxTokens: 120_000, maxItems: 1000 },
  'cohere-embed': { maxTokens: 100_000, maxItems: 96 },
  'google-embed': { maxTokens: 100_000, maxItems: 100 },
}

/** Conservative defaults for providers without a known cap. */
const DEFAULT_EMBEDDING_LIMITS: ProviderEmbeddingLimits = { maxTokens: 100_000, maxItems: 1024 }

/**
 * Headroom applied to the token cap to absorb tokenizer drift between the
 * tiktoken estimate and the provider's own count. Keep ~10% under the real cap.
 */
const TOKEN_CAP_HEADROOM = 0.9

/** Maximum depth for adaptive halving when a sub-batch still returns a `400`. */
const ADAPTIVE_SPLIT_MAX_DEPTH = 4

/**
 * Maximum number of token-capped sub-batches dispatched concurrently for a
 * single embedding call. Bounded so a large document's batches overlap (cutting
 * wall-clock) without bursting far past the provider's rate limit; individual
 * 429s are still retried per request.
 */
const EMBEDDING_BATCH_CONCURRENCY = Math.max(1, Math.min(8, env.KB_CONFIG_CONCURRENCY_LIMIT || 8))

/**
 * Resolve the effective per-request limits for a shape, applying token headroom
 * and clamping the item cap to {@link env.KB_CONFIG_BATCH_SIZE} when smaller.
 */
function resolveEmbeddingLimits(shape: RequestShape): ProviderEmbeddingLimits {
  const base = PROVIDER_EMBEDDING_LIMITS[shape] ?? DEFAULT_EMBEDDING_LIMITS
  const envItemCap = env.KB_CONFIG_BATCH_SIZE
  const maxItems =
    typeof envItemCap === 'number' && envItemCap > 0
      ? Math.min(base.maxItems, envItemCap)
      : base.maxItems
  return {
    maxTokens: Math.max(1, Math.floor(base.maxTokens * TOKEN_CAP_HEADROOM)),
    maxItems: Math.max(1, maxItems),
  }
}

/**
 * Pack `inputs` into token- and item-bounded sub-batches preserving order. A
 * single input larger than the token cap is truncated (with a warning) rather
 * than sent as a doomed request. Each returned batch carries the index of its
 * first input so embeddings can be re-assembled in input order.
 */
function packEmbeddingBatches(
  inputs: string[],
  limits: ProviderEmbeddingLimits,
  modelName: string
): Array<{ startIndex: number; texts: string[] }> {
  const tokenBatches = batchByTokenLimit(inputs, limits.maxTokens, modelName)
  const result: Array<{ startIndex: number; texts: string[] }> = []
  let cursor = 0
  for (const tokenBatch of tokenBatches) {
    for (let i = 0; i < tokenBatch.length; i += limits.maxItems) {
      const slice = tokenBatch.slice(i, i + limits.maxItems)
      result.push({ startIndex: cursor + i, texts: slice })
    }
    cursor += tokenBatch.length
  }
  return result
}

/** Carries the HTTP status so the retry policy can decide retryability. */
class EmbeddingHttpError extends Error {
  status: number
  statusText: string
  retryAfterMs?: number

  constructor(status: number, statusText: string, body: string) {
    super(`embedding request failed: ${status} ${statusText} ${body.slice(0, 200)}`)
    this.name = 'EmbeddingHttpError'
    this.status = status
    this.statusText = statusText
  }
}

/** True when an HTTP `400` looks like a size/token-cap rejection. */
function isSizeRelated400(error: unknown): boolean {
  if (!(error instanceof EmbeddingHttpError) || error.status !== 400) return false
  const message = error.message.toLowerCase()
  return (
    message.includes('token') ||
    message.includes('maximum context') ||
    message.includes('too large') ||
    message.includes('too long') ||
    message.includes('max_tokens') ||
    message.includes('input is too')
  )
}

interface TimeoutSignal {
  signal: AbortSignal
  /** True once the internal timeout (not the caller) aborted the request. */
  timedOut: () => boolean
  cleanup: () => void
}

/**
 * Build an {@link AbortSignal} that fires when either the internal timeout
 * elapses or the caller's signal aborts, so a hung provider can't stall ingest
 * while a caller cancel still propagates.
 */
function withTimeoutSignal(timeoutMs: number, callerSignal?: AbortSignal): TimeoutSignal {
  const controller = new AbortController()
  let timedOut = false

  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)

  const onCallerAbort = () => controller.abort()
  if (callerSignal) {
    if (callerSignal.aborted) {
      controller.abort()
    } else {
      callerSignal.addEventListener('abort', onCallerAbort, { once: true })
    }
  }

  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cleanup: () => {
      clearTimeout(timer)
      callerSignal?.removeEventListener('abort', onCallerAbort)
    },
  }
}

/** Parse a `Retry-After` header (seconds or HTTP-date) into milliseconds. */
function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined
  const seconds = Number(header)
  if (!Number.isNaN(seconds)) {
    return seconds > 0 ? seconds * 1000 : undefined
  }
  const dateMs = new Date(header).getTime()
  if (Number.isNaN(dateMs)) return undefined
  const waitMs = dateMs - Date.now()
  return waitMs > 0 ? waitMs : undefined
}

/**
 * Run an embedding request against a workspace-configured endpoint by
 * dispatching through the Provider × Template registry.
 */
export async function executeWorkspaceEmbedding(
  params: ExecuteWorkspaceEmbeddingParams
): Promise<WorkspaceEmbeddingResult> {
  const { endpoint, input } = params

  /**
   * The deterministic test embedder (ADR 0005). With
   * `SEARCH_TEST_EMBEDDING=hash-ngram` every provider call is answered by the
   * hash n-gram embedder instead — pure, dependency-free, 256 dimensions, the
   * same vectors on every machine and in both repos. That is what lets a
   * behaviour-freeze fixture be replayed with no key and no network.
   *
   * The gate is here rather than at the call sites deliberately: every path
   * that embeds anything — ingest, query, the chunk service, the embed
   * pipeline — reaches the provider through this one function, so one branch
   * covers all of them and none of them learns it is under test.
   *
   * It is opt-in by an environment variable that no deployment sets, and it is
   * checked before the endpoint validation below so a fixture does not need a
   * plausible API key to run.
   */
  // `searchConfig`, not `config` — the local `const config` below is the
  // endpoint's own JSON blob, and the lifted code names it that.
  if (searchConfig().SEARCH_TEST_EMBEDDING === 'hash-ngram') {
    const { HASH_NGRAM_DIMS, hashNgramEmbedMany, hashNgramTokenCount } = await import(
      '@actana/search-shared/testing/hash-ngram-embedder'
    )
    const tokens = hashNgramTokenCount(input)
    return {
      embeddings: hashNgramEmbedMany(input),
      model: endpoint.modelName ?? 'hash-ngram',
      dimensions: HASH_NGRAM_DIMS,
      usage: { promptTokens: tokens, totalTokens: tokens },
    }
  }

  if (!endpoint.modelName) {
    throw new Error('workspace embedding endpoint missing modelName')
  }
  if (!endpoint.apiKey) {
    throw new Error('workspace embedding endpoint missing apiKey')
  }
  if (endpoint.dimensions == null) {
    throw new Error('workspace embedding endpoint missing dimensions')
  }

  const config = (endpoint.config ?? {}) as ResolvedConfig
  const providerId = endpoint.providerId as ProviderId
  const template: Template | undefined = getTemplate(providerId, endpoint.template, 'embedding')

  let shape: RequestShape | undefined = template?.requestShape
  let authStyle: AuthStyle | undefined = template?.authOverride
  let baseUrl = endpoint.baseUrl ?? template?.baseUrl ?? undefined
  let custom: CustomEmbeddingConfig | undefined

  if (!template || endpoint.template === 'custom') {
    custom = config.custom
    shape = (custom?.requestShape as RequestShape | undefined) ?? 'custom'
    baseUrl = endpoint.baseUrl ?? baseUrl
  }
  if (!shape) {
    throw new Error(
      `no embedding requestShape for provider=${endpoint.providerId} template=${endpoint.template}`
    )
  }
  if (!baseUrl) {
    throw new Error(
      `no baseUrl for embedding endpoint provider=${endpoint.providerId} template=${endpoint.template}`
    )
  }

  if (!authStyle) {
    // Provider default auth style; mirror logic in templates.ts.
    switch (endpoint.providerId) {
      case 'anthropic-messages':
        authStyle = 'x-api-key'
        break
      case 'google-genai':
        authStyle = 'query-key'
        break
      case 'openai-compatible':
      case 'voyage':
      case 'cohere':
      default:
        authStyle = 'bearer'
        break
    }
  }

  const extras = (config.extras ?? {}) as Record<string, unknown>
  const inputs = asArray(input)
  const modelName = endpoint.modelName
  const resolvedBaseUrl = baseUrl
  const resolvedAuthStyle = authStyle
  const headers = buildAuthHeaders(resolvedAuthStyle, endpoint.apiKey, extras)

  /**
   * Dispatch a single, already-token-bounded sub-batch through the
   * retry/timeout pipeline (Task 02). Returns the parsed vectors and the
   * provider-reported usage. The retry policy here covers transient
   * `429`/`5xx`/network failures only; size `400`s are surfaced to the caller
   * for adaptive splitting (see {@link dispatchWithAdaptiveSplit}).
   */
  const dispatchOnce = async (
    subInputs: string[]
  ): Promise<{ embeddings: number[][]; usage?: EmbeddingUsage }> => {
    const plan = planDispatch({
      shape,
      baseUrl: resolvedBaseUrl,
      model: modelName,
      inputs: subInputs,
      apiKey: endpoint.apiKey,
      authStyle: resolvedAuthStyle,
      extras,
      custom,
    })

    const response = await retryWithExponentialBackoff(async () => {
      const timeout = withTimeoutSignal(EMBEDDING_REQUEST_TIMEOUT_MS, params.signal)
      let res: Response
      try {
        res = await fetch(plan.url, {
          method: 'POST',
          headers,
          body: JSON.stringify(plan.body),
          signal: timeout.signal,
        })
      } catch (error) {
        // Caller cancelled: propagate as-is (the retry policy will not retry it).
        if (params.signal?.aborted) throw error
        // Internal timeout: surface a clear, non-retryable error.
        if (timeout.timedOut()) {
          throw new Error(
            `embedding request timed out after ${EMBEDDING_REQUEST_TIMEOUT_MS}ms ` +
              `(provider=${endpoint.providerId} template=${endpoint.template})`
          )
        }
        // Network-level failure: retryable via isRetryableError.
        logger.warn('embedding fetch failed', {
          providerId: endpoint.providerId,
          template: endpoint.template,
          error,
        })
        throw error
      } finally {
        timeout.cleanup()
      }

      if (!res.ok) {
        const text = await res.text().catch(() => '')
        logger.warn('embedding non-2xx', {
          status: res.status,
          providerId: endpoint.providerId,
          template: endpoint.template,
          body: text.slice(0, 500),
        })
        const httpError = new EmbeddingHttpError(res.status, res.statusText, text)
        const retryAfterMs = parseRetryAfter(res.headers.get('Retry-After'))
        if (retryAfterMs) httpError.retryAfterMs = retryAfterMs
        throw httpError
      }

      return res
    }, EMBEDDING_RETRY_OPTIONS)

    const json = (await response.json()) as unknown
    const usage = (json as { usage?: { prompt_tokens?: number; total_tokens?: number } }).usage
    return {
      embeddings: plan.parse(json),
      usage: usage
        ? { promptTokens: usage.prompt_tokens, totalTokens: usage.total_tokens }
        : undefined,
    }
  }

  /**
   * Belt-and-suspenders for tokenizer drift: if a sub-batch still trips a
   * size/token `400`, halve it and retry the halves (bounded recursion). The
   * network-retry path already excludes `400`, so the split is handled here.
   */
  const dispatchWithAdaptiveSplit = async (
    subInputs: string[],
    depth: number
  ): Promise<{ embeddings: number[][]; usage?: EmbeddingUsage }> => {
    try {
      return await dispatchOnce(subInputs)
    } catch (error) {
      if (!isSizeRelated400(error) || subInputs.length <= 1 || depth >= ADAPTIVE_SPLIT_MAX_DEPTH) {
        throw error
      }
      const mid = Math.ceil(subInputs.length / 2)
      logger.warn('embedding sub-batch hit size 400, splitting', {
        providerId: endpoint.providerId,
        template: endpoint.template,
        items: subInputs.length,
        depth,
      })
      const left = await dispatchWithAdaptiveSplit(subInputs.slice(0, mid), depth + 1)
      const right = await dispatchWithAdaptiveSplit(subInputs.slice(mid), depth + 1)
      return {
        embeddings: [...left.embeddings, ...right.embeddings],
        usage: mergeUsage(left.usage, right.usage),
      }
    }
  }

  const limits = resolveEmbeddingLimits(shape)
  const subBatches = packEmbeddingBatches(inputs, limits, modelName)

  const embeddings: number[][] = new Array<number[]>(inputs.length)
  let mergedUsage: EmbeddingUsage | undefined

  /**
   * Run the sub-batches with bounded concurrency rather than strictly
   * sequentially: a large document packs into several token-capped batches and
   * dispatching them serially is the dominant cost of processing time. Results
   * are written by absolute `startIndex`, so completion order never affects the
   * returned vector order. Concurrency is capped to keep request bursts within
   * the configured embedding limit (per-request 429s are still retried).
   */
  const concurrency = Math.max(1, Math.min(EMBEDDING_BATCH_CONCURRENCY, subBatches.length))
  let nextBatch = 0
  async function worker(): Promise<void> {
    while (true) {
      const index = nextBatch++
      if (index >= subBatches.length) return
      const batch = subBatches[index]
      const { embeddings: batchEmbeddings, usage } = await dispatchWithAdaptiveSplit(batch.texts, 0)
      for (let i = 0; i < batchEmbeddings.length; i++) {
        embeddings[batch.startIndex + i] = batchEmbeddings[i]
      }
      mergedUsage = mergeUsage(mergedUsage, usage)
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()))

  return {
    embeddings,
    model: modelName,
    dimensions: endpoint.dimensions,
    usage: mergedUsage,
  }
}

/** Sum two optional usage records, preserving `undefined` when both are absent. */
function mergeUsage(
  a: EmbeddingUsage | undefined,
  b: EmbeddingUsage | undefined
): EmbeddingUsage | undefined {
  if (!a) return b
  if (!b) return a
  return {
    promptTokens: (a.promptTokens ?? 0) + (b.promptTokens ?? 0),
    totalTokens: (a.totalTokens ?? 0) + (b.totalTokens ?? 0),
  }
}
