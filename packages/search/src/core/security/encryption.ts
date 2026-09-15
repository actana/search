/**
 * AES-256-GCM sealing, in the shape of Studio's
 * `lib/core/security/encryption.ts` so the lifted call sites read unchanged.
 *
 * Ciphertext format is identical — `iv:encrypted:authTag`, all hex — because
 * the phase-4 data move copies sealed endpoint keys across and a different
 * envelope would make every one of them unreadable.
 *
 * The key is `SEARCH_ENCRYPTION_KEY`, not Studio's `ENCRYPTION_KEY`. In wired
 * mode there is nothing here to seal: a mirrored endpoint's key never reaches
 * Search's disk (ADR 0004).
 *
 * lifted: Studio's `generatePassword`, the HMAC helpers and the API-key hashing
 * stayed behind — they serve Studio's own auth, and Search's identity is a
 * certificate (ADR 0003).
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'
import { createLogger } from '@actana/search-shared/log'
import { config } from '../../config.ts'

const logger = createLogger('Encryption')

/** What a bad or absent key says, in one place so boot and first use agree. */
const KEY_REQUIREMENT =
  'SEARCH_ENCRYPTION_KEY must be set to a 64-character hex string (32 bytes) — generate one with `openssl rand -hex 32`'

function getEncryptionKey(): Buffer {
  const key = config().SEARCH_ENCRYPTION_KEY
  // Hex-shaped and not merely 64 characters long: `Buffer.from(key, 'hex')`
  // stops at the first character that is not hex and hands back a *short* key
  // without complaining, so a typo would silently seal everything under a
  // 3-byte key and nothing would ever say so.
  if (!key || !/^[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error(KEY_REQUIREMENT)
  }
  return Buffer.from(key, 'hex')
}

/**
 * Fail at boot rather than at the first seal.
 *
 * Called by `index.ts` and by `worker.ts#bootWorker`. Without it an instance
 * with no `SEARCH_ENCRYPTION_KEY` starts, serves health, accepts a pairing —
 * and then fails the first `PUT /v1/endpoints` and the first job that needs a
 * mirrored key, each with a message about a cipher, hours after the mistake was
 * made. The key is required in *both* modes (ADR 0010 D7): standalone it seals
 * the provider keys, wired it seals the resolver credential that fetches them.
 */
export function assertEncryptionKeyConfigured(): void {
  getEncryptionKey()
}

/**
 * Encrypts a secret using AES-256-GCM.
 * @returns the encrypted secret in `iv:encrypted:authTag` form, and the IV
 */
export async function encryptSecret(secret: string): Promise<{ encrypted: string; iv: string }> {
  const iv = randomBytes(16)
  const key = getEncryptionKey()

  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 })
  let encrypted = cipher.update(secret, 'utf8', 'hex')
  encrypted += cipher.final('hex')

  const authTag = cipher.getAuthTag()
  const ivHex = iv.toString('hex')

  return {
    encrypted: `${ivHex}:${encrypted}:${authTag.toString('hex')}`,
    iv: ivHex,
  }
}

/**
 * Decrypts an encrypted secret.
 * @param encryptedValue - the encrypted value in `iv:encrypted:authTag` form
 */
export async function decryptSecret(encryptedValue: string): Promise<{ decrypted: string }> {
  const parts = encryptedValue.split(':')
  const ivHex = parts[0]
  const authTagHex = parts[parts.length - 1]
  const encrypted = parts.slice(1, -1).join(':')

  if (!ivHex || !encrypted || !authTagHex) {
    throw new Error('Invalid encrypted value format. Expected "iv:encrypted:authTag"')
  }

  const key = getEncryptionKey()
  const iv = Buffer.from(ivHex, 'hex')
  const authTag = Buffer.from(authTagHex, 'hex')

  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 })
    decipher.setAuthTag(authTag)

    let decrypted = decipher.update(encrypted, 'hex', 'utf8')
    decrypted += decipher.final('utf8')

    return { decrypted }
  } catch (error: unknown) {
    // Never the ciphertext, never the key — a decrypt failure says only that
    // it failed.
    logger.error('Decryption error:', {
      error: error instanceof Error ? error.message : 'Unknown error',
    })
    throw error
  }
}
