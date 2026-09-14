/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { getModel, listModels } from './index.ts'

describe('lib/models', () => {
  it('listModels({ kind: "embedding" }) includes the seeded openai embeddings', () => {
    const ids = listModels({ kind: 'embedding' }).map((m) => m.id)
    expect(ids).toContain('openai:text-embedding-3-small')
    expect(ids).toContain('openai:text-embedding-3-large')
    expect(ids).toContain('openai:text-embedding-ada-002')
  })

  // lifted: Studio asserted this returned a non-empty inference list. The
  // chat-model catalog is not lifted, so the assertion that survives is the one
  // that still means something — the inference branch never leaks an embedding.
  it('listModels({ kind: "inference", provider: "openai" }) excludes embeddings', () => {
    const models = listModels({ kind: 'inference', provider: 'openai' })
    expect(models.every((m) => m.kind === 'inference')).toBe(true)
  })

  it('getModel for an embedding id returns the right dimensions', () => {
    const m = getModel('openai:text-embedding-3-large')
    expect(m).not.toBeNull()
    expect(m?.kind).toBe('embedding')
    // EmbeddingModelDefinition carries `dimensions` at runtime
    expect((m as unknown as { dimensions: number }).dimensions).toBe(3072)
  })

  // lifted: was `resolves with kind=inference`. Without the chat catalog there
  // is nothing to resolve, and `null` for an id Search cannot dispatch to is
  // the honest answer.
  it('getModel for an inference id returns null — the chat catalog is Studio\'s', () => {
    expect(getModel('openai:gpt-4o')).toBeNull()
  })

  it('getModel returns null for an unknown id', () => {
    expect(getModel('openai:does-not-exist')).toBeNull()
    expect(getModel('not:a:thing')).toBeNull()
  })

  it('listModels() with no opts returns all entries', () => {
    const all = listModels()
    expect(all.some((m) => m.kind === 'embedding')).toBe(true)
    expect(all.every((m) => m.kind === 'embedding')).toBe(true)
  })
})
