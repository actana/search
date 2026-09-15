/**
 * API-key resolution for a locally-held model endpoint.
 *
 * A key can be stored two ways, distinguished STRUCTURALLY by fields on the
 * row's `config` JSONB — never by ciphertext shape, since every secret in the
 * instance shares the same AES-256-GCM stored form:
 *
 * 1. **plain** — the key, encrypted into `key_ciphertext`.
 * 2. **linked** — `config.apiKeyEndpointId` points at another endpoint
 *    belonging to the same paired client, whose key is used. "The same paired
 *    client" is enforced rather than assumed — see
 *    {@link resolveEndpointApiKey}.
 *
 * Every consumer of a local endpoint key resolves through
 * {@link resolveEndpointApiKey} so both modes behave identically everywhere.
 *
 * lifted: the third mode, **secret-backed**, went with Studio. It named a
 * *workspace environment variable* holding the key, and a workspace environment
 * is a Studio concept Search deliberately does not have (ADR 0002). Wired
 * deployments get the same property a different way and a better one: the key
 * is never in Search at all — it is resolved per job from the paired client's
 * own resolver (ADR 0004), which is what `MirroredEndpointSource` is for.
 * A mirrored row never reaches this file.
 */
import { and, eq } from 'drizzle-orm'
import { db } from '../db/client.ts'
import { modelEndpoint } from '../db/schema.ts'
import { decryptSecret } from '../core/security/encryption.ts'
import { EndpointKeyUnavailableError } from './endpoint-key-errors.ts'

/** The minimal endpoint-row shape needed to resolve its API key. */
export interface EndpointKeySource {
  keyCiphertext: string | null
  config: unknown
  /**
   * Who owns the row — and therefore which endpoints its `apiKeyEndpointId`
   * may name.
   *
   * Required, and not optional-with-a-default, because a caller that does not
   * know the owner cannot be allowed to follow a link: that is the hole this
   * field closes. Every call site selects the whole row
   * (`local-endpoint-source.ts`), so it has always had this to hand.
   */
  pairedClientId: string
}

/** The `config.apiKeyEndpointId` of an endpoint row, or `null` when not linked. */
export function readApiKeyEndpointId(config: unknown): string | null {
  if (!config || typeof config !== 'object') return null
  const id = (config as { apiKeyEndpointId?: unknown }).apiKeyEndpointId
  return typeof id === 'string' && id.length > 0 ? id : null
}

/**
 * Resolve an endpoint's plaintext API key, honoring both storage modes. A
 * linked endpoint is followed one level, matching Studio's behaviour at every
 * call site.
 *
 * **The link may only name an endpoint of the same paired client, and that is
 * checked here rather than trusted.** `config.apiKeyEndpointId` was followed by
 * id alone — and `config` is a `z.record(z.unknown())` on the wire, passed
 * straight through by `PUT /v1/endpoints`. So client B could declare a local
 * endpoint whose `config.apiKeyEndpointId` was *client A's* endpoint id, bind a
 * knowledge base to it, and embed a corpus with A's sealed key: A's credential,
 * spent by B, with nothing in either client's view of the instance to show it.
 * The id is a public value — Search answers with it on `PUT` and `GET
 * /v1/endpoints` — so knowing one is not a secret to protect.
 *
 * ADR 0004's rule is that an endpoint row is selected by id alone and a paired
 * client's ownership is the check *around* it (ADR 0010 D8); this is that check
 * on the link, where the row being read is not the row the caller named.
 *
 * Two shapes of miss, and they are different sentences:
 *
 *   * **The link names another client's endpoint.** Terminal, `client-mismatch`
 *     — the same reason `MirroredEndpointSource` uses for the same fact. Not a
 *     silent fall-back to this row's own key: a declaration that would have
 *     spent somebody else's credential is a mistake the operator has to see.
 *   * **The link names nothing at all.** The lifted behaviour stands: fall back
 *     to this row's own key, which is what Studio did at every call site and
 *     what a row that has one expects (ADR 0005).
 */
export async function resolveEndpointApiKey(endpoint: EndpointKeySource): Promise<string> {
  const linkedId = readApiKeyEndpointId(endpoint.config)
  if (linkedId) {
    const [linked] = await db
      .select({
        keyCiphertext: modelEndpoint.keyCiphertext,
        config: modelEndpoint.config,
      })
      .from(modelEndpoint)
      .where(
        and(
          eq(modelEndpoint.id, linkedId),
          // The whole of the fix. Everything else here is what it was.
          eq(modelEndpoint.pairedClientId, endpoint.pairedClientId)
        )
      )
      .limit(1)
    if (linked) {
      return decryptStoredKey(linked.keyCiphertext)
    }
    await refuseForeignLink(linkedId, endpoint.pairedClientId)
  }

  return decryptStoredKey(endpoint.keyCiphertext)
}

/**
 * Throw when `linkedId` exists but belongs to somebody else; return when it
 * does not exist at all.
 *
 * The second lookup is only reached on a miss, and only to tell the two apart:
 * "you linked to an endpoint that has been deleted" and "you linked to another
 * client's endpoint" are one query away from each other and a long way apart in
 * meaning.
 */
async function refuseForeignLink(linkedId: string, pairedClientId: string): Promise<void> {
  const [elsewhere] = await db
    .select({ pairedClientId: modelEndpoint.pairedClientId })
    .from(modelEndpoint)
    .where(eq(modelEndpoint.id, linkedId))
    .limit(1)
  if (!elsewhere) return
  throw new EndpointKeyUnavailableError(
    `endpoint ${linkedId} belongs to another paired client, so its key cannot be used here`,
    {
      reason: 'client-mismatch',
      endpointId: linkedId,
      pairedClientId,
    }
  )
}

/**
 * Decrypt a stored key, treating a blank column (a mirrored row, or one whose
 * ciphertext was stripped) as "no key" rather than a decrypt failure, so callers
 * surface their own missing-key error.
 */
async function decryptStoredKey(keyCiphertext: string | null): Promise<string> {
  if (!keyCiphertext) return ''
  return (await decryptSecret(keyCiphertext)).decrypted
}
