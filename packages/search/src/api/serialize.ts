/**
 * Rows out, wire shapes in.
 *
 * The only transformation in here is `Date` → ISO string, and it is here rather
 * than left to `JSON.stringify` so that the object handed to `sendJson` is
 * already the thing the contract describes — a response that satisfies
 * `DocumentSchema` before it is serialised is a response the contract can be
 * asserted against in a unit test.
 *
 * **Field names are Studio's.** `userId` is `owner_id`, `workspaceId` is
 * `paired_client_id`: the lift renamed the columns and deliberately did not
 * rename what a caller reads (ADR 0005), because the caller is Studio and a
 * rename there is a migration nobody asked for.
 */

import type { SearchDocument, Chunk, KnowledgeBase } from "@actana/search/contracts";
import type { KnowledgeBaseWithCounts } from "../knowledge/types.ts";
import type { DocumentRow } from "./ownership.ts";

/** A timestamp, or `null`. */
export function iso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

/** A timestamp that the column says cannot be null. */
export function isoRequired(value: Date | string): string {
  return iso(value) ?? new Date(0).toISOString();
}

/**
 * A knowledge base.
 *
 * `language` is carried separately because the lifted `KnowledgeBaseWithCounts`
 * never had it — the column is Search's partition configuration and Studio's
 * type predates it.
 */
export function kbToWire(
  kb: KnowledgeBaseWithCounts,
  extra: { language?: string } = {},
): KnowledgeBase {
  return {
    id: kb.id,
    userId: kb.userId,
    name: kb.name,
    description: kb.description,
    tokenCount: Number(kb.tokenCount),
    embeddingModel: kb.embeddingModel,
    embeddingDimension: kb.embeddingDimension,
    chunkingConfig: kb.chunkingConfig as KnowledgeBase["chunkingConfig"],
    createdAt: isoRequired(kb.createdAt),
    updatedAt: isoRequired(kb.updatedAt),
    deletedAt: iso(kb.deletedAt),
    workspaceId: kb.workspaceId,
    docCount: Number(kb.docCount),
    connectorTypes: kb.connectorTypes,
    clusterCount: kb.clusterCount ?? null,
    silhouette: kb.silhouette ?? null,
    clustersUpdatedAt: iso(kb.clustersUpdatedAt),
    inferenceModelId: kb.inferenceModelId ?? null,
    embeddingEndpointId: kb.embeddingEndpointId ?? null,
    inferenceEndpointId: kb.inferenceEndpointId ?? null,
    ...(extra.language === undefined ? {} : { language: extra.language }),
  };
}

/** A document row, whole. Every read route answers with this shape. */
export function documentToWire(row: DocumentRow): SearchDocument {
  return {
    id: row.id,
    knowledgeBaseId: row.knowledgeBaseId,
    filename: row.filename,
    fileUrl: row.fileUrl,
    fileSize: row.fileSize,
    mimeType: row.mimeType,
    chunkCount: row.chunkCount,
    processedChunks: row.processedChunks,
    tokenCount: row.tokenCount,
    characterCount: row.characterCount,
    processingStatus: row.processingStatus as SearchDocument["processingStatus"],
    processingStartedAt: iso(row.processingStartedAt),
    processingCompletedAt: iso(row.processingCompletedAt),
    processingError: row.processingError,
    enabled: row.enabled,
    includedInKb: row.includedInKb,
    keywordStatus: row.keywordStatus,
    uploadedAt: isoRequired(row.uploadedAt),
    deletedAt: iso(row.deletedAt),
    connectorId: row.connectorId,
    sourceUrl: row.sourceUrl,
    tag1: row.tag1,
    tag2: row.tag2,
    tag3: row.tag3,
    tag4: row.tag4,
    tag5: row.tag5,
    tag6: row.tag6,
    tag7: row.tag7,
    number1: row.number1,
    number2: row.number2,
    number3: row.number3,
    number4: row.number4,
    number5: row.number5,
    date1: iso(row.date1),
    date2: iso(row.date2),
    boolean1: row.boolean1,
    boolean2: row.boolean2,
    boolean3: row.boolean3,
  };
}

/**
 * The shape the chunk service hands back, with its two timestamps converted.
 *
 * **`documentId` is a separate argument** because the lifted `ChunkData` does
 * not carry one: `queryChunks`, `createChunk` and `updateChunk` all answer
 * about chunks of a document the *caller* named, so the id never had to be in
 * their return shape. `ChunkSchema.documentId` is required all the same — every
 * caller of this function holds the document id already, either from the path
 * it was addressed at or from the `embedding` row it just read — and making the
 * field an argument rather than an optional key is what makes that checked at
 * compile time instead of hoped for.
 */
export function chunkToWire(
  row: {
    id: string;
    chunkIndex: number;
    content: string;
    contentLength: number;
    tokenCount: number;
    enabled: boolean;
    startOffset: number;
    endOffset: number;
    tag1?: string | null;
    tag2?: string | null;
    tag3?: string | null;
    tag4?: string | null;
    tag5?: string | null;
    tag6?: string | null;
    tag7?: string | null;
    createdAt: Date | string;
    updatedAt: Date | string;
  },
  documentId: string,
): Chunk {
  return {
    id: row.id,
    documentId,
    chunkIndex: row.chunkIndex,
    content: row.content,
    contentLength: row.contentLength,
    tokenCount: row.tokenCount,
    enabled: row.enabled,
    startOffset: row.startOffset,
    endOffset: row.endOffset,
    tag1: row.tag1 ?? null,
    tag2: row.tag2 ?? null,
    tag3: row.tag3 ?? null,
    tag4: row.tag4 ?? null,
    tag5: row.tag5 ?? null,
    tag6: row.tag6 ?? null,
    tag7: row.tag7 ?? null,
    createdAt: isoRequired(row.createdAt),
    updatedAt: isoRequired(row.updatedAt),
  };
}
