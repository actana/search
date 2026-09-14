/**
 * The source the engine actually gets: one that reads the row and dispatches.
 *
 * `kb/provider-context.ts` asks for "the embedding endpoint this KB is bound
 * to" and has an endpoint id and nothing else — no paired client, no notion of
 * wired or standalone. That is the whole point of ADR 0004's seam, and it is
 * also the problem: the *choice* between a local and a mirrored source belongs
 * to a paired client, and the call site does not have one.
 *
 * The row does. `model_endpoint` carries both `paired_client_id` and
 * `source`, so the endpoint id is enough to answer the question — read the row,
 * and hand the binding to the source that row belongs to. That keeps the engine
 * unchanged, keeps one process able to serve a standalone client and a wired
 * one at the same time, and makes "which source" a fact about the data rather
 * than a global the boot sequence sets.
 *
 * The one asymmetry is `providerKey`, which is addressed by paired client and
 * provider rather than by row (the OCR step — see `source.ts`). That one asks
 * the registry directly for the client's declared source.
 */

import { eq } from 'drizzle-orm'
import { db } from '../db/client.ts'
import { modelEndpoint } from '../db/schema.ts'
import { LocalEndpointSource } from './local-endpoint-source.ts'
import { MirroredEndpointSource } from './mirrored-endpoint-source.ts'
import {
  getEndpointSourceDeclaration,
  getEndpointSourceFor,
  openResolver,
} from './endpoint-registry.ts'
import type {
  EmbeddingEndpoint,
  EndpointBinding,
  InferenceEndpoint,
  ModelEndpointSource,
  ProviderBinding,
} from './source.ts'

export class RoutingEndpointSource implements ModelEndpointSource {
  async embedding(binding: EndpointBinding): Promise<EmbeddingEndpoint> {
    const source = await this.forEndpoint(binding.endpointId)
    return source.embedding(binding)
  }

  async inference(binding: EndpointBinding): Promise<InferenceEndpoint | null> {
    const source = await this.forEndpoint(binding.endpointId)
    return source.inference(binding)
  }

  async providerKey(binding: ProviderBinding): Promise<string | null> {
    const source = await getEndpointSourceFor(binding.pairedClientId)
    return source.providerKey(binding)
  }

  /**
   * The source that owns one endpoint row.
   *
   * A row that is not there at all is left to the concrete source to report:
   * `LocalEndpointSource` already has the message, and duplicating it here
   * would be two spellings of one failure.
   */
  private async forEndpoint(endpointId: string): Promise<ModelEndpointSource> {
    const rows = await db
      .select({
        pairedClientId: modelEndpoint.pairedClientId,
        source: modelEndpoint.source,
      })
      .from(modelEndpoint)
      .where(eq(modelEndpoint.id, endpointId))
      .limit(1)
    const row = rows[0]
    if (!row || row.source !== 'mirrored') return new LocalEndpointSource()

    /**
     * A mirrored row whose client has not declared a resolver is a stale mirror
     * — the client pushed a catalog and then went back to local, or the push
     * arrived before the source block did. `openResolver` throws
     * `EndpointKeyUnavailableError` with reason `not-configured`, which is one
     * of the reasons a retry cannot fix: the worker fails the document rather
     * than re-queuing it forever against a resolver that does not exist.
     */
    const declaration = await getEndpointSourceDeclaration(row.pairedClientId)
    const resolver = await openResolver(row.pairedClientId, declaration)
    return new MirroredEndpointSource(row.pairedClientId, resolver)
  }
}
