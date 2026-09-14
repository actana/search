import { db } from '../db/client.ts'
import { document, knowledgeBase, modelEndpoint, qualified } from '../db/schema.ts'
import { createLogger } from '@actana/search-shared/log'
import { and, count, eq, isNotNull, isNull, ne, or, sql } from 'drizzle-orm'
import { getPostgresErrorCode } from '../core/utils/pg-error.ts'
import { generateRestoreName } from '../core/utils/restore-name.ts'
import { generateId } from '@actana/search-shared/short-id'
import type { DbOrTx } from '../db/types.ts'
import type {
  ChunkingConfig,
  CreateKnowledgeBaseData,
  KnowledgeBaseWithCounts,
} from './types.ts'
// lifted: `listAccessibleWorkspaceIds` and `resolveEffectiveTier` stayed in
// Studio. They are that repo's membership and plan-tier model, and the
// authorisation they implement does not move with the engine: Studio still runs
// every `checkKnowledgeBaseAccess` / `assertWorkspaceAccess` *before* it calls
// Search, and Search's own check is the paired client's scope, applied in the
// API layer (ADR 0003). Reading a row belonging to another paired client is
// prevented by the scope, not by a membership lookup in here.

/**
 * Legacy 1536-dim store. After KB v2 ships, new KBs route via
 * `lib/kb/ddl.ts::provisionKbPartition` and writes from Chunk C ingest go to
 * per-KB partition tables (`kb_embedding_<sha256(kb_id)[0..12]>`). The
 * `embedding` table referenced indirectly here remains readable for KBs
 * created before the v2 cutover. Do not add new write paths to it.
 */
const logger = createLogger('KnowledgeBaseService')

export class KnowledgeBaseConflictError extends Error {
  readonly code = 'KNOWLEDGE_BASE_EXISTS' as const
  constructor(name: string) {
    super(`A knowledge base named "${name}" already exists in this workspace`)
  }
}

export type KnowledgeBaseScope = 'active' | 'archived' | 'all'

/**
 * Get knowledge bases that a user can access
 */
export async function getKnowledgeBases(
  userId: string,
  workspaceId?: string | null,
  scope: KnowledgeBaseScope = 'active'
): Promise<KnowledgeBaseWithCounts[]> {
  const scopeCondition =
    scope === 'all'
      ? undefined
      : scope === 'archived'
        ? sql`${knowledgeBase.deletedAt} IS NOT NULL`
        : isNull(knowledgeBase.deletedAt)

  // lifted: was `inArray(pairedClientId, await listAccessibleWorkspaceIds(...))`
  // — a fan-out across every workspace the user was a member of. A request here
  // carries exactly one paired client, already checked.
  const inAccessibleWorkspace = workspaceId
    ? eq(knowledgeBase.pairedClientId, workspaceId)
    : sql`false`

  const knowledgeBasesWithCounts = await db
    .select({
      id: knowledgeBase.id,
      userId: knowledgeBase.ownerId,
      name: knowledgeBase.name,
      description: knowledgeBase.description,
      tokenCount: sql<number>`COALESCE(SUM(${document.tokenCount}), 0)`.mapWith(Number),
      embeddingModel: knowledgeBase.embeddingModel,
      embeddingDimension: knowledgeBase.embeddingDimension,
      chunkingConfig: knowledgeBase.chunkingConfig,
      createdAt: knowledgeBase.createdAt,
      updatedAt: knowledgeBase.updatedAt,
      deletedAt: knowledgeBase.deletedAt,
      workspaceId: knowledgeBase.pairedClientId,
      docCount: count(document.id),
    })
    .from(knowledgeBase)
    .leftJoin(
      document,
      and(
        eq(document.knowledgeBaseId, knowledgeBase.id),
        eq(document.userExcluded, false),
        isNull(document.archivedAt),
        isNull(document.deletedAt)
      )
    )
    .where(
      and(
        scopeCondition,
        workspaceId
          ? // lifted: a second branch stood here — `ownerId = userId AND
            // pairedClientId IS NULL` — for knowledge bases that predated
            // workspaces and belonged only to a user. `paired_client_id` is NOT
            // NULL in Search's schema (ADR 0003), so the branch can never match;
            // the data migration gives those rows an owner instead.
            and(eq(knowledgeBase.pairedClientId, workspaceId), inAccessibleWorkspace)
          : // When not filtering by workspace, use original logic
            or(
              // User owns the knowledge base directly
              eq(knowledgeBase.ownerId, userId),
              // User has cascade access to the knowledge base's workspace
              inAccessibleWorkspace
            )
      )
    )
    .groupBy(knowledgeBase.id)
    .orderBy(knowledgeBase.createdAt)

  const kbIds = knowledgeBasesWithCounts.map((kb) => kb.id)

  // lifted: the `knowledge_connector` join. Connectors keep Studio's OAuth
  // credentials and their sync log, and stay there (ADR 0002); a document a
  // connector wrote arrives through the ingest route like any other and carries
  // its `connector_id` as a plain remote id. `connectorTypes` stays in the
  // response shape — a v1 caller reads it — and is empty here, which is what
  // Studio returns for a KB with no connectors.
  void kbIds
  const connectorTypesByKb = new Map<string, string[]>()

  return knowledgeBasesWithCounts.map((kb) => ({
    ...kb,
    chunkingConfig: kb.chunkingConfig as ChunkingConfig,
    docCount: Number(kb.docCount),
    connectorTypes: connectorTypesByKb.get(kb.id) ?? [],
  }))
}

