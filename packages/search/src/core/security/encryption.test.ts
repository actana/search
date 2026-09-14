/**
 * Written here, not lifted. Studio has no unit test for `encryptSecret` /
 * `decryptSecret`, and the envelope is load-bearing for the phase-4 move — the
 * data migration copies sealed endpoint keys across, and a different
 * `iv:ciphertext:authTag` layout would make every one of them unreadable. So
 * the format is pinned by assertion rather than by hope.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { resetConfig } from '../../config.ts'
import { decryptSecret, encryptSecret } from './encryption.ts'

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
