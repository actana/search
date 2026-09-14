/**
 * Query keyword-selection prompt builder.
 *
 * Produces the `{ system, user }` pair used by `extractKeywordsForQuery`.
 * Unlike chunk-time extraction, query-time is a **closed-set selection**:
 * the model must pick 0..10 keywords from the KB's existing vocabulary
 * (the menu) and is forbidden from inventing new ones. New vocabulary is
 * grown at ingest time, not at query time.
 */

/** Inputs to {@link buildQueryKeywordExtractionPrompt}. */
export interface BuildQueryKeywordExtractionPromptInput {
  query: string
  /** Existing KB keyword display labels — the menu the model selects from. */
  existingTopKeywords: string[]
}

/** Output of {@link buildQueryKeywordExtractionPrompt}. */
export interface QueryKeywordExtractionPrompt {
  system: string
  user: string
}

/** Max menu entries surfaced to the model in the prompt. */
const EXISTING_KEYWORD_MAX_DISPLAY = 200

/**
 * Build a `{ system, user }` pair that asks the model to **select** 0..10
 * keywords from the KB's existing keyword menu that best match the user
 * query. Inventing new keywords is explicitly forbidden — if nothing in
 * the menu fits, the model must return an empty list.
 */
export function buildQueryKeywordExtractionPrompt(
  input: BuildQueryKeywordExtractionPromptInput
): QueryKeywordExtractionPrompt {
  const { query, existingTopKeywords } = input

  const system = [
    'You select tag-keywords from a fixed menu to match a user search query.',
    'You MUST only return keywords copied verbatim from the provided menu.',
    'Do NOT invent, paraphrase, pluralise, hyphenate, or otherwise modify menu entries.',
    'If no menu entry fits the query, return an empty list.',
    'Return strict JSON.',
  ].join(' ')

  const menu = existingTopKeywords.length
    ? existingTopKeywords
        .slice(0, EXISTING_KEYWORD_MAX_DISPLAY)
        .map((k) => `- ${k}`)
        .join('\n')
    : '(menu is empty)'

  const user = [
    `User query: ${query}`,
    '',
    'Keyword menu (the ONLY allowed outputs):',
    menu,
    '',
    'Return strict JSON matching this schema:',
    '{ "keywords": string[] }',
    'Rules:',
    '- between 0 and 10 entries',
    '- every entry MUST appear verbatim in the menu above',
    '- if no menu entry matches the query, return { "keywords": [] }',
    '- no duplicates, no surrounding prose, no markdown fences',
    '',
    'Return the JSON now.',
  ].join('\n')

  return { system, user }
}