/**
 * Create a new knowledge base.
 *
 * @param externalTx - Optional transaction/db handle; when provided every
 *   read/write joins the caller's transaction (so e.g. an embedding endpoint
 *   created earlier in that transaction is visible) instead of the global db.
 */
export async function createKnowledgeBase(
  data: CreateKnowledgeBaseData,
  requestId: string,
  externalTx?: DbOrTx
): Promise<KnowledgeBaseWithCounts> {
  const dbCtx = externalTx ?? db
  const kbId = generateId()
  const now = new Date()

  // lifted: the plan-tier permission gate. It asked Studio's membership model
  // whether this user may create a KB in this workspace; the equivalent here is
  // the paired client's `write` scope, checked in the API layer (ADR 0003)
  // before this function is reached.

  let embeddingDimension = data.embeddingDimension
  if (data.embeddingEndpointId) {
    const [endpointRow] = await dbCtx
      .select({
        id: modelEndpoint.id,
        dimensions: modelEndpoint.dimension,
      })
      .from(modelEndpoint)
      .where(eq(modelEndpoint.id, data.embeddingEndpointId))
      .limit(1)

    if (!endpointRow) {
      throw new Error('Selected embedding endpoint not found')
    }
    if (endpointRow.dimensions) {
      embeddingDimension = endpointRow.dimensions as 1536
    }
  }

  const newKnowledgeBase = {
    id: kbId,
    name: data.name,
    description: data.description ?? null,
    pairedClientId: data.workspaceId,
    ownerId: data.userId,
    tokenCount: 0,
    embeddingModel: data.embeddingModel,
    embeddingDimension,
    inferenceModelId: data.inferenceModelId ?? null,
    embeddingEndpointId: data.embeddingEndpointId ?? null,
    inferenceEndpointId: data.inferenceEndpointId ?? null,
    kmeansK: data.clusterCount ?? 8,
    chunkingConfig: data.chunkingConfig,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  }

  const duplicate = await dbCtx
    .select({ id: knowledgeBase.id })
    .from(knowledgeBase)
    .where(
      and(
        eq(knowledgeBase.pairedClientId, data.workspaceId),
        eq(knowledgeBase.name, data.name),
        isNull(knowledgeBase.deletedAt)
      )
    )
    .limit(1)

  if (duplicate.length > 0) {
    throw new KnowledgeBaseConflictError(data.name)
  }

  try {
    await dbCtx.insert(knowledgeBase).values(newKnowledgeBase)
  } catch (error: unknown) {
    if (getPostgresErrorCode(error) === '23505') {
      throw new KnowledgeBaseConflictError(data.name)
    }
    throw error
  }

  logger.info(`[${requestId}] Created knowledge base: ${data.name} (${kbId})`)

  return {
    id: kbId,
    userId: data.userId,
    name: data.name,
    description: data.description ?? null,
    tokenCount: 0,
    embeddingModel: data.embeddingModel,
    embeddingDimension,
    chunkingConfig: data.chunkingConfig,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    workspaceId: data.workspaceId,
    docCount: 0,
    connectorTypes: [],
  }
}

