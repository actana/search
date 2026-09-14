/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockQueryKb } = vi.hoisted(() => ({ mockQueryKb: vi.fn() }))

vi.mock('./query.ts', () => ({
  queryKb: mockQueryKb,
}))

// lifted: added. `handleKbQuery` resolves the KB's query keywords before it
// calls `queryKb`, and that reads the database. Studio's suite ran with a `.env`
// pointing at a live Postgres, so the read quietly succeeded; a unit test should
// not need one.
vi.mock('./keywords/select-from-menu.ts', () => ({
  selectQueryKeywordsFromMenu: vi.fn(async () => []),
}))

import { handleKbQuery, kbQueryBodySchema } from './query-handler.ts'

describe('kbQueryBodySchema', () => {
  it('rejects empty kbId', () => {
    expect(kbQueryBodySchema.safeParse({ kbId: '', text: 'q' }).success).toBe(false)
  })
  it('rejects topK > 50', () => {
    expect(kbQueryBodySchema.safeParse({ kbId: 'k', text: 'q', topK: 999 }).success).toBe(false)
  })
  it('accepts minimal body', () => {
    expect(kbQueryBodySchema.safeParse({ kbId: 'k', text: 'q' }).success).toBe(true)
  })
})

describe('handleKbQuery', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })
  it('forwards args to queryKb', async () => {
    mockQueryKb.mockResolvedValue({ matches: [] })
    const result = await handleKbQuery(
      { pairedClientId: 'pc', source: 'sdk' },
      { kbId: 'kb', text: 'q', topK: 3 }
    )
    expect(mockQueryKb).toHaveBeenCalledWith(
      expect.objectContaining({ kbId: 'kb', text: 'q', topK: 3 })
    )
    expect(result).toEqual({ matches: [] })
  })
})
