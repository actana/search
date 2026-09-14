/**
 * @vitest-environment node
 *
 * Service tests for `lib/kb/keywords/service.ts`. We mock `@actana/db` with
 * a small chain-builder. Each chain (`select().from().where()...`) records
 * the first table referenced, and per-test handlers return the expected
 * rows for that table. Insert/update/delete operations are recorded so the
 * tests can assert dedup, usage-count bumps, and rollup behaviour.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const hoisted = vi.hoisted(() => {
  interface InnerState {
    calls: Array<{
      op: 'select' | 'insert' | 'update' | 'delete'
      table?: string
      values?: unknown
      setPatch?: Record<string, unknown>
    }>
    selectHandlers: Map<string, () => Promise<unknown[]>>
    insertHandlers: Map<string, (values: unknown) => Promise<unknown[]>>
    deleteHandlers: Map<string, () => Promise<unknown[]>>
  }
  const state: InnerState = {
    calls: [],
    selectHandlers: new Map(),
    insertHandlers: new Map(),
    deleteHandlers: new Map(),
  }
  const tableNameByRef = new WeakMap<object, string>()
  const makeTable = (name: string): Record<string, unknown> => {
    const t: Record<string, unknown> = { __tableName: name }
    tableNameByRef.set(t, name)
    return t
  }
  const tableName = (ref: unknown): string => {
    if (ref && typeof ref === 'object') {
      const n = tableNameByRef.get(ref as object)
      if (n) return n
    }
    return '?'
  }
  const buildSelectChain = () => {
    let primaryTable = '?'
    const exec = () => {
      const handler = state.selectHandlers.get(primaryTable)
      return Promise.resolve(handler ? handler() : [])
    }
    const chain: Record<string, unknown> = {}
    chain.from = (t: unknown) => {
      if (primaryTable === '?') primaryTable = tableName(t)
      return chain
    }
    chain.innerJoin = (_t: unknown, _on: unknown) => chain
    chain.leftJoin = (_t: unknown, _on: unknown) => chain
    chain.where = (_w: unknown) => chain
    chain.orderBy = (_o: unknown) => chain
    chain.groupBy = (_g: unknown) => chain
    chain.limit = (_n: number) => exec()
    ;(chain as { then: unknown }).then = (onFulfilled: (v: unknown[]) => unknown) =>
      exec().then(onFulfilled)
    return chain
  }
  const buildInsertChain = (table: unknown) => {
    const name = tableName(table)
    let storedValues: unknown
    const result = {
      values(v: unknown) {
        storedValues = v
        state.calls.push({ op: 'insert', table: name, values: v })
        return this
      },
      onConflictDoNothing() {
        return this
      },
      returning(_cols?: unknown) {
        const handler = state.insertHandlers.get(name)
        return Promise.resolve(handler ? handler(storedValues) : [])
      },
      then(onFulfilled: (v: unknown) => unknown) {
        return Promise.resolve(undefined).then(onFulfilled)
      },
    }
    return result
  }
  const buildUpdateChain = (table: unknown) => {
    const name = tableName(table)
    const result = {
      set(patch: Record<string, unknown>) {
        state.calls.push({ op: 'update', table: name, setPatch: patch })
        return this
      },
      where(_w: unknown) {
        return this
      },
      then(onFulfilled: (v: unknown) => unknown) {
        return Promise.resolve(undefined).then(onFulfilled)
      },
    }
    return result
  }
  const buildDeleteChain = (table: unknown) => {
    const name = tableName(table)
    state.calls.push({ op: 'delete', table: name })
    const result = {
      where(_w: unknown) {
        return this
      },
      returning(_cols?: unknown) {
        const handler = state.deleteHandlers.get(name)
        return Promise.resolve(handler ? handler() : [])
      },
      then(onFulfilled: (v: unknown) => unknown) {
        return Promise.resolve(undefined).then(onFulfilled)
      },
    }
    return result
  }
  const kbKeyword = Object.assign(makeTable('kb_keyword'), {
    id: 'kb_keyword.id',
    knowledgeBaseId: 'kb_keyword.knowledge_base_id',
    keyword: 'kb_keyword.keyword',
    displayLabel: 'kb_keyword.display_label',
    usageCount: 'kb_keyword.usage_count',
    createdAt: 'kb_keyword.created_at',
    updatedAt: 'kb_keyword.updated_at',
    createdByUserId: 'kb_keyword.created_by_user_id',
  })
  const embeddingKeyword = Object.assign(makeTable('embedding_keyword'), {
    embeddingId: 'ek.embedding_id',
    kbKeywordId: 'ek.kb_keyword_id',
    source: 'ek.source',
    createdAt: 'ek.created_at',
  })
  const documentKeyword = Object.assign(makeTable('document_keyword'), {
    documentId: 'dk.document_id',
    kbKeywordId: 'dk.kb_keyword_id',
    chunkCount: 'dk.chunk_count',
    updatedAt: 'dk.updated_at',
  })
  const embedding = Object.assign(makeTable('embedding'), {
    id: 'embedding.id',
    documentId: 'embedding.document_id',
    enabled: 'embedding.enabled',
  })
  type FakeDb = {
    select: (cols?: unknown) => ReturnType<typeof buildSelectChain>
    insert: (table: unknown) => ReturnType<typeof buildInsertChain>
    update: (table: unknown) => ReturnType<typeof buildUpdateChain>
    delete: (table: unknown) => ReturnType<typeof buildDeleteChain>
    transaction: (cb: (tx: FakeDb) => Promise<void>) => Promise<void>
  }
  const fakeDb: FakeDb = {
    select: (_cols?: unknown) => buildSelectChain(),
    insert: (table: unknown) => buildInsertChain(table),
    update: (table: unknown) => buildUpdateChain(table),
    delete: (table: unknown) => buildDeleteChain(table),
    transaction: async (cb: (tx: FakeDb) => Promise<void>) => cb(fakeDb),
  }
  return { state, kbKeyword, embeddingKeyword, documentKeyword, embedding, fakeDb }
})

vi.mock('../../db/schema.ts', () => ({
  kbKeyword: hoisted.kbKeyword,
  embeddingKeyword: hoisted.embeddingKeyword,
  documentKeyword: hoisted.documentKeyword,
  embedding: hoisted.embedding,
}))

vi.mock('../../db/client.ts', () => ({ db: hoisted.fakeDb }))

import {
  attachKeywordToChunk,
  detachKeywordFromChunk,
  recomputeDocumentKeywords,
  upsertKbKeyword,
} from './service.ts'

const { state } = hoisted

beforeEach(() => {
  state.calls = []
  state.selectHandlers.clear()
  state.insertHandlers.clear()
  state.deleteHandlers.clear()
})

describe('upsertKbKeyword', () => {
  it('returns the existing row and skips insert when canonical already exists', async () => {
    const existing = {
      id: 'kw-1',
      knowledgeBaseId: 'kb-1',
      keyword: 'react',
      displayLabel: 'React',
      usageCount: 4,
      createdAt: new Date(),
      updatedAt: new Date(),
      createdByUserId: null,
    }
    state.selectHandlers.set('kb_keyword', async () => [existing])

    const row = await upsertKbKeyword({ kbId: 'kb-1', displayLabel: 'React' })
    expect(row?.id).toBe('kw-1')
    const inserts = state.calls.filter((c) => c.op === 'insert' && c.table === 'kb_keyword')
    expect(inserts).toHaveLength(0)
  })

  it('inserts a new row when no existing canonical match is found', async () => {
    let lookupCount = 0
    state.selectHandlers.set('kb_keyword', async () => {
      lookupCount += 1
      if (lookupCount === 1) return []
      return [
        {
          id: 'kw-new',
          knowledgeBaseId: 'kb-1',
          keyword: 'graphql',
          displayLabel: 'GraphQL',
          usageCount: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
          createdByUserId: null,
        },
      ]
    })

    const row = await upsertKbKeyword({ kbId: 'kb-1', displayLabel: 'GraphQL' })
    expect(row?.id).toBe('kw-new')
    const inserts = state.calls.filter((c) => c.op === 'insert' && c.table === 'kb_keyword')
    expect(inserts).toHaveLength(1)
  })

  it('returns null for un-normalisable input without touching the DB', async () => {
    const row = await upsertKbKeyword({ kbId: 'kb-1', displayLabel: '😀' })
    expect(row).toBeNull()
    expect(state.calls).toHaveLength(0)
  })
})

describe('attachKeywordToChunk', () => {
  it('inserts the join row and bumps usage_count on first attach', async () => {
    state.insertHandlers.set('embedding_keyword', async () => [{ embeddingId: 'e-1' }])
    const res = await attachKeywordToChunk({
      embeddingId: 'e-1',
      kbKeywordId: 'kw-1',
      source: 'llm',
    })
    expect(res.inserted).toBe(true)
    const updates = state.calls.filter((c) => c.op === 'update' && c.table === 'kb_keyword')
    expect(updates).toHaveLength(1)
    expect(updates[0].setPatch).toHaveProperty('usageCount')
  })

  it('does NOT bump usage_count when the join row already exists', async () => {
    state.insertHandlers.set('embedding_keyword', async () => [])
    const res = await attachKeywordToChunk({
      embeddingId: 'e-1',
      kbKeywordId: 'kw-1',
      source: 'llm',
    })
    expect(res.inserted).toBe(false)
    const updates = state.calls.filter((c) => c.op === 'update' && c.table === 'kb_keyword')
    expect(updates).toHaveLength(0)
  })
})

describe('detachKeywordFromChunk', () => {
  it('decrements usage_count when a row was removed', async () => {
    state.deleteHandlers.set('embedding_keyword', async () => [{ embeddingId: 'e-1' }])
    const res = await detachKeywordFromChunk({ embeddingId: 'e-1', kbKeywordId: 'kw-1' })
    expect(res.removed).toBe(true)
    const updates = state.calls.filter((c) => c.op === 'update' && c.table === 'kb_keyword')
    expect(updates).toHaveLength(1)
  })

  it('is a no-op when nothing was removed', async () => {
    state.deleteHandlers.set('embedding_keyword', async () => [])
    const res = await detachKeywordFromChunk({ embeddingId: 'e-1', kbKeywordId: 'kw-1' })
    expect(res.removed).toBe(false)
    const updates = state.calls.filter((c) => c.op === 'update' && c.table === 'kb_keyword')
    expect(updates).toHaveLength(0)
  })
})

describe('recomputeDocumentKeywords', () => {
  it('clears prior rollup and reinserts one row per kb_keyword grouped from enabled chunks', async () => {
    state.selectHandlers.set('embedding_keyword', async () => [
      { kbKeywordId: 'kw-1', count: 3 },
      { kbKeywordId: 'kw-2', count: 1 },
    ])
    const res = await recomputeDocumentKeywords({ documentId: 'doc-1' })
    expect(res.rowCount).toBe(2)
    const deletes = state.calls.filter((c) => c.op === 'delete' && c.table === 'document_keyword')
    expect(deletes).toHaveLength(1)
    const inserts = state.calls.filter((c) => c.op === 'insert' && c.table === 'document_keyword')
    expect(inserts).toHaveLength(1)
    const values = inserts[0].values as Array<{ kbKeywordId: string; chunkCount: number }>
    expect(values).toHaveLength(2)
    expect(values.map((v) => v.kbKeywordId).sort()).toEqual(['kw-1', 'kw-2'])
    const kw1 = values.find((v) => v.kbKeywordId === 'kw-1')
    expect(kw1?.chunkCount).toBe(3)
  })

  it('only clears prior rollup when no rows survive (no insert)', async () => {
    state.selectHandlers.set('embedding_keyword', async () => [])
    const res = await recomputeDocumentKeywords({ documentId: 'doc-1' })
    expect(res.rowCount).toBe(0)
    const inserts = state.calls.filter((c) => c.op === 'insert' && c.table === 'document_keyword')
    expect(inserts).toHaveLength(0)
  })
})

describe('cascade on chunk delete', () => {
  it.todo('embedding_keyword.embedding_id has ON DELETE CASCADE — covered by the migration test')
})
