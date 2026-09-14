import { createLogger } from '@actana/search-shared/log'
import {
  type EmbeddingHandler,
  type EmbeddingResponse,
  registerEmbeddingHandler,
} from '../embedding.ts'

const logger = createLogger('models:embedding:voyage')

const DEFAULT_BASE_URL = 'https://api.voyageai.com/v1'

interface VoyageEmbeddingResponse {
  data: Array<{ embedding: number[]; index: number }>
  model: string
  usage: { total_tokens: number }
}

export const voyageEmbeddingHandler: EmbeddingHandler = async (req, ctx) => {
  const baseUrl = (ctx.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '')
  const body: Record<string, unknown> = {
    model: req.model,
    input: req.input,
  }
  if (typeof req.dimensions === 'number') body.output_dimension = req.dimensions

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
    logger.error('voyage embeddings request failed', { status: response.status, text })
    throw new Error(`voyage embeddings failed: ${response.status} ${text}`)
  }

  const json = (await response.json()) as VoyageEmbeddingResponse
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
      promptTokens: json.usage.total_tokens,
      totalTokens: json.usage.total_tokens,
    },
  }
  return out
}

registerEmbeddingHandler('voyage', voyageEmbeddingHandler)
