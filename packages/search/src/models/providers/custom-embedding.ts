import { createLogger } from '@actana/search-shared/log'
import {
  type EmbeddingHandler,
  type EmbeddingResponse,
  registerEmbeddingHandler,
} from '../embedding.ts'
import type { CustomEmbeddingConfig } from '../types.ts'

const logger = createLogger('models:embedding:custom')

/**
 * Resolve a dotted output path against a parsed response body. Supports
 * array indexing via `data[0].embedding`-style segments.
 */
function readPath(value: unknown, path: string): unknown {
  if (!path) return value
  let cursor: unknown = value
  for (const segment of path.split('.')) {
    const match = segment.match(/^([^[]*)((?:\[\d+\])*)$/)
    if (!match) return undefined
    const key = match[1]
    const indices = (match[2].match(/\d+/g) ?? []).map(Number)
    if (key) {
      if (cursor && typeof cursor === 'object') {
        cursor = (cursor as Record<string, unknown>)[key]
      } else {
        return undefined
      }
    }
    for (const idx of indices) {
      if (Array.isArray(cursor)) cursor = cursor[idx]
      else return undefined
    }
  }
  return cursor
}

/**
 * Custom OpenAI-compatible embedding endpoint dispatcher. Reads
 * `customConfig` from the workspace model endpoint row and reshapes the
 * request/response according to the configured `requestShape`.
 */
export const customEmbeddingHandler: EmbeddingHandler = async (req, ctx) => {
  const config = (ctx.customConfig ?? {}) as Partial<CustomEmbeddingConfig>
  if (!ctx.baseUrl) throw new Error('custom-embedding requires baseUrl')
  const shape = config.requestShape ?? 'openai'
  const inputField = config.inputField ?? 'input'
  const url = ctx.baseUrl.replace(/\/$/, '')

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${ctx.apiKey}`,
    ...(config.headers ?? {}),
  }

  let body: Record<string, unknown>
  if (shape === 'cohere') {
    body = {
      model: req.model,
      texts: Array.isArray(req.input) ? req.input : [req.input],
      input_type: 'search_document',
    }
  } else if (shape === 'voyage') {
    body = { model: req.model, input: req.input }
    if (typeof req.dimensions === 'number') body.output_dimension = req.dimensions
  } else {
    body = { model: req.model, [inputField]: req.input }
    if (typeof req.dimensions === 'number') body.dimensions = req.dimensions
  }

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    logger.error('custom embeddings request failed', { status: response.status, text })
    throw new Error(`custom embeddings failed: ${response.status} ${text}`)
  }
  const json = (await response.json()) as unknown

  let vectors: number[][] = []
  if (config.outputPath) {
    const found = readPath(json, config.outputPath)
    if (Array.isArray(found)) vectors = found as number[][]
  } else if (shape === 'cohere') {
    const e = (json as { embeddings?: number[][] }).embeddings
    vectors = e ?? []
  } else {
    const data = (json as { data?: Array<{ embedding: number[] }> }).data
    vectors = (data ?? []).map((d) => d.embedding)
  }

  const dimensions = vectors[0]?.length ?? config.dimensions ?? req.dimensions ?? 0
  const out: EmbeddingResponse = {
    vectors,
    model: req.model,
    dimensions,
    usage: { promptTokens: 0, totalTokens: 0 },
  }
  return out
}

registerEmbeddingHandler('custom-embedding', customEmbeddingHandler)
