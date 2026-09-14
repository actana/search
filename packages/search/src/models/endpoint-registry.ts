/**
 * The endpoint registry: what a paired client's endpoints are, and where their
 * keys come from.
 *
 * This is the write-through surface behind `PUT /v1/endpoints` (TASK-004) and
 * behind the CLI's `endpoint add`. Everything the route handler needs is a
 * function here; the route validates a body and calls one of them, and nothing
 * in `api/` touches `model_endpoint` directly.
 *
 *   setEndpointSource(clientId, source)      — the `source` block of the PUT
 *   upsertMirroredEndpoints(clientId, [...]) — the `endpoints` array of the PUT
 *   createLocalEndpoint(clientId, input, key)— one endpoint with a literal key
 *   listEndpoints(clientId)                  — the GET. Never a key.
 *   deleteEndpoint(clientId, endpointId)
 *   getEndpointSourceFor(clientId)           — the source the engine resolves through
 *
 * **Two sources, one selection, per client (ADR 0004).** A client declares
 * `{ kind: 'local' }` — it registers keys with Search and Search seals them —
 * or `{ kind: 'mirrored', resolverUrl, resolverKey, resolverScope? }`, which
 * means the rows here are a mirror and the key is fetched per job. The
 * declaration is one jsonb column on `paired_client`, because it is one fact
 * about a client and a table would have been one row per client with a unique
 * index on the client id.
 *
 * **`resolverScope` is the value Search echoes to the resolver as
 * `workspaceId`.** The resolver's body is the client's contract, not Search's:
 * Studio's route reads `{ workspaceId, externalId }` and looks the endpoint up
 * inside that workspace (TASK-008). Search does not know what a workspace is
 * (CONTEXT rule 5), so it does not name one — it carries back whatever string
 * the client asked it to carry, and uses the paired client's own id when the
 * client asked for nothing.
 *
 * **No function here returns a key.** `listEndpoints` reports whether a row has
 * one (`hasKey`), which is what an operator needs to see, and never the value.
 */

import { and, eq, sql } from 'drizzle-orm'
import { createLogger } from '@actana/search-shared/log'
import { generateId } from '@actana/search-shared/short-id'
import { db } from '../db/client.ts'
import { modelEndpoint, pairedClient } from '../db/schema.ts'
import { encryptSecret, decryptSecret } from '../core/security/encryption.ts'
import { LocalEndpointSource } from './local-endpoint-source.ts'
import {
  MirroredEndpointSource,
  type MirroredEndpointSourceOptions,
  type MirroredResolver,
} from './mirrored-endpoint-source.ts'
import { EndpointKeyUnavailableError } from './endpoint-key-errors.ts'
import type { ModelEndpointSource } from './source.ts'

const logger = createLogger('EndpointRegistry')

/** The two kinds of endpoint a KB binds to. */
export type EndpointKind = 'embedding' | 'inference'

/**
 * What a client declares in `PUT /v1/endpoints`'s `source` block.
 *
 * `resolverKey` is the plaintext internal credential, and it exists in this
 * shape and in the request body only — {@link setEndpointSource} seals it on
 * the way in and nothing ever hands it back.
 */
export type EndpointSourceDeclaration =
  | { kind: 'local' }
  | {
      kind: 'mirrored'
      resolverUrl: string
      resolverKey: string
      /** Echoed to the resolver as `workspaceId`. Defaults to the client id. */
      resolverScope?: string | null
    }

/** The declaration as it rests: the credential sealed, never plain. */
export type StoredEndpointSource =
  | { kind: 'local' }
  | {
      kind: 'mirrored'
      resolverUrl: string
      resolverKeyCiphertext: string
      resolverScope?: string | null
    }

/** The declaration as a route may report it. Never a credential, sealed or not. */
export type EndpointSourceSummary =
  | { kind: 'local' }
  | { kind: 'mirrored'; resolverUrl: string; resolverScope: string | null }

