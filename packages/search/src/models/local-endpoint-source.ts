/**
 * `LocalEndpointSource` — endpoints from `search.model_endpoint`, with their
 * keys sealed under `SEARCH_ENCRYPTION_KEY` (ADR 0004).
 *
 * This is how a standalone Search runs, and how the CLI's
 * `actana-search endpoint add` stores a key it was handed literally. The
 * bodies are Studio's `lib/kb/provider-context.ts`, against Search's table:
 * `workspace_model_endpoints` becomes `model_endpoint`, and the workspace
 * scoping is gone because the paired client's scope is checked in the API layer
 * before any of this runs (ADR 0003).
 */

import { and, eq } from 'drizzle-orm'
import { db } from '../db/client.ts'
import { modelEndpoint } from '../db/schema.ts'
import { resolveEndpointApiKey } from './endpoint-api-key.ts'
import type {
  EmbeddingEndpoint,
  EndpointBinding,
  InferenceEndpoint,
  ModelEndpointSource,
  ProviderBinding,
} from './source.ts'

export class LocalEndpointSource implements ModelEndpointSource {
  async embedding(binding: EndpointBinding): Promise<EmbeddingEndpoint> {
    const row = await this.row(binding.endpointId, 'embedding')
    const config = (row.config as Record<string, unknown> | null) ?? {}
    return {
      id: row.id,
      providerId: row.provider,
      template: row.template,
      modelName: row.model,
      apiKey: await resolveEndpointApiKey(row),
      baseUrl: row.baseUrl ?? undefined,
      config,
      dimensions: row.dimension ?? undefined,
    }
  }

  async inference(binding: EndpointBinding): Promise<InferenceEndpoint | null> {
    const row = await this.row(binding.endpointId, 'inference')
    const config = (row.config as Record<string, unknown> | null) ?? {}
    return {
      id: row.id,
      providerId: row.provider,
      template: row.template,
      modelName: row.model,
      apiKey: await resolveEndpointApiKey(row),
      baseUrl: row.baseUrl ?? undefined,
      config,
    }
  }

  async providerKey(binding: ProviderBinding): Promise<string | null> {
    const rows = await db
      .select()
      .from(modelEndpoint)
      .where(
        and(
          eq(modelEndpoint.pairedClientId, binding.pairedClientId),
          eq(modelEndpoint.provider, binding.provider),
          // Local rows only. A mirrored row has a NULL ciphertext, so without
          // this a client with one mirrored Mistral endpoint resolves to `''`
          // here and the OCR step reads that as "not configured" rather than as
          // "ask the resolver" — a silent change to what a document parses into.
          eq(modelEndpoint.source, 'local')
        )
      )
      .limit(1)
    if (rows.length === 0) return null
    const key = await resolveEndpointApiKey(rows[0])
    return key || null
  }

  private async row(endpointId: string, kind: 'embedding' | 'inference') {
    const rows = await db.select().from(modelEndpoint).where(eq(modelEndpoint.id, endpointId))
    if (rows.length === 0) {
      throw new Error(`LocalEndpointSource: endpoint not found: ${endpointId}`)
    }
    const row = rows[0]
    if (row.kind !== kind) {
      throw new Error(`LocalEndpointSource: endpoint ${endpointId} is not ${kind}-kind`)
    }
    if (row.source !== 'local') {
      throw new Error(
        `LocalEndpointSource: endpoint ${endpointId} is mirrored — it needs a MirroredEndpointSource`
      )
    }
    return row
  }
}
