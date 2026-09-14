/**
 * API-key resolution for a locally-held model endpoint.
 *
 * A key can be stored two ways, distinguished STRUCTURALLY by fields on the
 * row's `config` JSONB — never by ciphertext shape, since every secret in the
 * instance shares the same AES-256-GCM stored form:
 *
 * 1. **plain** — the key, encrypted into `key_ciphertext`.
 * 2. **linked** — `config.apiKeyEndpointId` points at another endpoint
 *    belonging to the same paired client, whose key is used.
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
import { eq } from 'drizzle-orm'
import { db } from '../db/client.ts'
import { modelEndpoint } from '../db/schema.ts'
import { decryptSecret } from '../core/security/encryption.ts'

/** The minimal endpoint-row shape needed to resolve its API key. */
export interface EndpointKeySource {
  keyCiphertext: string | null
  config: unknown
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
      .where(eq(modelEndpoint.id, linkedId))
      .limit(1)
    if (linked) {
      return decryptStoredKey(linked.keyCiphertext)
    }
  }

  return decryptStoredKey(endpoint.keyCiphertext)
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