/** One endpoint a client pushed. Metadata only — a push never carries a key. */
export interface MirroredEndpointInput {
  /** The client's own stable id for this endpoint. The resolver's lookup key. */
  externalId: string
  kind: EndpointKind
  provider: string
  template: string
  model?: string | null
  /** Required for `embedding`, forbidden for `inference` (the table checks it). */
  dimensions?: number | null
  baseUrl?: string | null
  label?: string | null
  /** Template extras — `{ extras: {...}, custom: {...} }`. Never a key. */
  config?: Record<string, unknown> | null
}

/** One endpoint registered with a literal key (standalone, and the CLI). */
export interface LocalEndpointInput {
  kind: EndpointKind
  provider: string
  template: string
  model?: string | null
  dimensions?: number | null
  baseUrl?: string | null
  label?: string | null
  config?: Record<string, unknown> | null
}

/** What a listing says about one endpoint. */
export interface EndpointSummary {
  id: string
  externalId: string | null
  kind: EndpointKind
  provider: string
  template: string
  model: string | null
  dimensions: number | null
  baseUrl: string | null
  label: string | null
  source: 'local' | 'mirrored'
  /** Whether a key can be produced for this row. Never the key. */
  hasKey: boolean
  createdAt: string
  updatedAt: string
}

// ---------------------------------------------------------------------------
// The source declaration
// ---------------------------------------------------------------------------

/**
 * Record where this client's keys come from. Called by `PUT /v1/endpoints`.
 *
 * Sealing the resolver credential is what makes `SEARCH_ENCRYPTION_KEY` a
 * requirement for a *wired* instance as well as a standalone one. That is a
 * deliberate widening of ADR 0004's "in wired mode nothing is sealed here":
 * nothing *of the client's provider keys* is, and the credential that fetches
 * them still is.
 */
export async function setEndpointSource(
  clientId: string,
  declaration: EndpointSourceDeclaration
): Promise<EndpointSourceSummary> {
  const stored = await sealDeclaration(declaration)
  const updated = await db
    .update(pairedClient)
    .set({ endpointSource: stored })
    .where(eq(pairedClient.id, clientId))
    .returning({ id: pairedClient.id })
  if (updated.length === 0) {
    throw new Error(`setEndpointSource: no paired client ${clientId}`)
  }
  // The URL, never the credential, and never the scope's *value* at info.
  logger.info('Endpoint source declared', { pairedClientId: clientId, kind: declaration.kind })
  return summariseSource(stored)
}

/** What this client last declared. A client that declared nothing is local. */
export async function getEndpointSourceDeclaration(
  clientId: string
): Promise<StoredEndpointSource> {
  const rows = await db
    .select({ endpointSource: pairedClient.endpointSource })
    .from(pairedClient)
    .where(eq(pairedClient.id, clientId))
    .limit(1)
  return readStoredSource(rows[0]?.endpointSource)
}

/** The declaration as a route reports it. */
export async function getEndpointSourceSummary(
  clientId: string
): Promise<EndpointSourceSummary> {
  return summariseSource(await getEndpointSourceDeclaration(clientId))
}

/**
 * The source this client's endpoints resolve through.
 *
 * A `LocalEndpointSource` for a standalone client, a `MirroredEndpointSource`
 * bound to the declared resolver for a wired one. The engine never calls this
 * directly — `routing-endpoint-source.ts` does, from an endpoint id — but the
 * API layer does, and so does anything that has a client in hand and no row.
 */
export async function getEndpointSourceFor(
  clientId: string,
  options: MirroredEndpointSourceOptions = {}
): Promise<ModelEndpointSource> {
  const stored = await getEndpointSourceDeclaration(clientId)
  if (stored.kind === 'local') return new LocalEndpointSource()
  return new MirroredEndpointSource(clientId, await openResolver(clientId, stored), options)
}

/** Unseal a stored mirrored declaration into the resolver a source dials. */
export async function openResolver(
  clientId: string,
  stored: StoredEndpointSource
): Promise<MirroredResolver> {
  if (stored.kind !== 'mirrored') {
    throw new EndpointKeyUnavailableError(
      `paired client ${clientId} has not declared a mirrored endpoint source, so there is no resolver to ask`,
      { reason: 'not-configured', pairedClientId: clientId }
    )
  }
  const { decrypted } = await decryptSecret(stored.resolverKeyCiphertext)
  return {
    resolverUrl: stored.resolverUrl,
    resolverKey: decrypted,
    resolverScope: stored.resolverScope ?? null,
  }
}

