/**
 * Closed-set query-keyword selection.
 *
 * At query time we never grow the keyword vocabulary — we only **select**
 * from the menu of existing `kb_keyword` rows. New vocabulary is added at
 * ingest time via {@link extractKeywordsForChunk}. This helper is the
 * single source of truth shared by:
 *   - the search-bar route (`/api/knowledge/[id]/search`)
 *   - the SDK runtime route (`/api/apps/runtime/kb/query` → `handleKbQuery`)
 *   - the in-process executor handler for the `kb_query` workflow block
 */

import { db } from '../../db/client.ts'
import { kbKeyword, knowledgeBase } from '../../db/schema.ts'
import { createLogger } from '@actana/search-shared/log'
import { desc, eq } from 'drizzle-orm'
import { extractKeywordsForQuery } from './extract.ts'

const logger = createLogger('kb/keywords/select-from-menu')

/** How many existing KB keywords are surfaced to the LLM as the selection menu. */
const EXISTING_KEYWORDS_TOP_N = 100

export interface SelectQueryKeywordsInput {
  kbId: string
  text: string
}

/**
 * Pick query keywords from the KB's existing vocabulary. Returns the
 * canonical form of every survivor — the value passed straight into
 * `queryKb.queryKeywordCanonicals`. Returns `[]` (semantic-only fallback)
 * when the KB has no inference endpoint, no keywords yet, or the LLM
 * picked nothing that matched the menu.
 */
export async function selectQueryKeywordsFromMenu(
  input: SelectQueryKeywordsInput
): Promise<string[]> {
  const [kbRow] = await db
    .select({
      inferenceEndpointId: knowledgeBase.inferenceEndpointId,
      workspaceId: knowledgeBase.pairedClientId,
    })
    .from(knowledgeBase)
    .where(eq(knowledgeBase.id, input.kbId))
    .limit(1)

  if (!kbRow?.inferenceEndpointId || !kbRow.workspaceId) return []

  const topKeywords = await db
    .select({
      canonical: kbKeyword.keyword,
      displayLabel: kbKeyword.displayLabel,
    })
    .from(kbKeyword)
    .where(eq(kbKeyword.knowledgeBaseId, input.kbId))
    .orderBy(desc(kbKeyword.usageCount))
    .limit(EXISTING_KEYWORDS_TOP_N)

  if (topKeywords.length === 0) return []

  const extracted = await extractKeywordsForQuery({
    query: input.text,
    existingTopKeywords: topKeywords.map((k) => k.displayLabel),
    existingTopCanonicals: topKeywords.map((k) => k.canonical),
    workspaceId: kbRow.workspaceId,
    inferenceEndpointId: kbRow.inferenceEndpointId,
  })
  const canonicals = extracted.map((k) => k.canonical)
  logger.info('selectQueryKeywordsFromMenu', {
    kbId: input.kbId,
    menuSize: topKeywords.length,
    selected: canonicals,
  })
  return canonicals
}
