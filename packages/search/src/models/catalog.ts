/**
 * Embedding entries are a starting point; consult provider docs for current
 * IDs and pricing before relying on them. In Studio this file also re-exported
 * the inference half of the catalog; here it does not (ADR 0004 — Search uses
 * the endpoint a KB is bound to and does not choose a model).
 *
 * Catalog ID scheme is `provider:model` (e.g. `openai:text-embedding-3-large`,
 * `voyage:voyage-3-large`). Existing inference entries keep their bare ids
 * inside `PROVIDER_DEFINITIONS`; `getModel` parses the colon prefix and
 * scopes lookup to the named provider's model list.
 */

import type { EmbeddingModelDefinition, ModelKind } from './types.ts'
import type { ModelPricing } from './provider-types.ts'

// lifted: `export * from '@/providers/models'` — the inference half of the
// catalog — did not come. See `provider-types.ts` for why. Everything below
// this line is the embedding half, unchanged.
export * from './provider-types.ts'

import { EMBEDDING_MODEL_PRICING } from './provider-types.ts'

/**
 * Per-model `kind` overrides keyed by bare model id. Models not listed
 * default to `'inference'`. Embedding entries are merged in via
 * `EMBEDDING_MODELS` rather than mutated onto `PROVIDER_DEFINITIONS`.
 */
export const MODEL_KINDS: Record<string, ModelKind> = {
  'text-embedding-3-small': 'embedding',
  'text-embedding-3-large': 'embedding',
  'text-embedding-ada-002': 'embedding',
}

const VOYAGE_PRICING: Record<string, ModelPricing> = {
  'voyage-3-large': { input: 0.18, output: 0, updatedAt: '2026-04-01' },
  'voyage-3': { input: 0.06, output: 0, updatedAt: '2026-04-01' },
  'voyage-3-lite': { input: 0.02, output: 0, updatedAt: '2026-04-01' },
  'voyage-code-3': { input: 0.18, output: 0, updatedAt: '2026-04-01' },
  'voyage-multilingual-2': { input: 0.12, output: 0, updatedAt: '2026-04-01' },
}

const GOOGLE_EMBED_PRICING: Record<string, ModelPricing> = {
  'gemini-embedding-001': { input: 0.15, output: 0, updatedAt: '2026-04-01' },
  'text-embedding-004': { input: 0.0, output: 0, updatedAt: '2026-04-01' },
  'text-multilingual-embedding-002': { input: 0.0, output: 0, updatedAt: '2026-04-01' },
}

const COHERE_EMBED_PRICING: Record<string, ModelPricing> = {
  'embed-english-v3.0': { input: 0.1, output: 0, updatedAt: '2026-04-01' },
  'embed-multilingual-v3.0': { input: 0.1, output: 0, updatedAt: '2026-04-01' },
  'embed-english-light-v3.0': { input: 0.02, output: 0, updatedAt: '2026-04-01' },
  'embed-multilingual-light-v3.0': { input: 0.02, output: 0, updatedAt: '2026-04-01' },
}

/**
 * Seed embedding catalog. Each entry has `id` in `provider:model` form.
 */