// ---------------------------------------------------------------------------
// The endpoints
// ---------------------------------------------------------------------------

/**
 * Write a client's pushed catalog through, and hand back the id map it needs.
 *
 * Upsert on `(paired_client_id, external_id)` — the unique index the table
 * already carries — so a client that pushes its whole catalog on every edit
 * (which is what TASK-008's hook does) writes the same rows rather than a new
 * set. The return value is the map the client stores as
 * `pushed_endpoint_ids`: its id for an endpoint, and Search's.
 *
 * **Never a key.** `key_ciphertext` is left NULL and `source` is `mirrored`,
 * which is what makes a row here unresolvable except through the resolver.
 */
export async function upsertMirroredEndpoints(
  clientId: string,
  endpoints: MirroredEndpointInput[]
): Promise<Array<{ id: string; externalId: string }>> {
  const out: Array<{ id: string; externalId: string }> = []
  for (const input of endpoints) {
    const externalId = input.externalId?.trim()
    if (!externalId) {
      throw new Error('upsertMirroredEndpoints: every pushed endpoint needs an externalId')
    }
    const now = new Date()
    const values = {
      id: generateId(),
      pairedClientId: clientId,
      kind: input.kind,
      provider: input.provider,
      template: input.template,
      model: input.model ?? null,
      dimension: input.kind === 'embedding' ? (input.dimensions ?? null) : null,
      baseUrl: input.baseUrl ?? null,
      keyCiphertext: null,
      source: 'mirrored' as const,
      externalId,
      label: input.label ?? null,
      config: input.config ?? {},
      createdAt: now,
      updatedAt: now,
    }
    const [row] = await db
      .insert(modelEndpoint)
      .values(values)
      .onConflictDoUpdate({
        target: [modelEndpoint.pairedClientId, modelEndpoint.externalId],
        // The index is partial (`WHERE external_id IS NOT NULL`), so the
        // predicate has to be restated for Postgres to recognise which index
        // this conflict clause means. Without it the statement fails with "no
        // unique or exclusion constraint matching the ON CONFLICT
        // specification" — at run time, on the first push, never at compile.
        targetWhere: sql`${modelEndpoint.externalId} IS NOT NULL`,
        set: {
          kind: values.kind,
          provider: values.provider,
          template: values.template,
          model: values.model,
          dimension: values.dimension,
          baseUrl: values.baseUrl,
          label: values.label,
          config: values.config,
          // A row that was local and is now pushed becomes a mirror, and its
          // sealed key goes: two sources for one endpoint is the ambiguity
          // this whole module exists to not have.
          source: 'mirrored',
          keyCiphertext: null,
          updatedAt: now,
        },
      })
      .returning({ id: modelEndpoint.id, externalId: modelEndpoint.externalId })
    out.push({ id: row.id, externalId: row.externalId ?? externalId })
  }
  logger.info('Mirrored endpoints upserted', { pairedClientId: clientId, count: out.length })
  return out
}

/**
 * Register one endpoint whose key Search holds. Standalone, and the CLI's
 * `endpoint add`.
 *
 * The key is sealed with `SEARCH_ENCRYPTION_KEY` before it reaches a column and
 * is not in the return value.
 */
export async function createLocalEndpoint(
  clientId: string,
  input: LocalEndpointInput,
  apiKey: string
): Promise<EndpointSummary> {
  if (!apiKey) {
    throw new Error('createLocalEndpoint: a local endpoint needs an API key')
  }
  if (input.kind === 'embedding' && !input.dimensions) {
    throw new Error('createLocalEndpoint: an embedding endpoint needs a dimension')
  }
  const { encrypted } = await encryptSecret(apiKey)
  const now = new Date()
  const [row] = await db
    .insert(modelEndpoint)
    .values({
      id: generateId(),
      pairedClientId: clientId,
      kind: input.kind,
      provider: input.provider,
      template: input.template,
      model: input.model ?? null,
      dimension: input.kind === 'embedding' ? (input.dimensions ?? null) : null,
      baseUrl: input.baseUrl ?? null,
      keyCiphertext: encrypted,
      source: 'local',
      externalId: null,
      label: input.label ?? null,
      config: input.config ?? {},
      createdAt: now,
      updatedAt: now,
    })
    .returning()
  logger.info('Local endpoint registered', {
    pairedClientId: clientId,
    endpointId: row.id,
    kind: row.kind,
    provider: row.provider,
  })
  return summarise(row)
}

