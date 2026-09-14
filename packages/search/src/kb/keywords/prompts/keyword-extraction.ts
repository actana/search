/**
 * Keyword-extraction prompt builder (T5).
 *
 * Produces the `{ system, user }` pair handed to `executeWorkspaceInference`
 * inside `extractKeywordsForChunk`. The model is asked to return strict JSON
 * `{ "keywords": string[] }` with 3..10 entries, each ≤ 4 words, no
 * duplicates. Existing KB keywords are surfaced so the model preferentially
 * reuses them.
 */

/** Inputs to {@link buildKeywordExtractionPrompt}. */
export interface BuildKeywordExtractionPromptInput {
  chunkText: string
  filename: string
  /** Zero-indexed chunk position. */
  chunkIndex: number
  totalChunks: number
  /** Top-N existing KB keyword display labels (max ~100). */
  existingTopKeywords: string[]
}

/** Output of {@link buildKeywordExtractionPrompt}. */
export interface KeywordExtractionPrompt {
  system: string
  user: string
}

/** Hard cap on chunk text passed into the prompt. */
export const CHUNK_TEXT_MAX_CHARS = 3000

/** Max display-label length retained when summarising existing keywords. */
const EXISTING_KEYWORD_MAX_DISPLAY = 100

/**
 * Build a `{ system, user }` pair for chunk-level keyword extraction.
 *
 * The output schema requested from the model is
 * `{ "keywords": string[] }` with 3..10 entries, each ≤ 4 words, no
 * duplicates. Post-validation (length, letter-content, dedupe) runs in
 * `extract.ts`.
 */
export function buildKeywordExtractionPrompt(
  input: BuildKeywordExtractionPromptInput
): KeywordExtractionPrompt {
  const { chunkText, filename, chunkIndex, totalChunks, existingTopKeywords } = input

  const system = [
    'You extract short tag-style topic keywords from a document chunk.',
    'Treat keywords as categories/tags, not phrases. Strongly prefer reusing keywords from the provided list when they fit.',
    'Return strict JSON.',
  ].join(' ')

  const existing = existingTopKeywords.length
    ? existingTopKeywords.slice(0, EXISTING_KEYWORD_MAX_DISPLAY).join(', ')
    : '(none)'

  const truncated =
    chunkText.length > CHUNK_TEXT_MAX_CHARS
      ? `${chunkText.slice(0, CHUNK_TEXT_MAX_CHARS)}…`
      : chunkText

  const position = `${chunkIndex + 1}/${totalChunks}`

  const user = [
    `File: ${filename}`,
    `Chunk: ${position}`,
    `Existing keywords (reuse when applicable): ${existing}`,
    '',
    'Chunk text:',
    truncated,
    '',
    'Return strict JSON matching this schema:',
    '{ "keywords": string[] }',
    'Rules:',
    '- exactly 3 to 10 entries',
    '- each entry is a single lowercase word, OR two words joined with a single hyphen (e.g. "auth", "sso", "fade-out", "rate-limit")',
    '- NEVER use spaces inside a keyword; multi-word phrases like "runtime API surface" are forbidden',
    '- each entry is a category/tag, not a snippet of prose',
    '- reuse an existing keyword verbatim when the topic matches',
    '- no duplicates, no surrounding prose, no markdown fences',
    '',
    'Return the JSON now.',
  ].join('\n')

  return { system, user }
}
