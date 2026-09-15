/**
 * Written here, not lifted. Studio has no unit test for `encryptSecret` /
 * `decryptSecret`, and the envelope is load-bearing for the phase-4 move — the
 * data migration copies sealed endpoint keys across, and a different
 * `iv:ciphertext:authTag` layout would make every one of them unreadable. So
 * the format is pinned by assertion rather than by hope.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { resetConfig } from '../../config.ts'
import {
  assertEncryptionKeyConfigured,
  decryptSecret,
  encryptSecret,
} from './encryption.ts'

describe('encryption', () => {
  beforeAll(() => {
    process.env.SEARCH_ENCRYPTION_KEY = 'a'.repeat(64)
    resetConfig()
  })

  it('round-trips a secret', async () => {
    const { encrypted } = await encryptSecret('sk-not-a-real-key')
    expect(encrypted).not.toContain('sk-not-a-real-key')
    expect(await decryptSecret(encrypted)).toEqual({ decrypted: 'sk-not-a-real-key' })
  })

  it('keeps the iv:ciphertext:authTag envelope Studio writes', async () => {
    const { encrypted, iv } = await encryptSecret('x')
    const parts = encrypted.split(':')
    expect(parts).toHaveLength(3)
    expect(parts[0]).toBe(iv)
    expect(parts[0]).toMatch(/^[0-9a-f]{32}$/)
    expect(parts[2]).toMatch(/^[0-9a-f]{32}$/)
  })

  it('produces a different envelope every time', async () => {
    const a = await encryptSecret('same')
    const b = await encryptSecret('same')
    expect(a.encrypted).not.toBe(b.encrypted)
  })

  it('refuses a tampered authentication tag', async () => {
    const { encrypted } = await encryptSecret('secret')
    const parts = encrypted.split(':')
    parts[2] = parts[2].replace(/^./, (c) => (c === '0' ? '1' : '0'))
    await expect(decryptSecret(parts.join(':'))).rejects.toThrow()
  })

  it('rejects a malformed envelope', async () => {
    await expect(decryptSecret('nope')).rejects.toThrow(/Invalid encrypted value format/)
  })
})

describe('the boot check', () => {
  /**
   * The key was validated nowhere. `encryptSecret` threw at the first *use* —
   * the first `PUT /v1/endpoints`, the first job that needed a mirrored key —
   * so an instance with no key started, paired, served health, and reported a
   * cipher error hours later to whoever happened to be adding an endpoint. It
   * is required in both modes (ADR 0010 D7), so `index.ts` and `bootWorker`
   * both call this before anything else.
   */
  const withKey = async (value: string | undefined, run: () => void) => {
    const before = process.env.SEARCH_ENCRYPTION_KEY
    if (value === undefined) delete process.env.SEARCH_ENCRYPTION_KEY
    else process.env.SEARCH_ENCRYPTION_KEY = value
    resetConfig()
    try {
      run()
    } finally {
      if (before === undefined) delete process.env.SEARCH_ENCRYPTION_KEY
      else process.env.SEARCH_ENCRYPTION_KEY = before
      resetConfig()
    }
  }

  it('passes on 64 hex characters', async () => {
    await withKey('a'.repeat(64), () => {
      expect(() => assertEncryptionKeyConfigured()).not.toThrow()
    })
  })

  it('fails loudly when the key is absent', async () => {
    await withKey(undefined, () => {
      expect(() => assertEncryptionKeyConfigured()).toThrow(/SEARCH_ENCRYPTION_KEY/)
    })
  })

  it('fails on the wrong length', async () => {
    await withKey('a'.repeat(32), () => {
      expect(() => assertEncryptionKeyConfigured()).toThrow(/SEARCH_ENCRYPTION_KEY/)
    })
  })

  it('fails on 64 characters that are not hex', async () => {
    // The one the length check missed: `Buffer.from(key, 'hex')` stops at the
    // first character that is not hex and hands back a *short* key without
    // complaining, so this used to seal everything under two bytes.
    await withKey(`zz${'a'.repeat(62)}`, () => {
      expect(() => assertEncryptionKeyConfigured()).toThrow(/hex/)
    })
  })
})