/** Every endpoint this client owns. Keys are reported as a boolean, never a value. */
export async function listEndpoints(clientId: string): Promise<EndpointSummary[]> {
  const rows = await db
    .select()
    .from(modelEndpoint)
    .where(eq(modelEndpoint.pairedClientId, clientId))
  return rows.map(summarise)
}

/** Drop one endpoint. `false` when this client does not own it. */
export async function deleteEndpoint(clientId: string, endpointId: string): Promise<boolean> {
  const removed = await db
    .delete(modelEndpoint)
    .where(
      and(eq(modelEndpoint.pairedClientId, clientId), eq(modelEndpoint.id, endpointId))
    )
    .returning({ id: modelEndpoint.id })
  return removed.length > 0
}

// ---------------------------------------------------------------------------

type EndpointRow = typeof modelEndpoint.$inferSelect

function summarise(row: EndpointRow): EndpointSummary {
  return {
    id: row.id,
    externalId: row.externalId,
    kind: row.kind as EndpointKind,
    provider: row.provider,
    template: row.template,
    model: row.model,
    dimensions: row.dimension,
    baseUrl: row.baseUrl,
    label: row.label,
    source: row.source === 'mirrored' ? 'mirrored' : 'local',
    // A mirrored row's key is always obtainable in principle — it is one
    // resolver call away — and a local row's is obtainable when it has a
    // ciphertext or points at another endpoint that does.
    hasKey:
      row.source === 'mirrored' ||
      Boolean(row.keyCiphertext) ||
      Boolean((row.config as { apiKeyEndpointId?: unknown } | null)?.apiKeyEndpointId),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

async function sealDeclaration(
  declaration: EndpointSourceDeclaration
): Promise<StoredEndpointSource> {
  if (declaration.kind === 'local') return { kind: 'local' }
  const url = declaration.resolverUrl?.trim()
  if (!url) throw new Error('setEndpointSource: a mirrored source needs a resolverUrl')
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`setEndpointSource: "${url}" is not a resolver URL`)
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(
      `setEndpointSource: a resolver is reached over http(s) — "${parsed.protocol}" is not`
    )
  }
  if (!declaration.resolverKey) {
    throw new Error('setEndpointSource: a mirrored source needs a resolverKey')
  }
  const { encrypted } = await encryptSecret(declaration.resolverKey)
  const scope = declaration.resolverScope?.trim()
  return {
    kind: 'mirrored',
    resolverUrl: url,
    resolverKeyCiphertext: encrypted,
    ...(scope ? { resolverScope: scope } : {}),
  }
}

/**
 * Read the column. Anything that is not a well-formed mirrored declaration —
 * NULL, a client paired before the column existed, a hand-edited row — reads as
 * local, because "I could not understand where your keys come from" must not
 * become "I will go and ask a URL I half-parsed".
 */
function readStoredSource(value: unknown): StoredEndpointSource {
  if (!value || typeof value !== 'object') return { kind: 'local' }
  const o = value as Record<string, unknown>
  if (o.kind !== 'mirrored') return { kind: 'local' }
  if (typeof o.resolverUrl !== 'string' || typeof o.resolverKeyCiphertext !== 'string') {
    return { kind: 'local' }
  }
  return {
    kind: 'mirrored',
    resolverUrl: o.resolverUrl,
    resolverKeyCiphertext: o.resolverKeyCiphertext,
    resolverScope: typeof o.resolverScope === 'string' ? o.resolverScope : null,
  }
}

function summariseSource(stored: StoredEndpointSource): EndpointSourceSummary {
  if (stored.kind === 'local') return { kind: 'local' }
  return {
    kind: 'mirrored',
    resolverUrl: stored.resolverUrl,
    resolverScope: stored.resolverScope ?? null,
  }
}
