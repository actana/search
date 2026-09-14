import { createLogger } from '@actana/search-shared/log'
import { z } from 'zod'
import { selectQueryKeywordsFromMenu } from './keywords/select-from-menu.ts'
import { queryKb } from './query.ts'

const logger = createLogger('KbQueryHandler')

/**
 * Shared zod schema for KB query request bodies. Used by both the SDK
 * runtime route (Chunk C) and the agent-runtime route (Chunk D).
 */
export const kbQueryBodySchema = z.object({
  kbId: z.string().min(1),
  text: z.string().min(1),
  topK: z.number().int().positive().max(50).optional(),
  keywordWeight: z.number().min(0).max(1).optional(),
  neighborClusters: z.number().int().min(0).max(20).optional(),
  filter: z.record(z.unknown()).optional(),
  minScore: z.number().optional(),
  includeContent: z.boolean().optional(),
  includeDiagnostics: z.boolean().optional(),
})

export type KbQueryBody = z.infer<typeof kbQueryBodySchema>

/**
 * Caller-provided execution context. The route layer is responsible for
 * validating auth and constructing this context — `handleKbQuery` itself
 * performs no auth.
 */
export interface KbQueryCtx {
  // lifted: `workspaceId` → `pairedClientId`, and `agentId` removed. Both were
  // log context only — nothing in this handler or in `queryKb` reads them — and
  // an agent is a Studio concept (ADR 0002). Studio still logs its own agent id
  // on its side of the call.
  pairedClientId: string
  source: 'sdk' | 'agent'
}

/**
 * Route-agnostic KB query handler. Performs closed-set query-keyword
 * selection from the KB's existing vocabulary (same contract as the
 * search-bar API at `/api/knowledge/[id]/search`) before delegating to
 * `queryKb`. Auth must be validated upstream.
 */
export async function handleKbQuery(
  ctx: KbQueryCtx,
  body: KbQueryBody
): Promise<Awaited<ReturnType<typeof queryKb>>> {
  logger.info('Handling KB query', {
    kbId: body.kbId,
    pairedClientId: ctx.pairedClientId,
    source: ctx.source,
  })

  const queryKeywordCanonicals = await selectQueryKeywordsFromMenu({
    kbId: body.kbId,
    text: body.text,
  })

  return queryKb({
    kbId: body.kbId,
    text: body.text,
    topK: body.topK,
    keywordWeight: body.keywordWeight,
    neighborClusters: body.neighborClusters,
    filter: body.filter,
    minScore: body.minScore,
    includeContent: body.includeContent,
    includeDiagnostics: body.includeDiagnostics,
    queryKeywordCanonicals,
  })
}