/**
 * Update a knowledge base
 */
export async function updateKnowledgeBase(
  knowledgeBaseId: string,
  updates: {
    name?: string
    description?: string
    workspaceId?: string | null
    chunkingConfig?: {
      maxSize: number
      minSize: number
      overlap: number
    }
    /** KB v2: catalog id used for keyword extraction. */
    inferenceModelId?: string | null
    /** KB v3: workspace model endpoint id used for keyword extraction. */
    inferenceEndpointId?: string | null
    /** KB v2: cluster-count override. */
    clusterCount?: number
  },
  requestId: string
): Promise<KnowledgeBaseWithCounts> {
  const now = new Date()
  const updateData: {
    updatedAt: Date
    name?: string
    description?: string | null
    workspaceId?: string | null
    chunkingConfig?: {
      maxSize: number
      minSize: number
      overlap: number
    }
    embeddingModel?: string
    embeddingDimension?: number
  } = {
    updatedAt: now,
  }

  if (updates.name !== undefined) updateData.name = updates.name
  if (updates.description !== undefined) updateData.description = updates.description
  if (updates.workspaceId !== undefined) updateData.workspaceId = updates.workspaceId
  if (updates.chunkingConfig !== undefined) {
    updateData.chunkingConfig = updates.chunkingConfig
    updateData.embeddingModel = 'text-embedding-3-small'
    updateData.embeddingDimension = 1536
  }
  if (updates.inferenceModelId !== undefined) {
    ;(updateData as { inferenceModelId?: string | null }).inferenceModelId =
      updates.inferenceModelId
  }
  if (updates.inferenceEndpointId !== undefined) {
    ;(updateData as { inferenceEndpointId?: string | null }).inferenceEndpointId =
      updates.inferenceEndpointId
  }
  if (updates.clusterCount !== undefined) {
    ;(updateData as { kmeansK?: number }).kmeansK = updates.clusterCount
  }

  if (updates.name !== undefined) {
    const existing = await db
      .select({ id: knowledgeBase.id, workspaceId: knowledgeBase.pairedClientId })
      .from(knowledgeBase)
      .where(and(eq(knowledgeBase.id, knowledgeBaseId), isNull(knowledgeBase.deletedAt)))
      .limit(1)

    if (existing.length > 0 && existing[0].workspaceId) {
      const duplicate = await db
        .select({ id: knowledgeBase.id })
        .from(knowledgeBase)
        .where(
          and(
            eq(knowledgeBase.pairedClientId, existing[0].workspaceId),
            eq(knowledgeBase.name, updates.name),
            isNull(knowledgeBase.deletedAt),
            ne(knowledgeBase.id, knowledgeBaseId)
          )
        )
        .limit(1)

      if (duplicate.length > 0) {
        throw new KnowledgeBaseConflictError(updates.name)
      }
    }
  }

  try {
    await db
      .update(knowledgeBase)
      .set(updateData)
      .where(and(eq(knowledgeBase.id, knowledgeBaseId), isNull(knowledgeBase.deletedAt)))
  } catch (error: unknown) {
    if (getPostgresErrorCode(error) === '23505' && updates.name !== undefined) {
      throw new KnowledgeBaseConflictError(updates.name)
    }
    throw error
  }

  const updatedKb = await db
    .select({
      id: knowledgeBase.id,
      userId: knowledgeBase.ownerId,
      name: knowledgeBase.name,
      description: knowledgeBase.description,
      tokenCount: sql<number>`COALESCE(SUM(${document.tokenCount}), 0)`.mapWith(Number),
      embeddingModel: knowledgeBase.embeddingModel,
      embeddingDimension: knowledgeBase.embeddingDimension,
      chunkingConfig: knowledgeBase.chunkingConfig,
      createdAt: knowledgeBase.createdAt,
      updatedAt: knowledgeBase.updatedAt,
      deletedAt: knowledgeBase.deletedAt,
      workspaceId: knowledgeBase.pairedClientId,
      docCount: count(document.id),
    })
    .from(knowledgeBase)
    .leftJoin(
      document,
      and(
        eq(document.knowledgeBaseId, knowledgeBase.id),
        eq(document.userExcluded, false),
        isNull(document.archivedAt),
        isNull(document.deletedAt)
      )
    )
    .where(and(eq(knowledgeBase.id, knowledgeBaseId), isNull(knowledgeBase.deletedAt)))
    .groupBy(knowledgeBase.id)
    .limit(1)

  if (updatedKb.length === 0) {
    throw new Error(`Knowledge base ${knowledgeBaseId} not found`)
  }

  logger.info(`[${requestId}] Updated knowledge base: ${knowledgeBaseId}`)

  return {
    ...updatedKb[0],
    chunkingConfig: updatedKb[0].chunkingConfig as ChunkingConfig,
    docCount: Number(updatedKb[0].docCount),
    connectorTypes: [],
  }
}

