import type { ChunkingStrategy, StrategyOptions } from '@actana/search-shared/chunkers/types'

/**
 * Per-document processing lifecycle. `processing` is a legacy umbrella value
 * retained for back-compat; new ingests progress through the phase-specific
 * statuses below.
 */
export type DocumentProcessingStatus =
  | 'pending'
  | 'processing'
  | 'chunking'
  | 'embedding'
  | 'clustering'
  | 'keywording'
  | 'completed'
  | 'failed'

/** Phase statuses that mean "in flight" — UI should show a loader. */
export const IN_FLIGHT_PROCESSING_STATUSES: ReadonlySet<DocumentProcessingStatus> = new Set([
  'pending',
  'processing',
  'chunking',
  'embedding',
  'clustering',
  'keywording',
])

/** True when the document is still working through its processing pipeline. */
export function isInFlightProcessingStatus(status: string | null | undefined): boolean {
  return !!status && IN_FLIGHT_PROCESSING_STATUSES.has(status as DocumentProcessingStatus)
}

/**
 * Units:
 * - maxSize/overlap: TOKENS (1 token ≈ 4 characters)
 * - minSize: CHARACTERS
 */
export interface ChunkingConfig {
  maxSize: number
  minSize: number
  overlap: number
  strategy?: ChunkingStrategy
  strategyOptions?: StrategyOptions
}

export interface KnowledgeBaseWithCounts {
  id: string
  userId: string
  name: string
  description: string | null
  tokenCount: number
  // lifted: was `string`. The column is nullable and the list query has always
  // selected it straight through, so `string | null` is what callers have
  // always received — another mismatch that was latent because Studio does not
  // type-check this program repo-wide.
  embeddingModel: string | null
  embeddingDimension: number
  chunkingConfig: ChunkingConfig
  createdAt: Date
  updatedAt: Date
  deletedAt: Date | null
  workspaceId: string | null
  docCount: number
  connectorTypes: string[]
  // lifted: these were declared required and `knowledge/service.ts` never set
  // them on the create, update or list paths — Studio does not type-check this
  // program repo-wide, so the mismatch was latent. Optional is what the code
  // has always returned; a consumer that got `undefined` still gets it.
  clusterCount?: number | null
  silhouette?: number | null
  clustersUpdatedAt?: Date | null
  inferenceModelId?: string | null
  embeddingEndpointId?: string | null
  inferenceEndpointId?: string | null
}

export interface CreateKnowledgeBaseData {
  name: string
  description?: string
  workspaceId: string
  embeddingModel: 'text-embedding-3-small'
  embeddingDimension: 1536
  chunkingConfig: ChunkingConfig
  userId: string
  /** Catalog id used for KB keyword extraction. KB v2 (Chunk C). */
  inferenceModelId?: string
  /** Initial cluster count. Default 8 per KB v2 plan. */
  clusterCount?: number
  /** KB v3: workspace model endpoint id used for embeddings. */
  embeddingEndpointId?: string
  /** KB v3: workspace model endpoint id used for keyword extraction. */
  inferenceEndpointId?: string
}

export interface TagDefinition {
  id: string
  tagSlot: string
  displayName: string
  fieldType: string
  createdAt: Date
  updatedAt: Date
}

export interface CreateTagDefinitionData {
  knowledgeBaseId: string
  tagSlot: string
  displayName: string
  fieldType: string
}

export interface UpdateTagDefinitionData {
  displayName?: string
  fieldType?: string
}

export interface StructuredFilter {
  tagName?: string
  tagSlot: string
  fieldType: string
  operator: string
  value: string | number | boolean
  valueTo?: string | number
}

export interface ProcessedDocumentTags {
  tag1: string | null
  tag2: string | null
  tag3: string | null
  tag4: string | null
  tag5: string | null
  tag6: string | null
  tag7: string | null
  number1: number | null
  number2: number | null
  number3: number | null
  number4: number | null
  number5: number | null
  date1: Date | null
  date2: Date | null
  boolean1: boolean | null
  boolean2: boolean | null
  boolean3: boolean | null
  [key: string]: string | number | Date | boolean | null
}

/** These types use string dates for JSON serialization */

export interface ExtendedChunkingConfig extends ChunkingConfig {
  chunkSize?: number
  minCharactersPerChunk?: number
  recipe?: string
  lang?: string
  [key: string]: unknown
}

export interface KnowledgeBaseData {
  id: string
  userId: string
  name: string
  description?: string
  tokenCount: number
  embeddingModel: string
  embeddingDimension: number
  chunkingConfig: ExtendedChunkingConfig
  createdAt: string
  updatedAt: string
  deletedAt?: string | null
  workspaceId?: string
  connectorTypes?: string[]
  /** KB v2: catalog id used for keyword extraction. */
  inferenceModelId?: string | null
  /** KB v3: workspace model endpoint id used for embeddings. */
  embeddingEndpointId?: string | null
  /** KB v3: workspace model endpoint id used for keyword extraction. */
  inferenceEndpointId?: string | null
  /** KB v2: current cluster count. */
  clusterCount?: number | null
  /** KB v2: last silhouette score (clustering quality). */
  silhouette?: number | null
  /** KB v2: ISO timestamp of last clustering run. */
  clustersUpdatedAt?: string | null
}

export interface DocumentData {
  id: string
  knowledgeBaseId: string
  filename: string
  fileUrl: string
  fileSize: number
  mimeType: string
  chunkCount: number
  /** Running count of chunks that have completed embedding + keyword extraction. */
  processedChunks: number
  tokenCount: number
  characterCount: number
  processingStatus: DocumentProcessingStatus
  processingStartedAt?: string | null
  processingCompletedAt?: string | null
  processingError?: string | null
  enabled: boolean
  uploadedAt: string
  tag1?: string | null
  tag2?: string | null
  tag3?: string | null
  tag4?: string | null
  tag5?: string | null
  tag6?: string | null
  tag7?: string | null
  number1?: number | null
  number2?: number | null
  number3?: number | null
  number4?: number | null
  number5?: number | null
  date1?: string | null
  date2?: string | null
  boolean1?: boolean | null
  boolean2?: boolean | null
  boolean3?: boolean | null
  connectorId?: string | null
  connectorType?: string | null
  sourceUrl?: string | null
}

export interface ChunkData {
  id: string
  chunkIndex: number
  content: string
  contentLength: number
  tokenCount: number
  enabled: boolean
  startOffset: number
  endOffset: number
  tag1?: string | null
  tag2?: string | null
  tag3?: string | null
  tag4?: string | null
  tag5?: string | null
  tag6?: string | null
  tag7?: string | null
  number1?: number | null
  number2?: number | null
  number3?: number | null
  number4?: number | null
  number5?: number | null
  date1?: string | null
  date2?: string | null
  boolean1?: boolean | null
  boolean2?: boolean | null
  boolean3?: boolean | null
  createdAt: string
  updatedAt: string
}

export interface ChunksPagination {
  total: number
  limit: number
  offset: number
  hasMore: boolean
}

export interface DocumentsPagination {
  total: number
  limit: number
  offset: number
  hasMore: boolean
}
