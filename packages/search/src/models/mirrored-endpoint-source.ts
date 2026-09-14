/**
 * `MirroredEndpointSource` — wired mode. The rows are a mirror, the key is not
 * here, and it is fetched for the life of one job (ADR 0004).
 *
 * A paired client pushes catalog metadata through `PUT /v1/endpoints`: provider,
 * template, model, dimension, base URL, and its own stable id for the endpoint
 * (`model_endpoint.external_id`). **No key crosses.** The rows carry
 * `source='mirrored'` and a NULL `key_ciphertext`, and there is nothing in this
 * file that would write one.
 *
 * When a job needs a key, this asks the client's resolver:
 *
 *     POST <resolverUrl>
 *     x-api-key: <resolverKey>
 *     { "workspaceId": <resolverScope ?? pairedClientId>, "externalId": "<id>" }
 *     → 200 { apiKey, baseUrl?, provider, model }
 *     → 404 the client does not know that endpoint
 *
 * `workspaceId` is the field name because that is what the client's route reads
 * (Studio's `POST /api/search/resolve-endpoint`, TASK-008). Search does not know
 * what a workspace is (CONTEXT rule 5) and does not pretend to: it echoes
 * whatever scope the client declared beside its resolver, and falls back to the
 * paired client's own id when it declared none.
 *
 * **The key's whole life is a 60-second cache entry.** Not a column, not a file,
 * not a log line. A document fanned out into forty embed batches would otherwise
 * be forty resolver round trips inside a second; the TTL is what makes the
 * resolver a control-plane call rather than a hot-path one, and it is short
 * enough that a rotation on the client side is picked up within a minute.
 *
 * **Nothing here interpolates a response body into an error.** See
 * `endpoint-key-errors.ts` for the second half of that rule.
 */

import { and, eq } from 'drizzle-orm'
import { createLogger } from '@actana/search-shared/log'
import { db } from '../db/client.ts'
import { modelEndpoint } from '../db/schema.ts'
import {
  EndpointKeyUnavailableError,
  scrubSecret,
  type EndpointKeyUnavailableReason,
} from './endpoint-key-errors.ts'
import type {
  EmbeddingEndpoint,
  EndpointBinding,
  InferenceEndpoint,
  ModelEndpointSource,
  ProviderBinding,
} from './source.ts'

const logger = createLogger('MirroredEndpointSource')

/** How long a resolved key is held in memory. Never longer, never on disk. */
export const RESOLVED_KEY_TTL_MS = 60_000

/** How long one resolver call may take before it counts as a timeout. */
export const RESOLVER_TIMEOUT_MS = 10_000

/** What a paired client declared about where its keys come from. */
export interface MirroredResolver {
  /** The client's resolver route. `https://` in anything but a test rig. */
  resolverUrl: string
  /** The internal credential, sent as `x-api-key`. Never logged. */
  resolverKey: string
  /**
   * What to echo as `workspaceId` in the resolver body.
   *
   * The client's own name for the scope its endpoints belong to — a Studio
   * workspace id, in the deployment this exists for. Absent means "use the
   * paired client's id", which is right for a client with one scope.
   */
  resolverScope?: string | null
}

/** What the resolver answers with. Only `apiKey` is required. */
export interface ResolvedEndpointKey {
  apiKey: string
  baseUrl?: string | null
  provider?: string | null
  model?: string | null
}

/** Injected in tests. `globalThis.fetch` everywhere else. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>

export interface MirroredEndpointSourceOptions {
  fetchImpl?: FetchLike
  now?: () => number
  ttlMs?: number
  timeoutMs?: number
}

type CacheEntry = { value: ResolvedEndpointKey; expiresAt: number }

/**
 * The process-wide cache, keyed `(clientId, externalId)`.
 *
 * Module scope rather than instance scope on purpose: a source is constructed
 * per request in the API layer and per job in the worker, and a cache that died
 * with the instance would be a cache that never hit. Nothing is written here
 * that is not also forgotten within {@link RESOLVED_KEY_TTL_MS}.
 */
const cache = new Map<string, CacheEntry>()

/**
 * Resolutions currently in flight, same key.
 *
 * Forty embed batches for one document start within milliseconds of each other
 * and all miss the empty cache. Without this they are forty simultaneous
 * resolver calls for one key; with it they are one call and thirty-nine
 * awaits.
 */
const inFlight = new Map<string, Promise<ResolvedEndpointKey>>()

