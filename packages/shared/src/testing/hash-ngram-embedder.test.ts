/**
 * @vitest-environment node
 *
 * Locks the hash n-gram embedder's algorithm. The KB behaviour freeze and the
 * `actana/search` repo both depend on this file producing identical vectors
 * forever, so these assertions are contract, not coverage.
 */
import { describe, expect, it } from 'vitest'
import {
  fnv1a32,
  grams,
  HASH_NGRAM_DIMS,
  HASH_NGRAM_KIND,
  HASH_NGRAM_VERSION,
  hashNgramEmbed,
  hashNgramEmbedMany,
  hashNgramTokenCount,
  tokenize,
} from './hash-ngram-embedder.ts'

/** Cosine similarity of two equal-length vectors. */
function cosine(a: number[], b: number[]): number {
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i]
  return dot
}

describe('hash-ngram embedder spec', () => {
  it('declares the fixture spec', () => {
    expect(HASH_NGRAM_KIND).toBe('hash-ngram')
    expect(HASH_NGRAM_DIMS).toBe(256)
    expect(HASH_NGRAM_VERSION).toBe(1)
  })

  it('computes FNV-1a 32-bit over known vectors', () => {
    expect(fnv1a32('')).toBe(0x811c9dc5)
    expect(fnv1a32('a')).toBe(0xe40c292c)
    expect(fnv1a32('foobar')).toBe(0xbf9cf968)
  })

  it('lowercases and splits on every non-alphanumeric run', () => {
    expect(tokenize('Parental Leave — 20 weeks!')).toEqual(['parental', 'leave', '20', 'weeks'])
    expect(tokenize('  ...  ')).toEqual([])
    expect(tokenize('rate-limit/retry_after')).toEqual(['rate', 'limit', 'retry', 'after'])
  })

  it('emits unigrams then bigrams', () => {
    expect(grams(['a', 'b', 'c'])).toEqual(['a', 'b', 'c', 'a_b', 'b_c'])
    expect(grams(['solo'])).toEqual(['solo'])
    expect(grams([])).toEqual([])
  })
})

describe('hashNgramEmbed', () => {
  it('returns an L2-normalised vector of the declared width', () => {
    const vec = hashNgramEmbed('parental leave entitlement for a birthing parent')
    expect(vec).toHaveLength(HASH_NGRAM_DIMS)
    const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0))
    expect(norm).toBeCloseTo(1, 12)
  })

  it('is deterministic across calls', () => {
    const text = 'incident severity levels and the on-call rotation'
    expect(hashNgramEmbed(text)).toEqual(hashNgramEmbed(text))
  })

  it('ignores case and punctuation', () => {
    expect(hashNgramEmbed('Redis connection pool!')).toEqual(
      hashNgramEmbed('  redis,connection  POOL ')
    )
  })

  it('returns all zeros — never NaN — for empty and punctuation-only input', () => {
    for (const text of ['', '   ', '--- ... ---']) {
      const vec = hashNgramEmbed(text)
      expect(vec).toHaveLength(HASH_NGRAM_DIMS)
      expect(vec.every((v) => v === 0)).toBe(true)
    }
  })

  it('ranks a related passage above an unrelated one', () => {
    const query = hashNgramEmbed('parental leave entitlement')
    const related = hashNgramEmbed(
      'A birthing parent receives twenty weeks of fully paid parental leave, and the entitlement is per child.'
    )
    const unrelated = hashNgramEmbed(
      'Build every index concurrently and reindex during the Sunday maintenance window.'
    )
    expect(cosine(query, related)).toBeGreaterThan(cosine(query, unrelated))
  })

  it('separates word order through bigrams', () => {
    const forward = hashNgramEmbed('leave parental')
    const backward = hashNgramEmbed('parental leave')
    expect(forward).not.toEqual(backward)
  })

  it('pins a known vector so a port can be diffed', () => {
    const vec = hashNgramEmbed('rate limit')
    const nonZero = vec
      .map((value, index) => ({ index, value: Number(value.toFixed(6)) }))
      .filter((entry) => entry.value !== 0)
    expect(nonZero).toEqual([
      { index: 52, value: 0.57735 },
      { index: 103, value: -0.57735 },
      { index: 155, value: 0.57735 },
    ])
  })
})

describe('hashNgramEmbedMany / hashNgramTokenCount', () => {
  it('accepts a single string or an array and preserves order', () => {
    const one = hashNgramEmbedMany('alpha')
    expect(one).toHaveLength(1)
    expect(one[0]).toEqual(hashNgramEmbed('alpha'))

    const many = hashNgramEmbedMany(['alpha', 'beta'])
    expect(many).toHaveLength(2)
    expect(many[1]).toEqual(hashNgramEmbed('beta'))
  })

  it('counts tokens at roughly four characters each', () => {
    expect(hashNgramTokenCount('abcd')).toBe(1)
    expect(hashNgramTokenCount('abcde')).toBe(2)
    expect(hashNgramTokenCount(['abcd', 'abcd'])).toBe(2)
  })
})
