/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { normalizeKeyword } from './normalize.ts'

describe('normalizeKeyword', () => {
  it('lowercases the canonical form while preserving display case', () => {
    const res = normalizeKeyword('GraphQL')
    expect(res).toEqual({ canonical: 'graphql', display: 'GraphQL' })
  })

  it('treats uppercase input as lowercase canonical', () => {
    const res = normalizeKeyword('GRAPHQL')
    expect(res).toEqual({ canonical: 'graphql', display: 'GRAPHQL' })
  })

  it('strips trailing punctuation', () => {
    const res = normalizeKeyword('typescript!?.,;:')
    expect(res?.canonical).toBe('typescript')
    expect(res?.display).toBe('typescript')
  })

  it('strips leading punctuation', () => {
    const res = normalizeKeyword('.acl')
    expect(res?.canonical).toBe('acl')
  })

  it('keeps a single internal hyphen', () => {
    const res = normalizeKeyword('fade-out')
    expect(res).toEqual({ canonical: 'fade-out', display: 'fade-out' })
  })

  it('keeps internal apostrophes', () => {
    const res = normalizeKeyword(`it's`)
    expect(res).toEqual({ canonical: `it's`, display: `it's` })
  })

  it('rejects multi-word phrases', () => {
    expect(normalizeKeyword('machine learning')).toBeNull()
    expect(normalizeKeyword('runtime API surface')).toBeNull()
    expect(normalizeKeyword('  data\t\t  science\n')).toBeNull()
  })

  it('rejects entries with multiple hyphens', () => {
    expect(normalizeKeyword('foo-bar-baz')).toBeNull()
  })

  it('rejects emoji-bearing inputs by returning null', () => {
    expect(normalizeKeyword('happy 😀 path')).toBeNull()
    expect(normalizeKeyword('🚀launch')).toBeNull()
  })

  it('rejects letter-less input', () => {
    expect(normalizeKeyword('1234')).toBeNull()
    expect(normalizeKeyword('---')).toBeNull()
    expect(normalizeKeyword('   ')).toBeNull()
    expect(normalizeKeyword('')).toBeNull()
  })

  it('rejects overlong tokens', () => {
    expect(normalizeKeyword('a'.repeat(40))).toBeNull()
  })

  it('rejects non-string input', () => {
    // @ts-expect-error intentional bad input
    expect(normalizeKeyword(123)).toBeNull()
    // @ts-expect-error intentional bad input
    expect(normalizeKeyword(null)).toBeNull()
  })
})
