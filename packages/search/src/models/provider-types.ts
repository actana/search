/**
 * The base model-catalog types, lifted out of Studio's `providers/types.ts` and
 * `providers/models.ts`.
 *
 * lifted: the 1,748-line catalog those two files carry — every chat model
 * Studio can dispatch to, with its pricing, capabilities and context window —
 * did not come. Search does not choose a model: it uses the endpoint a KB is
 * bound to, whatever that endpoint names (ADR 0004), and a catalog it cannot
 * act on is a table that goes stale. What is lifted is the *shape*, because the
 * embedding half of the catalog (`catalog.ts`) is typed against it, and the
 * three embedding price rows the embedding entries cite.
 */

export interface ModelPricing {
  /** Per 1M tokens. */
  input: number
  /** Per 1M tokens, when the provider supports it. */
  cachedInput?: number
  /** Per 1M tokens. */
  output: number
  /** Last updated date. */
  updatedAt: string
}

export type ModelPricingMap = Record<string, ModelPricing>

export interface ModelCapabilities {
  temperature?: {
    min: number
    max: number
  }
  toolUsageControl?: boolean
  computerUse?: boolean
  nativeStructuredOutputs?: boolean
  /** Maximum supported output tokens for this model */
  maxOutputTokens?: number
  reasoningEffort?: {
    values: string[]
  }
  verbosity?: {
    values: string[]
  }
  thinking?: {
    levels: string[]
    default?: string
  }
  deepResearch?: boolean
  /** Whether this model supports conversation memory. Defaults to true if omitted. */
  memory?: boolean
}

export interface ModelDefinition {
  id: string
  pricing: ModelPricing
  capabilities: ModelCapabilities
  contextWindow?: number
  /** ISO date string (YYYY-MM-DD) when the model was first publicly released */
  releaseDate?: string
}

export interface ProviderDefinition {
  id: string
  name: string
  description: string
  models: ModelDefinition[]
  defaultModel: string
  modelPatterns?: RegExp[]
  /** Brand color used in charts and visualizations (hex string) */
  color?: string
  /** True when this provider re-hosts other providers' models (e.g. Azure, Bedrock, OpenRouter) */
  isReseller?: boolean
  capabilities?: ModelCapabilities
  contextInformationAvailable?: boolean
}

/**
 * Embedding pricing, lifted verbatim. Only the first-party rows came: the
 * others are inlined beside the entries that cite them in `catalog.ts`, exactly
 * as they were in Studio.
 */
export const EMBEDDING_MODEL_PRICING: Record<string, ModelPricing> = {
  'text-embedding-3-small': {
    input: 0.02, // $0.02 per 1M tokens
    output: 0.0,
    updatedAt: '2026-04-01',
  },
  'text-embedding-3-large': {
    input: 0.13, // $0.13 per 1M tokens
    output: 0.0,
    updatedAt: '2026-04-01',
  },
  'text-embedding-ada-002': {
    input: 0.1, // $0.1 per 1M tokens
    output: 0.0,
    updatedAt: '2026-04-01',
  },
}

export function getEmbeddingModelPricing(modelId: string): ModelPricing | null {
  return EMBEDDING_MODEL_PRICING[modelId] || null
}
