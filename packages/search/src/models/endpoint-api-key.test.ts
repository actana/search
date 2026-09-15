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
import { EndpointKeyUnavailableError } from './endpoint-key-errors.ts'

/** Queue the rows the next `db.select().from().where().limit()` chain resolves to. */
function queueLinkedRow(rows: unknown[]) {
  mockSelect.mockReturnValueOnce({
    from: () => ({ where: () => ({ limit: () => Promise.resolve(rows) }) }),
  })
}

/** The owner of the row being resolved. Every real call site has one. */
const OWNER = 'pc-owner'

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
      pairedClientId: OWNER,
    })
    expect(key).toBe('dec(iv:ct:tag)')
    expect(mockSelect).not.toHaveBeenCalled()
  })

  it('treats a blank stored key as missing instead of failing to decrypt', async () => {
    const key = await resolveEndpointApiKey({
      keyCiphertext: '',
      config: {},
      pairedClientId: OWNER,
    })
    expect(key).toBe('')
    expect(mockDecryptSecret).not.toHaveBeenCalled()
  })

  it('treats a null stored key — a mirrored row — as missing', async () => {
    const key = await resolveEndpointApiKey({
      keyCiphertext: null,
      config: {},
      pairedClientId: OWNER,
    })
    expect(key).toBe('')
    expect(mockDecryptSecret).not.toHaveBeenCalled()
  })

  it('follows a linked endpoint one level and decrypts its key', async () => {
    queueLinkedRow([{ keyCiphertext: 'iv:linked:tag', config: {} }])
    const key = await resolveEndpointApiKey({
      keyCiphertext: '',
      config: { apiKeyEndpointId: 'ep-owner' },
      pairedClientId: OWNER,
    })
    expect(key).toBe('dec(iv:linked:tag)')
  })

  it('falls back to the row own key when the linked endpoint no longer exists', async () => {
    // Two lookups: the scoped one misses, and the second says the id is not
    // another client's either — it is simply gone. Studio's fall-back stands
    // for that case (ADR 0005).
    queueLinkedRow([])
    queueLinkedRow([])
    const key = await resolveEndpointApiKey({
      keyCiphertext: 'iv:own:tag',
      config: { apiKeyEndpointId: 'ep-gone' },
      pairedClientId: OWNER,
    })
    expect(key).toBe('dec(iv:own:tag)')
  })

  /**
   * The blocker. `config` is a `z.record(z.unknown())` on the wire and `PUT
   * /v1/endpoints` passes it through, so client B could declare a local
   * endpoint whose `config.apiKeyEndpointId` was client A's endpoint id — a
   * public value, answered by `GET /v1/endpoints` — bind a KB to it, and embed
   * a corpus with A's sealed key.
   */
  it('refuses a link to another paired client endpoint, terminally', async () => {
    // The scoped lookup misses…
    queueLinkedRow([])
    // …and the id exists, under somebody else.
    queueLinkedRow([{ pairedClientId: 'pc-somebody-else' }])

    const err = await resolveEndpointApiKey({
      keyCiphertext: 'iv:own:tag',
      config: { apiKeyEndpointId: 'ep-of-another-client' },
      pairedClientId: OWNER,
    })
      .then(() => null)
      .catch((e: unknown) => e)

    expect(err).toBeInstanceOf(EndpointKeyUnavailableError)
    const failure = err as EndpointKeyUnavailableError
    expect(failure.reason).toBe('client-mismatch')
    // Terminal: the next attempt is refused for the same reason (ADR 0010 D3).
    expect(failure.retryable).toBe(false)
    expect(failure.endpointId).toBe('ep-of-another-client')
    // And no key was decrypted on the way out — not the foreign row's, and not
    // this row's own as a consolation.
    expect(mockDecryptSecret).not.toHaveBeenCalled()
  })
})
