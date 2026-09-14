/**
 * Public barrel for the models module. Combines the legacy
 * `PROVIDER_DEFINITIONS` (inference) with the seeded `EMBEDDING_MODELS`
 * catalog into a single `listModels` / `getModel` API keyed by
 * `provider:model` ids.
 */
import {
  EMBEDDING_MODELS,
  INFORMATIONAL_EMBEDDING_IDS,
  MODEL_KINDS,
  parseCatalogId,
} from './catalog.ts'
import type { ProviderDefinition } from './provider-types.ts'
import type { ModelDefinition, ModelKind } from './types.ts'

/**
 * lifted: in Studio this was `_CATALOG_PROVIDER_DEFINITIONS` — the chat-model
 * catalog re-exported through `catalog.ts`, which is not lifted (see
 * `provider-types.ts`). `listModels` and `getModel` keep their names, their
 * signatures and their return shapes, and the inference branch below is
 * therefore empty: an embedding id resolves exactly as it did, and an
 * inference id resolves to `null` here rather than to a catalog row Search
 * could not dispatch to anyway. Restoring it is one assignment, if a Panel
 * ever needs a model picker.
 */
const PROVIDER_DEFINITIONS: Record<string, ProviderDefinition> = {}

import './providers/index.ts'

export * from './catalog.ts'
export type {
  CustomEmbeddingConfig,
  EmbeddingModelDefinition,
  ModelKind,
} from './types.ts'

interface ListModelsOptions {
  kind?: ModelKind
  provider?: string
}

/**
 * Flattens the inference half of the catalog and projects each entry into
 * the canonical `provider:model` id form, attaching the `kind` discriminator.
 */
function* iterateInferenceModels(): Generator<{ providerId: string; model: ModelDefinition }> {
  for (const [providerId, providerDef] of Object.entries(PROVIDER_DEFINITIONS)) {
    for (const model of providerDef.models) {
      const kind = MODEL_KINDS[model.id] ?? 'inference'
      if (kind !== 'inference') continue
      yield {
        providerId,
        model: { ...model, kind, id: `${providerId}:${model.id}` },
      }
    }
  }
}

// legacy: workflow inference block
/**
 * @deprecated Use the Provider × Template registry (`@/lib/models/templates`)
 * for new code. Retained as a thin shim for the legacy workflow inference
 * block (`blocks/blocks/embedding.ts`) and the `/api/apps/runtime/ai/models`
 * route that serves it.
 */
export function listModels(opts: ListModelsOptions = {}): ModelDefinition[] {
  const out: ModelDefinition[] = []
  if (!opts.kind || opts.kind === 'inference') {
    for (const { providerId, model } of iterateInferenceModels()) {
      if (opts.provider && providerId !== opts.provider) continue
      out.push(model)
    }
  }
  if (!opts.kind || opts.kind === 'embedding') {
    for (const model of EMBEDDING_MODELS) {
      const parsed = parseCatalogId(model.id)
      if (opts.provider && parsed?.provider !== opts.provider) continue
      out.push(model)
    }
  }

  const groupOrder = (g: ModelDefinition['groupLabel']): number => {
    switch (g) {
      case 'First-party':
        return 0
      case 'Partner':
        return 1
      case 'Custom':
        return 2
      case 'Informational':
        return 3
      default:
        return 0
    }
  }
  return out.sort((a, b) => groupOrder(a.groupLabel) - groupOrder(b.groupLabel))
}

/**
 * Look up a catalog model by id. Ids may be in `provider:model` form
 * (preferred — scopes the search to that provider) or bare (legacy
 * fallback, searches every provider's model list).
 */
export function getModel(id: string): ModelDefinition | null {
  const parsed = parseCatalogId(id)
  if (parsed) {
    const embedHit = EMBEDDING_MODELS.find((m) => m.id === id)
    if (embedHit) return embedHit

    const providerDef = PROVIDER_DEFINITIONS[parsed.provider]
    if (!providerDef) return null
    const hit = providerDef.models.find((m) => m.id === parsed.model)
    if (!hit) return null
    const kind = MODEL_KINDS[hit.id] ?? 'inference'
    return { ...hit, kind, id }
  }

  for (const providerId of Object.keys(PROVIDER_DEFINITIONS)) {
    const providerDef = PROVIDER_DEFINITIONS[providerId]
    const hit = providerDef.models.find((m) => m.id === id)
    if (hit) {
      const kind = MODEL_KINDS[hit.id] ?? 'inference'
      return { ...hit, kind, id: `${providerId}:${hit.id}` }
    }
  }
  return null
}

export { EMBEDDING_MODELS, INFORMATIONAL_EMBEDDING_IDS, MODEL_KINDS, parseCatalogId }
export type {
  EmbeddingHandler,
  EmbeddingRequest,
  EmbeddingResponse,
} from './embedding.ts'
export { executeEmbeddingRequest } from './embedding.ts'
