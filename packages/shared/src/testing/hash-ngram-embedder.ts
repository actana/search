/**
 * Deterministic, dependency-free hash n-gram embedder for the KB behaviour
 * freeze suite (`tasks/search-extraction/fixtures/kb-fixture.json`, embedder
 * spec `{ "kind": "hash-ngram", "dims": 256, "version": 1 }`).
 *
 * Test-only. Nothing in the production graph imports this file: the fixture
 * suite injects it through the existing provider seam by mocking
 * `@/lib/models/embedding`, so `ingestDocument` / `queryKb` / `createChunk`
 * run unmodified and need no API key.
 *
 * ## Algorithm (version 1) — copy this file byte for byte into `actana/search`
 *
 * 1. Lowercase the input.
 * 2. Split on every run of non-alphanumeric characters (`[^a-z0-9]+`) and drop
 *    empty pieces. The survivors are the tokens, in order.
 * 3. Build the gram list: every unigram `t[i]`, then every bigram
 *    `t[i] + "_" + t[i + 1]`, in that order. (Order does not affect the result —
 *    accumulation is commutative — but it is fixed so a port can be diffed.)
 * 4. For each gram compute `h = fnv1a32(gram)` (FNV-1a, 32-bit, offset basis
 *    `0x811c9dc5`, prime `0x01000193`, applied to the gram's UTF-16 code units
 *    masked to a byte — every gram is ASCII after step 2, so this equals the
 *    UTF-8 byte hash).
 *    - bucket  = `h % 256` (the low bits)
 *    - sign    = `-1` when bit 31 of `h` is set, `+1` otherwise
 *    - accumulate `sign` into `vec[bucket]`
 * 5. L2-normalise the 256-dim accumulator. An all-zero accumulator (empty or
 *    punctuation-only input) is returned as all zeros — never NaN.
 *
 * The result is a plain `number[]` of length {@link HASH_NGRAM_DIMS}.
 */

/** Vector width produced by {@link hashNgramEmbed}. Matches the fixture spec. */
export const HASH_NGRAM_DIMS = 256

/** Embedder spec version recorded in the fixture JSON. */
export const HASH_NGRAM_VERSION = 1

/** Identifier recorded in the fixture JSON's `embedder.kind`. */
export const HASH_NGRAM_KIND = 'hash-ngram'

const FNV_OFFSET_BASIS = 0x811c9dc5
const FNV_PRIME = 0x01000193
const NON_ALPHANUMERIC = /[^a-z0-9]+/

/**
 * FNV-1a, 32 bit, returned as an unsigned integer. Operates on the low byte of
 * each code unit, which is the UTF-8 encoding for the ASCII grams this module
 * produces.
 */
export function fnv1a32(value: string): number {
  let hash = FNV_OFFSET_BASIS
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i) & 0xff
    hash = Math.imul(hash, FNV_PRIME)
  }
  return hash >>> 0
}

/** Lowercase, split on non-alphanumerics, drop empties. */
export function tokenize(text: string): string[] {
  return text.toLowerCase().split(NON_ALPHANUMERIC).filter(Boolean)
}

/** Unigrams followed by bigrams (`a_b`), in token order. */
export function grams(tokens: string[]): string[] {
  const out: string[] = [...tokens]
  for (let i = 0; i + 1 < tokens.length; i++) {
    out.push(`${tokens[i]}_${tokens[i + 1]}`)
  }
  return out
}

/**
 * Embed one string into a deterministic, L2-normalised 256-dim vector.
 *
 * Pure: same input, same output, in any runtime, forever. That is the whole
 * point — the Search repo replays the same fixture against the same vectors.
 */
export function hashNgramEmbed(text: string): number[] {
  const vec = new Array<number>(HASH_NGRAM_DIMS).fill(0)
  for (const gram of grams(tokenize(text))) {
    const hash = fnv1a32(gram)
    const bucket = hash % HASH_NGRAM_DIMS
    const sign = (hash >>> 31) & 1 ? -1 : 1
    vec[bucket] += sign
  }

  let sumSquares = 0
  for (let i = 0; i < HASH_NGRAM_DIMS; i++) sumSquares += vec[i] * vec[i]
  if (sumSquares === 0) return vec

  const norm = Math.sqrt(sumSquares)
  for (let i = 0; i < HASH_NGRAM_DIMS; i++) vec[i] /= norm
  return vec
}

/** Convenience batch form matching the embedding seam's `input: string | string[]`. */
export function hashNgramEmbedMany(inputs: string | string[]): number[][] {
  const list = Array.isArray(inputs) ? inputs : [inputs]
  return list.map(hashNgramEmbed)
}

/**
 * Prompt-token accounting for the mocked embedding seam. Mirrors Studio's
 * `estimateTokens` convention (≈ 4 characters per token) so `usage` in the
 * frozen query results is a stable, explainable number rather than 0.
 */
export function hashNgramTokenCount(inputs: string | string[]): number {
  const list = Array.isArray(inputs) ? inputs : [inputs]
  return list.reduce((sum, text) => sum + Math.ceil(text.length / 4), 0)
}
