import { createLogger } from '@actana/search-shared/log'
import {
  type EmbeddingHandler,
  type EmbeddingResponse,
  registerEmbeddingHandler,
} from '../embedding.ts'

const logger = createLogger('models:embedding:google')

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta'

interface GoogleEmbedResponse {
  embedding?: { values: number[] }
  embeddings?: Array<{ values: number[] }>
}

/**
 * Google Gemini embedding handler. Single-input requests use
 * `:embedContent`; arrays use `:batchEmbedContents`. Honours the
 * `dimensions` arg via `output_dimensionality`.
 */
export const googleEmbeddingHandler: EmbeddingHandler = async (req, ctx) => {
  const baseUrl = (ctx.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '')
  const isBatch = Array.isArray(req.input)
  const inputs = (isBatch ? req.input : [req.input]) as string[]

  const url = `${baseUrl}/models/${encodeURIComponent(req.model)}:${isBatch ? 'batchEmbedContents' : 'embedContent'}?key=${encodeURIComponent(ctx.apiKey)}`

  const body = isBatch
    ? {
        requests: inputs.map((text) => ({
          model: `models/${req.model}`,
          content: { parts: [{ text }] },
          ...(typeof req.dimensions === 'number' ? { output_dimensionality: req.dimensions } : {}),
        })),
      }
    : {
        content: { parts: [{ text: inputs[0] }] },
        ...(typeof req.dimensions === 'number' ? { output_dimensionality: req.dimensions } : {}),
      }

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    logger.error('google embeddings request failed', { status: response.status, text })
    throw new Error(`google embeddings failed: ${response.status} ${text}`)
  }

  const json = (await response.json()) as GoogleEmbedResponse
  const vectors: number[][] = isBatch
    ? (json.embeddings ?? []).map((e) => e.values)
    : json.embedding
      ? [json.embedding.values]
      : []
  const dimensions = vectors[0]?.length ?? req.dimensions ?? 0
  const out: EmbeddingResponse = {
    vectors,
    model: req.model,
    dimensions,
    usage: { promptTokens: 0, totalTokens: 0 },
  }
  return out
}

registerEmbeddingHandler('google', googleEmbeddingHandler)