export const EMBEDDING_MODELS: EmbeddingModelDefinition[] = [
  {
    id: 'openai:text-embedding-3-large',
    kind: 'embedding',
    dimensions: 3072,
    supportedDimensions: [256, 1024, 3072],
    maxBatchSize: 96,
    pricing: EMBEDDING_MODEL_PRICING['text-embedding-3-large'],
    capabilities: {},
    groupLabel: 'First-party',
  },
  {
    id: 'openai:text-embedding-3-small',
    kind: 'embedding',
    dimensions: 1536,
    supportedDimensions: [512, 1024, 1536],
    maxBatchSize: 96,
    pricing: EMBEDDING_MODEL_PRICING['text-embedding-3-small'],
    capabilities: {},
    groupLabel: 'First-party',
  },
  {
    id: 'openai:text-embedding-ada-002',
    kind: 'embedding',
    dimensions: 1536,
    maxBatchSize: 96,
    pricing: EMBEDDING_MODEL_PRICING['text-embedding-ada-002'],
    capabilities: {},
    groupLabel: 'First-party',
  },
  {
    id: 'google:gemini-embedding-001',
    kind: 'embedding',
    dimensions: 3072,
    supportedDimensions: [768, 1536, 3072],
    maxBatchSize: 100,
    pricing: GOOGLE_EMBED_PRICING['gemini-embedding-001'],
    capabilities: {},
    groupLabel: 'First-party',
  },
  {
    id: 'google:text-embedding-004',
    kind: 'embedding',
    dimensions: 768,
    maxBatchSize: 100,
    pricing: GOOGLE_EMBED_PRICING['text-embedding-004'],
    capabilities: {},
    groupLabel: 'First-party',
  },
  {
    id: 'google:text-multilingual-embedding-002',
    kind: 'embedding',
    dimensions: 768,
    maxBatchSize: 100,
    pricing: GOOGLE_EMBED_PRICING['text-multilingual-embedding-002'],
    capabilities: {},
    groupLabel: 'First-party',
  },
  {
    id: 'cohere:embed-english-v3.0',
    kind: 'embedding',
    dimensions: 1024,
    maxBatchSize: 96,
    pricing: COHERE_EMBED_PRICING['embed-english-v3.0'],
    capabilities: {},
    groupLabel: 'First-party',
  },
  {
    id: 'cohere:embed-multilingual-v3.0',
    kind: 'embedding',
    dimensions: 1024,
    maxBatchSize: 96,
    pricing: COHERE_EMBED_PRICING['embed-multilingual-v3.0'],
    capabilities: {},
    groupLabel: 'First-party',
  },
  {
    id: 'cohere:embed-english-light-v3.0',
    kind: 'embedding',
    dimensions: 384,
    maxBatchSize: 96,
    pricing: COHERE_EMBED_PRICING['embed-english-light-v3.0'],
    capabilities: {},
    groupLabel: 'First-party',
  },
  {
    id: 'cohere:embed-multilingual-light-v3.0',
    kind: 'embedding',
    dimensions: 384,
    maxBatchSize: 96,
    pricing: COHERE_EMBED_PRICING['embed-multilingual-light-v3.0'],
    capabilities: {},
    groupLabel: 'First-party',
  },
  {
    id: 'voyage:voyage-3-large',
    kind: 'embedding',
    dimensions: 1024,
    supportedDimensions: [256, 512, 1024, 2048],
    maxBatchSize: 128,
    pricing: VOYAGE_PRICING['voyage-3-large'],
    capabilities: {},
    groupLabel: 'Partner',
  },
  {
    id: 'voyage:voyage-3',
    kind: 'embedding',
    dimensions: 1024,
    maxBatchSize: 128,
    pricing: VOYAGE_PRICING['voyage-3'],
    capabilities: {},
    groupLabel: 'Partner',
  },
  {
    id: 'voyage:voyage-3-lite',
    kind: 'embedding',
    dimensions: 512,
    maxBatchSize: 128,
    pricing: VOYAGE_PRICING['voyage-3-lite'],
    capabilities: {},
    groupLabel: 'Partner',
  },
  {
    id: 'voyage:voyage-code-3',
    kind: 'embedding',
    dimensions: 1024,
    maxBatchSize: 128,
    pricing: VOYAGE_PRICING['voyage-code-3'],
    capabilities: {},
    groupLabel: 'Partner',
  },
  {
    id: 'voyage:voyage-multilingual-2',
    kind: 'embedding',
    dimensions: 1024,
    maxBatchSize: 128,
    pricing: VOYAGE_PRICING['voyage-multilingual-2'],
    capabilities: {},
    groupLabel: 'Partner',
  },
]

/**
 * Set of embedding model ids that are informational redirect rows, not
 * dispatchable. Retained as an empty set for back-compat with
 * `executeEmbeddingRequest`; the Provider × Template registry naturally
 * hides providers without templates for a kind, so no redirect rows are
 * needed anymore.
 */
export const INFORMATIONAL_EMBEDDING_IDS = new Set<string>()

/**
 * Parses an id in the catalog `provider:model` scheme. Returns `null` for
 * bare ids that lack a colon. Bare ids are still accepted by `getModel` for
 * back-compat with legacy callers.
 */
export function parseCatalogId(id: string): { provider: string; model: string } | null {
  const idx = id.indexOf(':')
  if (idx <= 0) return null
  return { provider: id.slice(0, idx), model: id.slice(idx + 1) }
}

export type { EmbeddingModelDefinition, ModelDefinition, ModelKind } from './types.ts'
