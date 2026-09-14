/**
 * Deterministic stand-in for the LLM keyword extractor used by the KB
 * behaviour freeze suite.
 *
 * Test-only. The fixture suite mocks `@/lib/models/inference` so that
 * `executeWorkspaceInference` returns `{"keywords": [...]}` built by
 * {@link deterministicKeywords}. Everything above the seam — the prompts,
 * `extractKeywordsForChunk`, `extractKeywordsForQuery`, `normalizeKeyword`,
 * the closed-set menu filter in `selectQueryKeywordsFromMenu`, and the
 * `kb-keywords-extract` worker — runs unmodified.
 *
 * ## Algorithm
 *
 * 1. Lowercase the text and split on every run of non-alphanumeric characters.
 * 2. Keep only tokens present in {@link TOPIC_VOCABULARY}.
 * 3. Count occurrences; sort by count descending, then token ascending.
 * 4. Return the first `limit` tokens.
 *
 * Single tokens only, so every survivor passes Studio's `normalizeKeyword`
 * (which rejects multi-word phrases).
 *
 * ## Why a closed topic list rather than "top-N frequent non-stopword tokens"
 *
 * Free-form frequency selection grows a vocabulary of several hundred
 * keywords. Studio then hands the model only the top 100 by usage count
 * (`EXISTING_KEYWORDS_TOP_N` in `lib/kb/keywords/select-from-menu.ts`), and
 * `listKbKeywords` orders by `usage_count DESC` with no tie-break — so which
 * keywords fall either side of the 100th place is up to Postgres. That made
 * the frozen query keywords differ between otherwise identical runs. Bounding
 * the vocabulary below 100 removes the truncation entirely and the fixture
 * becomes reproducible. Keywords are still derived from the text: a term is
 * only ever emitted for a chunk that actually contains it.
 */

/** Keywords returned per chunk. Studio requires 3..10 survivors per chunk. */
export const CHUNK_KEYWORD_LIMIT = 6

/** Keywords returned for a query before the closed-set menu filter applies. */
export const QUERY_KEYWORD_LIMIT = 6

/**
 * The closed topic list. Single lowercase tokens that occur in the fixture
 * corpus, spanning its five subject areas (people/handbook, security,
 * product, operations, API and data). Kept under 100 entries so the whole
 * vocabulary always fits inside Studio's query-time keyword menu.
 */
export const TOPIC_VOCABULARY: ReadonlySet<string> = new Set([
  // people and handbook
  'parental',
  'leave',
  'entitlement',
  'parent',
  'birth',
  'adoption',
  'payroll',
  'salary',
  'manager',
  'employee',
  'expense',
  'expenses',
  'receipt',
  'reimbursed',
  'reimbursement',
  'travel',
  'flights',
  'rail',
  'hotel',
  'meals',
  'mileage',
  'taxis',
  // security
  'security',
  'password',
  'passwords',
  'encryption',
  'laptop',
  'laptops',
  'phishing',
  'credentials',
  'authentication',
  'access',
  'production',
  // product
  'workflow',
  'workflows',
  'block',
  'blocks',
  'executor',
  'trigger',
  'deployment',
  'agent',
  'agents',
  'tool',
  'tools',
  'procedure',
  'procedures',
  'knowledge',
  'chunk',
  'chunks',
  'chunking',
  'embedding',
  'embeddings',
  'vector',
  'keyword',
  'keywords',
  'retrieval',
  'cluster',
  'clusters',
  'clustering',
  'semantic',
  'query',
  'queries',
  // operations
  'incident',
  'severity',
  'rotation',
  'escalation',
  'rollback',
  'backup',
  'backups',
  'vacuum',
  'index',
  'indexes',
  'replica',
  'replicas',
  'postgres',
  'migration',
  'migrations',
  'maintenance',
  // API and data
  'rate',
  'limit',
  'limits',
  'pagination',
  'cursor',
  'idempotency',
  'webhook',
  'webhooks',
  'redis',
  'timeout',
  'pool',
  'queue',
  'ticket',
  'tickets',
  'refund',
  'customer',
  'enterprise',
  'support',
  'changelog',
  'release',
])

/**
 * The `limit` most frequent {@link TOPIC_VOCABULARY} terms in `text`, ordered
 * by frequency then alphabetically. Stable for a given string.
 */
export function deterministicKeywords(text: string, limit: number): string[] {
  const counts = new Map<string, number>()
  for (const token of text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)) {
    if (!TOPIC_VOCABULARY.has(token)) continue
    counts.set(token, (counts.get(token) ?? 0) + 1)
  }

  return [...counts.entries()]
    .sort((a, b) => (b[1] - a[1] !== 0 ? b[1] - a[1] : a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, limit)
    .map(([token]) => token)
}

/**
 * The strict-JSON reply Studio's keyword prompts expect, so the mocked
 * inference seam returns exactly what a compliant model would.
 */
export function deterministicKeywordsResponse(text: string, limit: number): string {
  return JSON.stringify({ keywords: deterministicKeywords(text, limit) })
}

/** Marker that opens the chunk payload in `buildKeywordExtractionPrompt`. */
const CHUNK_TEXT_MARKER = '\nChunk text:\n'

/** Marker that closes both payloads. */
const SCHEMA_MARKER = '\n\nReturn strict JSON matching this schema:'

/** Prefix of the first line of `buildQueryKeywordExtractionPrompt`. */
const QUERY_MARKER = 'User query: '

/**
 * Recover the payload Studio's real keyword prompts wrap, and answer with the
 * strict JSON a compliant model would return.
 *
 * Chunk prompts carry the chunk between `Chunk text:` and the schema line;
 * query prompts put the query on the first line. Anything else yields an empty
 * keyword list, which Studio treats as "the model picked nothing".
 */
export function keywordsResponseForPrompt(userPrompt: string): string {
  if (userPrompt.startsWith(QUERY_MARKER)) {
    const firstLine = userPrompt.slice(QUERY_MARKER.length).split('\n')[0]
    return deterministicKeywordsResponse(firstLine, QUERY_KEYWORD_LIMIT)
  }

  const start = userPrompt.indexOf(CHUNK_TEXT_MARKER)
  if (start >= 0) {
    const from = start + CHUNK_TEXT_MARKER.length
    const end = userPrompt.indexOf(SCHEMA_MARKER, from)
    const payload = end > from ? userPrompt.slice(from, end) : userPrompt.slice(from)
    return deterministicKeywordsResponse(payload, CHUNK_KEYWORD_LIMIT)
  }

  return JSON.stringify({ keywords: [] })
}
