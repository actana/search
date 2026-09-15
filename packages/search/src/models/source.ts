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
 *
 * `pairedClientId` is **defence in depth**, and optional for that reason. The
 * primary check is at the route: a caller may only name a KB its certificate
 * owns (ADR 0003), and an endpoint id reaches this layer only through a KB row
 * that has already been scoped to the caller. But an endpoint id is selected
 * here by `id` alone, so a caller that did get one of another client's ids past
 * the route would be served that client's key. When the id is passed, the
 * source refuses a row whose `paired_client_id` is not it —
 * `EndpointKeyUnavailableError` with reason `client-mismatch`, which is
 * terminal. Absent, the check is simply not made: the engine's lifted call
 * sites have an endpoint id and no client, which is what ADR 0004's seam is
 * for, and inventing one here would be guessing.
 */
export interface EndpointBinding {
  endpointId: string
  /** The client the caller was authenticated as, when there is one. */
  pairedClientId?: string | null
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
 * Override the process's source. How a test injects a stand-in without mocking
 * a module; `undefined` puts the default back.
 *
 * **Not how wired mode is turned on.** There is no boot flag and there is no
 * per-process answer: the default source reads each endpoint row and dispatches
 * to the local or the mirrored source *per row*
 * (`routing-endpoint-source.ts`), because "which source" is a fact about a
 * paired client rather than about a process, and one instance serves both kinds
 * of client at once (ADR 0004, ADR 0010).
 *
 * Named `install…` rather than `set…` because `setEndpointSource(clientId,
 * source)` in `endpoint-registry.ts` is the one a route calls, and two
 * functions with one name doing different things is one import away from being
 * the wrong one.
 */
export function installEndpointSource(source: ModelEndpointSource | undefined): void {
  configured = source
}

/**
 * The installed source, defaulting to the routing one. Lazy, so importing this
 * module does not open a database connection.
 */
export async function getEndpointSource(): Promise<ModelEndpointSource> {
  if (configured) return configured
  const { RoutingEndpointSource } = await import('./routing-endpoint-source.ts')
  configured = new RoutingEndpointSource()
  return configured
}
