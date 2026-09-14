/**
 * The v1 knowledge API's response shaping. Lifted from Studio's
 * `app/api/v1/knowledge/utils.ts`.
 *
 * lifted: everything transport-shaped stayed behind — `authenticateRequest`,
 * `validateWorkspaceAccess`, `resolveKnowledgeBase`, `validateSchema`,
 * `parseJsonBody` and `handleError`. They are Next.js route middleware built on
 * `NextRequest` / `NextResponse`, Studio's API-key scopes, its rate limiter and
 * its organization guard — none of which cross the boundary. Search's caller is
 * a paired client identified by its certificate (ADR 0003) and its routes land
 * in TASK-004.
 *
 * What is here is the part a v1 caller can actually observe and which therefore
 * must not drift (ADR 0005): the exact field set and date format of a knowledge
 * base in a v1 response.
 */

import type { KnowledgeBaseWithCounts } from '../knowledge/types.ts'

/** Serializes a date value for JSON responses. */
export function serializeDate(date: Date | string | null | undefined): string | null {
  if (date === null || date === undefined) return null
  if (date instanceof Date) return date.toISOString()
  return String(date)
}

/** Formats a KnowledgeBaseWithCounts into the API response shape. */
export function formatKnowledgeBase(kb: KnowledgeBaseWithCounts) {
  return {
    id: kb.id,
    name: kb.name,
    description: kb.description,
    tokenCount: kb.tokenCount,
    embeddingModel: kb.embeddingModel,
    embeddingDimension: kb.embeddingDimension,
    chunkingConfig: kb.chunkingConfig,
    docCount: kb.docCount,
    connectorTypes: kb.connectorTypes,
    createdAt: serializeDate(kb.createdAt),
    updatedAt: serializeDate(kb.updatedAt),
  }
}
