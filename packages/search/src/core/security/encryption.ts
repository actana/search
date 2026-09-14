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

function getEncryptionKey(): Buffer {
  const key = config().SEARCH_ENCRYPTION_KEY
  if (!key || key.length !== 64) {
    throw new Error('SEARCH_ENCRYPTION_KEY must be set to a 64-character hex string (32 bytes)')
  }
  return Buffer.from(key, 'hex')
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
