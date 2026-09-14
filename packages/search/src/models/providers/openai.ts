import { createLogger } from '@actana/search-shared/log'
import {
  type EmbeddingHandler,
  type EmbeddingResponse,
  registerEmbeddingHandler,
} from '../embedding.ts'

const logger = createLogger('models:embedding:openai')

const DEFAULT_BASE_URL = 'https://api.openai.com/v1'

interface OpenAiEmbeddingResponse {
  data: Array<{ embedding: number[]; index: number }>
  model: string
  usage: { prompt_tokens: number; total_tokens: number }
}

/**
 * OpenAI `/v1/embeddings` handler. Supports the `dimensions` truncation
 * parameter for `text-embedding-3-*` models.
 */
export const openAiEmbeddingHandler: EmbeddingHandler = async (req, ctx) => {
  const baseUrl = (ctx.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '')
  const body: Record<string, unknown> = {
    model: req.model,
    input: req.input,
  }
  if (typeof req.dimensions === 'number') body.dimensions = req.dimensions
  if (req.user) body.user = req.user

  const response = await fetch(`${baseUrl}/embeddings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ctx.apiKey}`,
    },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    logger.error('openai embeddings request failed', { status: response.status, text })
    throw new Error(`openai embeddings failed: ${response.status} ${text}`)
  }

  const json = (await response.json()) as OpenAiEmbeddingResponse
  const vectors = json.data
    .slice()
    .sort((a, b) => a.index - b.index)
    .map((d) => d.embedding)
  const dimensions = vectors[0]?.length ?? req.dimensions ?? 0
  const out: EmbeddingResponse = {
    vectors,
    model: json.model,
    dimensions,
    usage: {
      promptTokens: json.usage.prompt_tokens,
      totalTokens: json.usage.total_tokens,
    },
  }
  return out
}

registerEmbeddingHandler('openai', openAiEmbeddingHandler)
