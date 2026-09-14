/**
 * Tests for the model-endpoint API-key resolver: plain and linked
 * (`config.apiKeyEndpointId`) storage modes.
 *
 * lifted: the secret-backed cases went with the mode itself — it named a
 * workspace environment variable, and Search has no workspace environment (see
 * `endpoint-api-key.ts`). Everything else is Studio's suite with
 * `workspaceId`/`encryptedApiKey` renamed to the columns Search stores.
 *
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockSelect, mockDecryptSecret } = vi.hoisted(() => ({
  mockSelect: vi.fn(),
  mockDecryptSecret: vi.fn(),
}))

vi.mock('../db/client.ts', () => ({ db: { select: mockSelect } }))
vi.mock('../core/security/encryption.ts', () => ({ decryptSecret: mockDecryptSecret }))

import { readApiKeyEndpointId, resolveEndpointApiKey } from './endpoint-api-key.ts'

/** Queue the rows the next `db.select().from().where().limit()` chain resolves to. */
function queueLinkedRow(rows: unknown[]) {
  mockSelect.mockReturnValueOnce({
    from: () => ({ where: () => ({ limit: () => Promise.resolve(rows) }) }),
  })
}

describe('config readers', () => {
  it('read the structural key-mode field, tolerating malformed config', () => {
    expect(readApiKeyEndpointId({ apiKeyEndpointId: 'ep-1' })).toBe('ep-1')
    expect(readApiKeyEndpointId({ apiKeyEndpointId: '' })).toBeNull()
    expect(readApiKeyEndpointId({})).toBeNull()
    expect(readApiKeyEndpointId(null)).toBeNull()
    expect(readApiKeyEndpointId('nonsense')).toBeNull()
  })
})

describe('resolveEndpointApiKey', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockDecryptSecret.mockImplementation(async (value: string) => ({
      decrypted: `dec(${value})`,
    }))
  })

  it('decrypts a plain stored key', async () => {
    const key = await resolveEndpointApiKey({
      keyCiphertext: 'iv:ct:tag',
      config: {},
    })
    expect(key).toBe('dec(iv:ct:tag)')
    expect(mockSelect).not.toHaveBeenCalled()
  })

  it('treats a blank stored key as missing instead of failing to decrypt', async () => {
    const key = await resolveEndpointApiKey({
      keyCiphertext: '',
      config: {},
    })
    expect(key).toBe('')
    expect(mockDecryptSecret).not.toHaveBeenCalled()
  })

  it('treats a null stored key — a mirrored row — as missing', async () => {
    const key = await resolveEndpointApiKey({
      keyCiphertext: null,
      config: {},
    })
    expect(key).toBe('')
    expect(mockDecryptSecret).not.toHaveBeenCalled()
  })

  it('follows a linked endpoint one level and decrypts its key', async () => {
    queueLinkedRow([{ keyCiphertext: 'iv:linked:tag', config: {} }])
    const key = await resolveEndpointApiKey({
      keyCiphertext: '',
      config: { apiKeyEndpointId: 'ep-owner' },
    })
    expect(key).toBe('dec(iv:linked:tag)')
  })

  it('falls back to the row own key when the linked endpoint no longer exists', async () => {
    queueLinkedRow([])
    const key = await resolveEndpointApiKey({
      keyCiphertext: 'iv:own:tag',
      config: { apiKeyEndpointId: 'ep-gone' },
    })
    expect(key).toBe('dec(iv:own:tag)')
  })
})
