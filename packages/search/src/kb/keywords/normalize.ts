/**
 * Keyword normalisation rules.
 *
 * Keywords are tag-style: one short token, optionally two tokens joined by
 * an internal hyphen (e.g. `auth`, `sso`, `fade-out`, `rate-limit`). Multi-
 * word phrases and snippets of prose are rejected so the keyword set stays
 * usable as categories.
 *
 * Produces a `{ canonical, display }` pair:
 *   - `canonical` is lowercase, trimmed, whitespace-collapsed, and stripped
 *     of leading/trailing punctuation — used for dedup + DB lookup.
 *   - `display` preserves the original case but otherwise applies the same
 *     trim / collapse / trailing-punctuation rules — shown in the UI.
 *
 * Returns `null` when the input is empty, contains internal whitespace,
 * contains an emoji, has more than one internal hyphen, or has no letter
 * characters left after cleaning.
 */

const WHITESPACE_RUN = /\s+/g
const HAS_LETTER = /\p{L}/u
const HAS_EMOJI = /\p{Extended_Pictographic}/u
const HAS_INTERNAL_WHITESPACE = /\s/
const TRAILING_DROPPABLE = /[\s\p{P}]/u

/** Maximum characters allowed in a normalised keyword (covers `fade-out` and a bit more). */
const MAX_TOKEN_LENGTH = 32

/** Output of {@link normalizeKeyword}. */
export interface NormalizedKeyword {
  canonical: string
  display: string
}

/**
 * Normalise a raw keyword string.
 *
 * Multi-word phrases such as `runtime API surface` are rejected — only
 * single tokens (optionally a single hyphenated pair) survive.
 */
export function normalizeKeyword(input: string): NormalizedKeyword | null {
  if (typeof input !== 'string') return null
  if (HAS_EMOJI.test(input)) return null

  const collapsed = input.replace(WHITESPACE_RUN, ' ').trim()
  if (!collapsed) return null

  const stripped = stripSurroundingPunctuation(collapsed)
  if (!stripped) return null
  if (!HAS_LETTER.test(stripped)) return null
  if (HAS_INTERNAL_WHITESPACE.test(stripped)) return null
  if (stripped.length > MAX_TOKEN_LENGTH) return null

  const hyphenCount = (stripped.match(/-/g) ?? []).length
  if (hyphenCount > 1) return null
  if (hyphenCount === 1) {
    const [left, right] = stripped.split('-')
    if (!left || !right) return null
  }

  return {
    canonical: stripped.toLowerCase(),
    display: stripped,
  }
}

/**
 * Drop leading/trailing whitespace + punctuation, but preserve interior
 * apostrophes and hyphens since they're part of normal tokens.
 */
function stripSurroundingPunctuation(value: string): string {
  let start = 0
  while (start < value.length) {
    const ch = value[start]
    if (ch === "'" || ch === '-') break
    if (!TRAILING_DROPPABLE.test(ch)) break
    start += 1
  }
  let end = value.length
  while (end > start) {
    const ch = value[end - 1]
    if (ch === "'" || ch === '-') break
    if (!TRAILING_DROPPABLE.test(ch)) break
    end -= 1
  }
  return value.slice(start, end).trim()
}
