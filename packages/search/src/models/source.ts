/**
 * Where a model endpoint comes from (ADR 0004).
 *
 * One interface, two implementations, chosen by configuration. Ingest and query
 * code asks for "the embedding endpoint this KB is bound to" and never learns
 * whether the key was sealed here or fetched from a paired client's resolver.
 *
 * This is the seam Studio's `lib/kb/provider-context.ts` grew into: that file
 * read `workspace_model_endpoints` directly, which is the one thing Search
 * cannot do, because in wired mode the row it needs is a mirror and the key is
 * somewhere else entirely.
 */

import type { WorkspaceEmbeddingEndpoint } from './embedding.ts'
import type { WorkspaceInferenceEndpoint } from './inference.ts'

/** The resolved endpoints, under the names the engine already calls them. */
export type EmbeddingEndpoint = WorkspaceEmbeddingEndpoint
export type InferenceEndpoint = WorkspaceInferenceEndpoint

/**
 * What a KB is bound to. `endpointId` is Search's own id for the endpoint row;
 * for a mirrored endpoint that row also carries the paired client's
 * `external_id`, which is what the resolver is asked about.
 */
export interface EndpointBinding {
  endpointId: string
}

export interface ModelEndpointSource {
  /** The embedding endpoint a KB is bound to. Throws when missing or wrong kind. */
  embedding(binding: EndpointBinding): Promise<EmbeddingEndpoint>
  /** The inference endpoint used for keyword extraction. May be null (keywords off). */
  inference(binding: EndpointBinding): Promise<InferenceEndpoint | null>
  /**
   * The key a paired client registered for a named provider, or null.
   *
   * The odd one out, and it earns its place: the OCR step is bound to a
   * *provider* rather than to a KB's endpoint — a document is parsed with
   * Mistral OCR or it is not, whatever the KB embeds with. Studio resolved it
   * the same way, from `workspace_model_endpoints` by `provider_id`. Going
   * through the source rather than reading the table directly is what makes it
   * work in wired mode, where the key lives in the paired client and is
   * resolved per job (ADR 0004).
   */
  providerKey(binding: ProviderBinding): Promise<string | null>
}

/** A provider, scoped to the client whose endpoints are being looked at. */
export interface ProviderBinding {
  pairedClientId: string
  /** Catalog provider id — `mistral`, `openai`, … */
  provider: string
}

let configured: ModelEndpointSource | undefined

/**
 * Install the source. Called once at boot — `LocalEndpointSource` standalone,
 * `MirroredEndpointSource` when wired (TASK-005). Also how a test injects a
 * stand-in without mocking a module.
 */
export function setEndpointSource(source: ModelEndpointSource | undefined): void {
  configured = source
}

/**
 * The installed source, defaulting to the local one. Lazy, so importing this
 * module does not open a database connection.
 */
export async function getEndpointSource(): Promise<ModelEndpointSource> {
  if (configured) return configured
  const { LocalEndpointSource } = await import('./local-endpoint-source.ts')
  configured = new LocalEndpointSource()
  return configured
}
