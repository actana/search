/**
 * Resolve provider credentials for the KB ingest / query helpers.
 *
 * `kb/ingest.ts` and `kb/query.ts` are pure-data functions: they take no auth
 * context. To call the embedding / inference dispatch they still need a
 * provider credential, and this is where they get it.
 *
 * lifted: the bodies moved behind `ModelEndpointSource` (ADR 0004). Studio read
 * `workspace_model_endpoints` here directly, which Search cannot do — in wired
 * mode the row is a mirror and the key lives in the paired client. The function
 * names, parameters and return shapes are unchanged, so every call site reads
 * as it did.
 */

import type { WorkspaceEmbeddingEndpoint } from '../models/embedding.ts'
import type { WorkspaceInferenceEndpoint } from '../models/inference.ts'
import { getEndpointSource } from '../models/source.ts'

export interface KbProviderContext {
  providerId: string
  apiKey: string
  baseUrl?: string
  customConfig?: Record<string, unknown>
}

/**
 * The credential for the endpoint a KB is bound to, filtered by the required
 * `kind` (e.g. `'embedding'`, `'inference'`). Throws on miss.
 *
 * lifted: the signature took `workspaceId` and looked an endpoint up *by
 * provider* within that workspace. Search has no workspace, and an endpoint is
 * addressed by its id — which is what every KB row already stores.
 */
export async function resolveKbProviderContext(args: {
  endpointId: string | null
  kind: 'embedding' | 'inference'
}): Promise<KbProviderContext> {
  const { endpointId, kind } = args
  if (!endpointId) {
    throw new Error(`resolveKbProviderContext: knowledge base has no ${kind} endpoint`)
  }

  const endpoint =
    kind === 'embedding'
      ? await resolveKbEmbeddingEndpoint(endpointId)
      : await resolveKbInferenceEndpoint(endpointId)

  const config = (endpoint.config as Record<string, unknown> | null) ?? {}
  return {
    providerId: endpoint.providerId,
    apiKey: endpoint.apiKey,
    baseUrl: endpoint.baseUrl ?? undefined,
    customConfig: (config.custom as Record<string, unknown> | undefined) ?? undefined,
  }
}

/**
 * Resolve an embedding endpoint by id. Linked keys are honoured by the source.
 * Throws on a missing row or the wrong kind.
 */
export async function resolveKbEmbeddingEndpoint(
  endpointId: string
): Promise<WorkspaceEmbeddingEndpoint> {
  const source = await getEndpointSource()
  return source.embedding({ endpointId })
}

/**
 * Resolve an inference endpoint by id. Linked keys are honoured by the source.
 * Throws on a missing row or the wrong kind.
 */
export async function resolveKbInferenceEndpoint(
  endpointId: string
): Promise<WorkspaceInferenceEndpoint> {
  const source = await getEndpointSource()
  const endpoint = await source.inference({ endpointId })
  if (!endpoint) {
    throw new Error(`resolveKbInferenceEndpoint: endpoint not found: ${endpointId}`)
  }
  return endpoint
}