/**
 * Get a single knowledge base by ID
 */
export async function getKnowledgeBaseById(
  knowledgeBaseId: string
): Promise<KnowledgeBaseWithCounts | null> {
  const result = await db
    .select({
      id: knowledgeBase.id,
      userId: knowledgeBase.ownerId,
      name: knowledgeBase.name,
      description: knowledgeBase.description,
      tokenCount: sql<number>`COALESCE(SUM(${document.tokenCount}), 0)`.mapWith(Number),
      embeddingModel: knowledgeBase.embeddingModel,
      embeddingDimension: knowledgeBase.embeddingDimension,
      chunkingConfig: knowledgeBase.chunkingConfig,
      createdAt: knowledgeBase.createdAt,
      updatedAt: knowledgeBase.updatedAt,
      deletedAt: knowledgeBase.deletedAt,
      workspaceId: knowledgeBase.pairedClientId,
      docCount: count(document.id),
      clusterCount: knowledgeBase.kmeansK,
      silhouette: knowledgeBase.kmeansSilhouette,
      clustersUpdatedAt: knowledgeBase.kmeansUpdatedAt,
      inferenceModelId: knowledgeBase.inferenceModelId,
      embeddingEndpointId: knowledgeBase.embeddingEndpointId,
      inferenceEndpointId: knowledgeBase.inferenceEndpointId,
    })
    .from(knowledgeBase)
    .leftJoin(
      document,
      and(
        eq(document.knowledgeBaseId, knowledgeBase.id),
        eq(document.userExcluded, false),
        isNull(document.archivedAt),
        isNull(document.deletedAt)
      )
    )
    .where(and(eq(knowledgeBase.id, knowledgeBaseId), isNull(knowledgeBase.deletedAt)))
    .groupBy(knowledgeBase.id)
    .limit(1)

  if (result.length === 0) {
    return null
  }

  return {
    ...result[0],
    chunkingConfig: result[0].chunkingConfig as ChunkingConfig,
    docCount: Number(result[0].docCount),
    connectorTypes: [],
  }
}

/**
 * Delete a knowledge base (soft delete)
 */
