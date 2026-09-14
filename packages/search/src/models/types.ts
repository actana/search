/**
 * Models module — shared types.
 *
 * Catalog IDs use the `provider:model` scheme (e.g. `openai:text-embedding-3-large`).
 */
import type {
  ModelCapabilities as BaseModelCapabilities,
  ModelDefinition as BaseModelDefinition,
  ModelPricing as BaseModelPricing,
  ProviderDefinition as BaseProviderDefinition,
} from './provider-types.ts'

export type ModelKind = 'inference' | 'embedding'

export type ModelPricing = BaseModelPricing
export type ModelCapabilities = BaseModelCapabilities
export type ProviderDefinition = BaseProviderDefinition

/**
 * A catalog model entry. `kind` is logically required across the unified
 * catalog; for back-compat with existing entries in `PROVIDER_DEFINITIONS`
 * (which predate this field) it is optional on the base shape and defaults
 * to `'inference'` through `MODEL_KINDS` / `listModels`.
 */
export interface ModelDefinition extends BaseModelDefinition {
  kind?: ModelKind
  /** Informational redirect — points the user at another provider (e.g. anthropic → voyage). */
  recommendedProviderId?: string
  /** Disabled-state copy displayed in catalog dropdowns. */
  uiNote?: string
  /** Grouping for the catalog dropdown UI (Chunk E). */
  groupLabel?: 'First-party' | 'Partner' | 'Custom' | 'Informational'
}

/**
 * Embedding-specific extension. Includes vector dimensionality and the
 * largest input batch supported per request.
 */
export interface EmbeddingModelDefinition extends ModelDefinition {
  kind: 'embedding'
  dimensions: number
  maxBatchSize: number
  /** When set, the model supports Matryoshka-style dim truncation. */
  supportedDimensions?: number[]
}

/**
 * Custom OpenAI-compatible embedding endpoint config. Stored in
 * `model_endpoint.config` (jsonb) when `template === 'custom-embedding'`.
 */
export interface CustomEmbeddingConfig {
  model: string
  dimensions: number
  requestShape: 'openai' | 'cohere' | 'voyage'
  headers?: Record<string, string>
  inputField?: string
  outputPath?: string
}
