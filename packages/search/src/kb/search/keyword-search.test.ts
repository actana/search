/**
 * @vitest-environment node
 *
 * Tests for `keywordSearch`. We mock `@actana/db` with a two-call select
 * chain — first call returns the matched `kb_keyword` rows, second returns
 * the joined `embedding_keyword × embedding` rows that drive the per-chunk
 * frequency aggregation.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const hoisted = vi.hoisted(() => {
  const state: {
    selectResponses: unknown[][]
    selectCount: number
  } = { selectResponses: [], selectCount: 0 }
  const buildSelectChain = () => {
    const exec = () => {
      const idx = state.selectCount
      state.selectCount += 1
      const rows = state.selectResponses[idx] ?? []
      return Promise.resolve(rows)
    }
    const chain: Record<string, unknown> = {}
    chain.from = (_t: unknown) => chain
    chain.innerJoin = (_t: unknown, _on: unknown) => chain
    chain.where = (_w: unknown) => chain
    ;(chain as { then: unknown }).then = (onFulfilled: (v: unknown[]) => unknown) =>
      exec().then(onFulfilled)
    return chain
  }
  const fakeDb = { select: (_cols?: unknown) => buildSelectChain() }
  return { state, fakeDb }
})

vi.mock('../../db/client.ts', () => ({ db: hoisted.fakeDb }))
vi.mock('../../db/schema.ts', () => ({
  kbKeyword: { id: 'kb_keyword.id', keyword: 'kb_keyword.keyword' },
  embeddingKeyword: { embeddingId: 'ek.embedding_id', kbKeywordId: 'ek.kb_keyword_id' },
  embedding: {
    id: 'embedding.id',
    documentId: 'embedding.document_id',
    enabled: 'embedding.enabled',
  },
  // lifted: added. `keywordSearch` joins `document` to filter deleted rows;
  // Studio's factory omitted it and vitest 3 let the miss through, vitest 4
  // does not.
  document: {
    id: 'document.id',
    deletedAt: 'document.deleted_at',
    archivedAt: 'document.archived_at',
    enabled: 'document.enabled',
  },
}))

import { keywordSearch } from './keyword-search.ts'

const { state } = hoisted

beforeEach(() => {
  state.selectResponses = []
  state.selectCount = 0
})

describe('keywordSearch', () => {
  it('returns [] for an empty query', async () => {
    const hits = await keywordSearch({ kbId: 'kb-1', query: '   ' })
    expect(hits).toEqual([])
  })

  it('scores exact matches at 1.0 and prefix-only matches at 0.6', async () => {
    // query is "graph" → tokens = ['graph']
    // matched kb_keywords: one exact ("graph"), one prefix-only ("graphql")
    state.selectResponses = [
      [
        { id: 'kw-graph', keyword: 'graph', displayLabel: 'Graph' },
        { id: 'kw-graphql', keyword: 'graphql', displayLabel: 'GraphQL' },
      ],
      [
        { embeddingId: 'c-1', documentId: 'd-1', kbKeywordId: 'kw-graph' },
        { embeddingId: 'c-2', documentId: 'd-1', kbKeywordId: 'kw-graphql' },
      ],
    ]
    const hits = await keywordSearch({ kbId: 'kb-1', query: 'graph' })
    expect(hits).toHaveLength(1)
    const doc = hits[0]
    const c1 = doc.chunks.find((c) => c.embeddingId === 'c-1')
    const c2 = doc.chunks.find((c) => c.embeddingId === 'c-2')
    expect(c1?.score).toBeCloseTo(1.0)
    expect(c2?.score).toBeCloseTo(0.6)
  })

  it('frequency aggregation: a chunk with two matched keywords scores higher than one', async () => {
    // query "react graphql" → both exact
    state.selectResponses = [
      [
        { id: 'kw-react', keyword: 'react', displayLabel: 'React' },
        { id: 'kw-gql', keyword: 'graphql', displayLabel: 'GraphQL' },
      ],
      [
        // chunk c-1 has BOTH keywords
        { embeddingId: 'c-1', documentId: 'd-1', kbKeywordId: 'kw-react' },
        { embeddingId: 'c-1', documentId: 'd-1', kbKeywordId: 'kw-gql' },
        // chunk c-2 has only one
        { embeddingId: 'c-2', documentId: 'd-1', kbKeywordId: 'kw-react' },
      ],
    ]
    const hits = await keywordSearch({ kbId: 'kb-1', query: 'react graphql' })
    expect(hits).toHaveLength(1)
    const chunks = hits[0].chunks
    expect(chunks[0].embeddingId).toBe('c-1')
    expect(chunks[0].score).toBeCloseTo(2.0)
    expect(chunks[1].embeddingId).toBe('c-2')
    expect(chunks[1].score).toBeCloseTo(1.0)
  })

  it('aggregates chunk scores into per-document totals and sorts hot docs first', async () => {
    state.selectResponses = [
      [{ id: 'kw-a', keyword: 'alpha', displayLabel: 'Alpha' }],
      [
        // doc-A has two chunks (each scored 1.0) → 2.0
        { embeddingId: 'c-1', documentId: 'doc-A', kbKeywordId: 'kw-a' },
        { embeddingId: 'c-2', documentId: 'doc-A', kbKeywordId: 'kw-a' },
        // doc-B has one chunk → 1.0
        { embeddingId: 'c-3', documentId: 'doc-B', kbKeywordId: 'kw-a' },
      ],
    ]
    const hits = await keywordSearch({ kbId: 'kb-1', query: 'alpha' })
    expect(hits.map((h) => h.documentId)).toEqual(['doc-A', 'doc-B'])
    expect(hits[0].score).toBeCloseTo(2.0)
    expect(hits[1].score).toBeCloseTo(1.0)
  })

  it('returns [] when no kb_keyword rows match', async () => {
    state.selectResponses = [[]]
    const hits = await keywordSearch({ kbId: 'kb-1', query: 'nothing' })
    expect(hits).toEqual([])
  })
})