export async function deleteKnowledgeBase(
  knowledgeBaseId: string,
  requestId: string
): Promise<void> {
  const now = new Date()

  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT 1 FROM ${sql.raw(qualified('knowledge_base'))} WHERE id = ${knowledgeBaseId} FOR UPDATE`)

    await tx
      .update(knowledgeBase)
      .set({
        deletedAt: now,
        updatedAt: now,
      })
      .where(and(eq(knowledgeBase.id, knowledgeBaseId), isNull(knowledgeBase.deletedAt)))

    await tx
      .update(document)
      .set({
        archivedAt: now,
      })
      .where(
        and(
          eq(document.knowledgeBaseId, knowledgeBaseId),
          isNull(document.archivedAt),
          isNull(document.deletedAt)
        )
      )

    // lifted: archiving the KB's `knowledge_connector` rows. Connectors stay in
    // Studio (ADR 0002), so Studio pauses them on its side of the same gesture.
  })

  logger.info(`[${requestId}] Soft deleted knowledge base: ${knowledgeBaseId}`)
}

/**
 * Restore a soft-deleted knowledge base and its graph children.
 * Clears archivedAt on children that were archived as part of the KB snapshot.
 * Does NOT revive children that were directly deleted (deletedAt set).
 */
export async function restoreKnowledgeBase(
  knowledgeBaseId: string,
  requestId: string
): Promise<void> {
  const [kb] = await db
    .select({
      id: knowledgeBase.id,
      name: knowledgeBase.name,
      deletedAt: knowledgeBase.deletedAt,
      workspaceId: knowledgeBase.pairedClientId,
    })
    .from(knowledgeBase)
    .where(eq(knowledgeBase.id, knowledgeBaseId))
    .limit(1)

  if (!kb) {
    throw new Error('Knowledge base not found')
  }

  if (!kb.deletedAt) {
    throw new Error('Knowledge base is not archived')
  }

  // lifted: the "cannot restore into an archived workspace" guard. A workspace
  // is Studio's, and so is its archived state; Studio applies the guard before
  // calling Search. A revoked paired client cannot reach this route at all.

  /**
   * A concurrent create/rename can commit the same active name after `generateRestoreName`'s check
   * (MVCC) and before this transaction commits. Retries pick a new random suffix; 23505 is still
   * mapped to {@link KnowledgeBaseConflictError} if exhaustion occurs.
   */
  const maxUniqueViolationRetries = 8
  let attemptedRestoreName = ''

  for (let attempt = 0; attempt < maxUniqueViolationRetries; attempt++) {
    attemptedRestoreName = ''
    try {
      await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT 1 FROM ${sql.raw(qualified('knowledge_base'))} WHERE id = ${knowledgeBaseId} FOR UPDATE`)

        attemptedRestoreName = await generateRestoreName(kb.name, async (candidate) => {
          if (!kb.workspaceId) return false
          const [match] = await tx
            .select({ id: knowledgeBase.id })
            .from(knowledgeBase)
            .where(
              and(
                eq(knowledgeBase.pairedClientId, kb.workspaceId),
                eq(knowledgeBase.name, candidate),
                isNull(knowledgeBase.deletedAt)
              )
            )
            .limit(1)
          return !!match
        })

        const now = new Date()

        await tx
          .update(knowledgeBase)
          .set({ deletedAt: null, updatedAt: now, name: attemptedRestoreName })
          .where(eq(knowledgeBase.id, knowledgeBaseId))

        await tx
          .update(document)
          .set({ archivedAt: null })
          .where(
            and(
              eq(document.knowledgeBaseId, knowledgeBaseId),
              isNotNull(document.archivedAt),
              isNull(document.deletedAt)
            )
          )

        // lifted: un-archiving the KB's `knowledge_connector` rows — the mirror
        // of the cut in `deleteKnowledgeBase`, and for the same reason.
      })
      break
    } catch (error: unknown) {
      if (getPostgresErrorCode(error) !== '23505') {
        throw error
      }
      if (attempt === maxUniqueViolationRetries - 1) {
        throw new KnowledgeBaseConflictError(attemptedRestoreName || kb.name)
      }
    }
  }

  logger.info(
    `[${requestId}] Restored knowledge base: ${knowledgeBaseId} as "${attemptedRestoreName}"`
  )
}