function cacheKey(pairedClientId: string, externalId: string): string {
  // NUL, so a client id containing the separator cannot forge another's entry.
  return `${pairedClientId}\u0000${externalId}`
}

/** Drop every cached key. For tests, and for a source being reconfigured. */
export function clearResolvedKeyCache(): void {
  cache.clear()
  inFlight.clear()
}

/** How many entries are held. Tests assert the TTL through this. */
export function resolvedKeyCacheSize(): number {
  return cache.size
}

export class MirroredEndpointSource implements ModelEndpointSource {
  readonly pairedClientId: string
  private readonly resolver: MirroredResolver
  private readonly fetchImpl: FetchLike
  private readonly now: () => number
  private readonly ttlMs: number
  private readonly timeoutMs: number

  constructor(
    pairedClientId: string,
    resolver: MirroredResolver,
    options: MirroredEndpointSourceOptions = {}
  ) {
    this.pairedClientId = pairedClientId
    this.resolver = resolver
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init))
    this.now = options.now ?? Date.now
    this.ttlMs = options.ttlMs ?? RESOLVED_KEY_TTL_MS
    this.timeoutMs = options.timeoutMs ?? RESOLVER_TIMEOUT_MS
  }

  async embedding(binding: EndpointBinding): Promise<EmbeddingEndpoint> {
    const row = await this.row(binding.endpointId, 'embedding')
    const resolved = await this.resolveKey(row.externalId, row.id)
    return {
      id: row.id,
      providerId: resolved.provider ?? row.provider,
      template: row.template,
      modelName: resolved.model ?? row.model,
      apiKey: resolved.apiKey,
      baseUrl: resolved.baseUrl ?? row.baseUrl ?? undefined,
      config: (row.config as Record<string, unknown> | null) ?? {},
      dimensions: row.dimension ?? undefined,
    }
  }

  async inference(binding: EndpointBinding): Promise<InferenceEndpoint | null> {
    const row = await this.row(binding.endpointId, 'inference')
    const resolved = await this.resolveKey(row.externalId, row.id)
    return {
      id: row.id,
      providerId: resolved.provider ?? row.provider,
      template: row.template,
      modelName: resolved.model ?? row.model,
      apiKey: resolved.apiKey,
      baseUrl: resolved.baseUrl ?? row.baseUrl ?? undefined,
      config: (row.config as Record<string, unknown> | null) ?? {},
    }
  }

  /**
   * The key this client registered for a named provider, or null when it
   * registered none (the OCR step — see `source.ts`).
   *
   * Null means *the client has no endpoint for that provider*, which is a
   * configuration answer the caller already handles. A resolver that cannot be
   * reached is **not** that answer, and throws rather than reporting "no OCR
   * configured" — a temporary outage must not quietly change what a document
   * parses into.
   */
  async providerKey(binding: ProviderBinding): Promise<string | null> {
    const rows = await db
      .select()
      .from(modelEndpoint)
      .where(
        and(
          eq(modelEndpoint.pairedClientId, binding.pairedClientId),
          eq(modelEndpoint.provider, binding.provider),
          eq(modelEndpoint.source, 'mirrored')
        )
      )
      .limit(1)
    if (rows.length === 0) return null
    const row = rows[0]
    const resolved = await this.resolveKey(row.externalId, row.id)
    return resolved.apiKey || null
  }

  private async row(endpointId: string, kind: 'embedding' | 'inference') {
    const rows = await db
      .select()
      .from(modelEndpoint)
      .where(eq(modelEndpoint.id, endpointId))
      .limit(1)
    if (rows.length === 0) {
      throw new Error(`MirroredEndpointSource: endpoint not found: ${endpointId}`)
    }
    const row = rows[0]
    if (row.kind !== kind) {
      throw new Error(`MirroredEndpointSource: endpoint ${endpointId} is not ${kind}-kind`)
    }
    if (row.source !== 'mirrored') {
      throw new Error(
        `MirroredEndpointSource: endpoint ${endpointId} is local — it needs a LocalEndpointSource`
      )
    }
    return row
  }

  /** Cache-then-resolve, with the in-flight collapse. */
  private async resolveKey(
    externalId: string | null,
    endpointId: string
  ): Promise<ResolvedEndpointKey> {
    if (!externalId) {
      throw new EndpointKeyUnavailableError(
        `mirrored endpoint ${endpointId} carries no external id, so the resolver cannot be asked about it`,
        { reason: 'not-mirrored', endpointId, pairedClientId: this.pairedClientId }
      )
    }
    const key = cacheKey(this.pairedClientId, externalId)
    const hit = cache.get(key)
    if (hit && hit.expiresAt > this.now()) return hit.value
    if (hit) cache.delete(key)

    const pending = inFlight.get(key)
    if (pending) return pending

    const call = this.fetchKey(externalId, endpointId)
      .then((value) => {
        cache.set(key, { value, expiresAt: this.now() + this.ttlMs })
        return value
      })
      .finally(() => {
        inFlight.delete(key)
      })
    inFlight.set(key, call)
    return call
  }

  /** One resolver round trip. Everything that can go wrong is typed. */
  private async fetchKey(externalId: string, endpointId: string): Promise<ResolvedEndpointKey> {
    const context = {
      endpointId,
      externalId,
      pairedClientId: this.pairedClientId,
    }
    const origin = safeOrigin(this.resolver.resolverUrl)
    const body = JSON.stringify({
      workspaceId: this.resolver.resolverScope ?? this.pairedClientId,
      externalId,
    })

    let response: Response
    try {
      response = await this.fetchImpl(this.resolver.resolverUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          // The one place the resolver credential appears. Not in a URL, not
          // in a log, not in an error.
          'x-api-key': this.resolver.resolverKey,
        },
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (err) {
      const aborted = err instanceof Error && /abort|timeout/i.test(err.name + err.message)
      throw scrubSecret(
        new EndpointKeyUnavailableError(
          aborted
            ? `the endpoint resolver at ${origin} did not answer within ${this.timeoutMs}ms`
            : `the endpoint resolver at ${origin} could not be reached`,
          { reason: aborted ? 'timeout' : 'unreachable', ...context, cause: err }
        ),
        this.resolver.resolverKey
      )
    }

    if (response.status === 404) {
      throw new EndpointKeyUnavailableError(
        `the paired client does not know endpoint "${externalId}" any more — its mirror is stale`,
        { reason: 'unknown-endpoint', status: 404, ...context }
      )
    }
    if (response.status === 401 || response.status === 403) {
      throw new EndpointKeyUnavailableError(
        `the endpoint resolver at ${origin} refused this instance's credential (${response.status})`,
        { reason: 'unauthorized', status: response.status, ...context }
      )
    }
    if (!response.ok) {
      throw new EndpointKeyUnavailableError(
        `the endpoint resolver at ${origin} answered ${response.status}`,
        { reason: 'resolver-error', status: response.status, ...context }
      )
    }

    // The body is read and parsed, and **never** put into a message: it is the
    // one object in this file that holds a provider key.
    let parsed: unknown
    try {
      parsed = await response.json()
    } catch {
      throw new EndpointKeyUnavailableError(
        `the endpoint resolver at ${origin} answered ${response.status} with something that was not JSON`,
        { reason: 'malformed', status: response.status, ...context }
      )
    }
    const resolved = readResolution(parsed)
    if (!resolved) {
      throw new EndpointKeyUnavailableError(
        `the endpoint resolver at ${origin} answered ${response.status} without an apiKey`,
        { reason: 'malformed', status: response.status, ...context }
      )
    }

    // Deliberately no key material, no lengths, no prefix. What is useful in a
    // log is that the call happened and for which endpoint.
    logger.debug('Resolved a mirrored endpoint key', {
      pairedClientId: this.pairedClientId,
      endpointId,
      externalId,
      ttlMs: this.ttlMs,
    })
    return resolved
  }
}

/** Read the resolver's answer, or null when it is not one. */
function readResolution(value: unknown): ResolvedEndpointKey | null {
  if (!value || typeof value !== 'object') return null
  const o = value as Record<string, unknown>
  if (typeof o.apiKey !== 'string' || o.apiKey.length === 0) return null
  return {
    apiKey: o.apiKey,
    baseUrl: typeof o.baseUrl === 'string' && o.baseUrl ? o.baseUrl : null,
    provider: typeof o.provider === 'string' && o.provider ? o.provider : null,
    model: typeof o.model === 'string' && o.model ? o.model : null,
  }
}

/**
 * The resolver's origin, for a message.
 *
 * The origin and not the URL: a resolver's path is the client's business and a
 * query string is the one place a credential could plausibly have been put by
 * somebody who has not read ADR 0004.
 */
function safeOrigin(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return 'the configured resolver'
  }
}

/** The reasons, re-exported so a caller need not import two modules. */
export type { EndpointKeyUnavailableReason }
