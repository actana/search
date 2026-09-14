/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockKeyword, mockSemantic } = vi.hoisted(() => ({
  mockKeyword: vi.fn(),
  mockSemantic: vi.fn(),
}))

vi.mock('./keyword-search.ts', () => ({
  keywordSearch: mockKeyword,
}))
vi.mock('./semantic-search.ts', () => ({
  semanticSearch: mockSemantic,
}))

import { mixedSearch } from './mixed-search.ts'

beforeEach(() => {
  vi.clearAllMocks()
})

function kwHit(documentId: string, chunks: Array<{ id: string; score: number }>) {
  return {
    documentId,
    score: chunks.reduce((s, c) => s + c.score, 0),
    chunks: chunks.map((c) => ({
      embeddingId: c.id,
      score: c.score,
      matchedKeywords: [`m-${c.id}`],
    })),
  }
}
function semHit(documentId: string, chunks: Array<{ id: string; score: number }>) {
  return {
    documentId,
    score: chunks.reduce((s, c) => s + c.score, 0),
    chunks: chunks.map((c) => ({
      embeddingId: c.id,
      score: c.score,
      matchedKeywords: [],
    })),
  }
}

describe('mixedSearch', () => {
  it('normalises each side to [0,1] (top = 1.0, bottom = 0.0)', async () => {
    mockKeyword.mockResolvedValue([
      kwHit('doc-A', [
        { id: 'c-1', score: 4 },
        { id: 'c-2', score: 1 },
      ]),
    ])
    mockSemantic.mockResolvedValue([
      semHit('doc-A', [
        { id: 'c-1', score: 0.9 },
        { id: 'c-2', score: 0.3 },
      ]),
    ])
    const hits = await mixedSearch({ kbId: 'kb-1', query: 'x' })
    const doc = hits[0]
    const c1 = doc.chunks.find((c) => c.embeddingId === 'c-1')!
    const c2 = doc.chunks.find((c) => c.embeddingId === 'c-2')!
    expect(c1.keywordScore).toBeCloseTo(1)
    expect(c2.keywordScore).toBeCloseTo(0)
    expect(c1.semanticScore).toBeCloseTo(1)
    expect(c2.semanticScore).toBeCloseTo(0)
  })

  it('blends with default 50/50 weights to produce expected ordering', async () => {
    // c-1: keyword high, semantic low. c-2: keyword low, semantic high.
    // With 50/50 they should tie at 0.5; we also include c-3 which dominates
    // both sides so it ranks first.
    mockKeyword.mockResolvedValue([
      kwHit('doc-A', [
        { id: 'c-1', score: 10 },
        { id: 'c-2', score: 0 },
        { id: 'c-3', score: 10 },
      ]),
    ])
    mockSemantic.mockResolvedValue([
      semHit('doc-A', [
        { id: 'c-1', score: 0 },
        { id: 'c-2', score: 1 },
        { id: 'c-3', score: 1 },
      ]),
    ])
    const hits = await mixedSearch({ kbId: 'kb-1', query: 'x' })
    const chunks = hits[0].chunks
    expect(chunks[0].embeddingId).toBe('c-3')
    expect(chunks[0].score).toBeCloseTo(1.0)
    // c-1 and c-2 tied at 0.5
    const c1 = chunks.find((c) => c.embeddingId === 'c-1')!
    const c2 = chunks.find((c) => c.embeddingId === 'c-2')!
    expect(c1.score).toBeCloseTo(0.5)
    expect(c2.score).toBeCloseTo(0.5)
  })

  it('weight override (keyword-heavy) flips ordering vs semantic-heavy', async () => {
    mockKeyword.mockResolvedValue([
      kwHit('doc-A', [
        { id: 'c-keyword-winner', score: 10 },
        { id: 'c-semantic-winner', score: 0 },
      ]),
    ])
    mockSemantic.mockResolvedValue([
      semHit('doc-A', [
        { id: 'c-keyword-winner', score: 0 },
        { id: 'c-semantic-winner', score: 1 },
      ]),
    ])
    const keywordHeavy = await mixedSearch({
      kbId: 'kb-1',
      query: 'x',
      weights: { semantic: 0.3, keyword: 0.7 },
    })
    expect(keywordHeavy[0].chunks[0].embeddingId).toBe('c-keyword-winner')

    const semanticHeavy = await mixedSearch({
      kbId: 'kb-1',
      query: 'x',
      weights: { semantic: 0.7, keyword: 0.3 },
    })
    expect(semanticHeavy[0].chunks[0].embeddingId).toBe('c-semantic-winner')
  })

  it('handles chunks present on only one side (missing-side score = 0)', async () => {
    mockKeyword.mockResolvedValue([kwHit('doc-A', [{ id: 'c-only-kw', score: 5 }])])
    mockSemantic.mockResolvedValue([semHit('doc-A', [{ id: 'c-only-sem', score: 0.9 }])])
    const hits = await mixedSearch({ kbId: 'kb-1', query: 'x' })
    const chunks = hits[0].chunks
    expect(chunks).toHaveLength(2)
    const onlyKw = chunks.find((c) => c.embeddingId === 'c-only-kw')!
    expect(onlyKw.semanticScore).toBe(0)
    const onlySem = chunks.find((c) => c.embeddingId === 'c-only-sem')!
    expect(onlySem.keywordScore).toBe(0)
  })
})
