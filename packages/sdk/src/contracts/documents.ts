/**
 * Documents and their chunks.
 *
 * Ingest is the one route with two request encodings and the reason is
 * physical: a file arrives as `multipart/form-data` because streaming a
 * hundred megabytes through a JSON string is not a thing to do, and text
 * arrives as JSON because wrapping a paragraph in a multipart envelope is
 * ceremony. **They are not the same pipeline, and that is deliberate** — a file
 * goes through parse → chunk → plan → embed → finalize (the resumable worker
 * flow), and text goes through `ingestDocument`, which is the path the app-SDK
 * and the runtime route have always taken. The two rank differently on the same
 * corpus and the fixture suite freezes both (`src/__fixtures__/README.md`).
 */

import { z } from "zod";
import {
  IsoDateTimeSchema,
  MetadataSchema,
  NullableIsoDateTimeSchema,
  PaginationSchema,
  TagValuesSchema,
  TagWritesSchema,
} from "./common.ts";

/** Studio's lifecycle values, unchanged. `processing` is the legacy umbrella. */
export const ProcessingStatusSchema = z.enum([
  "pending",
  "processing",
  "chunking",
  "embedding",
  "clustering",
  "keywording",
  "completed",
  "failed",
]);
export type ProcessingStatus = z.infer<typeof ProcessingStatusSchema>;

/** A document row as every read route returns it. */
export const DocumentSchema = TagValuesSchema.extend({
  id: z.string(),
  knowledgeBaseId: z.string(),
  filename: z.string(),
  /** Where the bytes are. An internal blob reference, or the URL they came from. */
  fileUrl: z.string(),
  fileSize: z.number().int(),
  mimeType: z.string(),
  chunkCount: z.number().int(),
  /** Chunks embedded *and* keyworded — what a "Processing N/M" reads. */
  processedChunks: z.number().int(),
  tokenCount: z.number().int(),
  characterCount: z.number().int(),
  processingStatus: ProcessingStatusSchema,
  processingStartedAt: NullableIsoDateTimeSchema,
  processingCompletedAt: NullableIsoDateTimeSchema,
  processingError: z.string().nullable(),
  enabled: z.boolean(),
  /** `false` = uploaded but not chunked into the KB. */
  includedInKb: z.boolean(),
  /** `pending | extracted | skipped:no-inference-endpoint | failed`, or null. */
  keywordStatus: z.string().nullable(),
  uploadedAt: IsoDateTimeSchema,
  deletedAt: NullableIsoDateTimeSchema,
  /** A remote id Search records and never resolves — connectors stayed in Studio. */
  connectorId: z.string().nullable(),
  sourceUrl: z.string().nullable(),
});
export type SearchDocument = z.infer<typeof DocumentSchema>;

/**
 * `POST /v1/kbs/:id/documents`, JSON encoding.
 *
 * Exactly one of `text` and `url`. A `url` is fetched through the SSRF guard
 * (`core/security/url-guard.ts`) and then takes the file pipeline; `text` takes
 * the `ingestDocument` path.
 */
export const IngestJsonRequestSchema = z
  .object({
    filename: z.string().min(1).max(512),
    text: z.string().optional(),
    url: z.string().url().optional(),
    mimeType: z.string().min(1).max(255).optional(),
    metadata: MetadataSchema.optional(),
    tags: TagWritesSchema.optional(),
    /** Defaults to `true` on the REST surface: a caller that posts a document wants it searchable. */
    includedInKb: z.boolean().optional(),
    /**
     * The document's id, chosen by the caller rather than by this instance.
     *
     * **For a caller that already has an id for this document.** Studio's
     * wrapper (TASK-009) ingests rows whose ids its own callers hold, and those
     * ids have to survive being wired through Search — same ids before and
     * after. Omitted, Search generates one as it always did.
     *
     * **It is scoped by the knowledge base.** An id already taken in *another*
     * KB is `409 conflict` and never an overwrite; the same id in the *same* KB
     * is the idempotent re-ingest the engine already supports — the answer is
     * that document's current status and no second row is written. The response
     * echoes the id that was asked for either way.
     */
    documentId: z.string().min(1).max(128).optional(),
  })
  .refine((v) => (v.text === undefined) !== (v.url === undefined), {
    message: "provide exactly one of `text` or `url`",
  });
export type IngestJsonRequest = z.infer<typeof IngestJsonRequestSchema>;

/**
 * The multipart form's non-file fields. `file` carries the bytes; everything
 * else is a string part, because that is all a form can hold.
 *
 * `metadata`, `includedInKb` and `documentId` mean exactly what they mean on
 * {@link IngestJsonRequestSchema} — a form just has to spell them as strings.
 */
export const IngestMultipartFieldsSchema = z.object({
  filename: z.string().min(1).max(512).optional(),
  mimeType: z.string().min(1).max(255).optional(),
  /** JSON-encoded object. A form part cannot be structured any other way. */
  metadata: z.string().optional(),
  /** `1|true|yes|on` or `0|false|no|off`; anything else is a `400`. */
  includedInKb: z.string().optional(),
  /** The caller's own id for this document. See {@link IngestJsonRequestSchema}. */
  documentId: z.string().min(1).max(128).optional(),
});
export type IngestMultipartFields = z.infer<typeof IngestMultipartFieldsSchema>;

/** What ingest answers with, before any of the work has happened. */
export const IngestResponseSchema = z.object({
  documentId: z.string(),
  processingStatus: ProcessingStatusSchema,
});
export type IngestResponse = z.infer<typeof IngestResponseSchema>;

/** `GET /v1/kbs/:id/documents`. */
export const ListDocumentsQuerySchema = z.object({
  enabledFilter: z.enum(["all", "enabled", "disabled"]).optional(),
  search: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  sortBy: z
    .enum(["filename", "fileSize", "tokenCount", "chunkCount", "uploadedAt", "processingStatus"])
    .optional(),
  sortOrder: z.enum(["asc", "desc"]).optional(),
});
export type ListDocumentsQuery = z.infer<typeof ListDocumentsQuerySchema>;

export const ListDocumentsResponseSchema = z.object({
  documents: z.array(DocumentSchema),
  pagination: PaginationSchema,
});
export type ListDocumentsResponse = z.infer<typeof ListDocumentsResponseSchema>;

/** `PATCH /v1/kbs/:id/documents/:docId`. */
export const UpdateDocumentRequestSchema = TagWritesSchema.extend({
  filename: z.string().min(1).max(512).optional(),
  enabled: z.boolean().optional(),
});
export type UpdateDocumentRequest = z.infer<typeof UpdateDocumentRequestSchema>;

export const DeleteDocumentResponseSchema = z.object({
  id: z.string(),
  deleted: z.literal(true),
});
export type DeleteDocumentResponse = z.infer<typeof DeleteDocumentResponseSchema>;

/**
 * `POST /v1/kbs/:id/documents/:docId/include` — the opt-in toggle.
 *
 * `included: true` on a document that was uploaded but never chunked runs the
 * ingest pipeline over it; `false` pulls it out of the searchable set without
 * deleting anything.
 */
export const IncludeDocumentRequestSchema = z.object({ included: z.boolean() });
export type IncludeDocumentRequest = z.infer<typeof IncludeDocumentRequestSchema>;

export const IncludeDocumentResponseSchema = z.object({
  documentId: z.string(),
  includedInKb: z.boolean(),
  processingStatus: ProcessingStatusSchema,
});
export type IncludeDocumentResponse = z.infer<typeof IncludeDocumentResponseSchema>;

/**
 * `POST /v1/kbs/:id/documents/upsert` — Studio's upsert semantics.
 *
 * Identity is `(connectorId, externalId)` when both are given, and `filename`
 * otherwise. A match is replaced (the old document is deleted and the new one
 * ingested); no match is a plain ingest. `contentHash` short-circuits: an
 * unchanged hash is answered `skipped` without touching anything.
 */
export const UpsertDocumentRequestSchema = z
  .object({
    filename: z.string().min(1).max(512),
    text: z.string().optional(),
    url: z.string().url().optional(),
    mimeType: z.string().min(1).max(255).optional(),
    metadata: MetadataSchema.optional(),
    tags: TagWritesSchema.optional(),
    connectorId: z.string().min(1).optional(),
    externalId: z.string().min(1).optional(),
    contentHash: z.string().min(1).optional(),
    sourceUrl: z.string().optional(),
  })
  .refine((v) => (v.text === undefined) !== (v.url === undefined), {
    message: "provide exactly one of `text` or `url`",
  });
export type UpsertDocumentRequest = z.infer<typeof UpsertDocumentRequestSchema>;

export const UpsertDocumentResponseSchema = z.object({
  documentId: z.string(),
  processingStatus: ProcessingStatusSchema,
  outcome: z.enum(["created", "replaced", "skipped"]),
});
export type UpsertDocumentResponse = z.infer<typeof UpsertDocumentResponseSchema>;

// ─── Chunks ──────────────────────────────────────────────────────────────────

/** A chunk as the chunk routes return it. The shared `embedding` table's row. */
export const ChunkSchema = z.object({
  id: z.string(),
  chunkIndex: z.number().int(),
  content: z.string(),
  contentLength: z.number().int(),
  tokenCount: z.number().int(),
  enabled: z.boolean(),
  startOffset: z.number().int(),
  endOffset: z.number().int(),
  tag1: z.string().nullable(),
  tag2: z.string().nullable(),
  tag3: z.string().nullable(),
  tag4: z.string().nullable(),
  tag5: z.string().nullable(),
  tag6: z.string().nullable(),
  tag7: z.string().nullable(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type Chunk = z.infer<typeof ChunkSchema>;

export const ListChunksQuerySchema = z.object({
  search: z.string().optional(),
  enabled: z.enum(["true", "false", "all"]).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  sortBy: z.enum(["chunkIndex", "tokenCount", "enabled"]).optional(),
  sortOrder: z.enum(["asc", "desc"]).optional(),
});
export type ListChunksQuery = z.infer<typeof ListChunksQuerySchema>;

export const ListChunksResponseSchema = z.object({
  chunks: z.array(ChunkSchema),
  pagination: PaginationSchema,
});
export type ListChunksResponse = z.infer<typeof ListChunksResponseSchema>;

/**
 * `PATCH .../chunks/:chunkId`. Changing `content` re-embeds the chunk through
 * the KB's embedding endpoint — that is the lifted behaviour and it is not
 * optional.
 */
export const UpdateChunkRequestSchema = z
  .object({
    content: z.string(),
    enabled: z.boolean(),
  })
  .partial()
  .refine((v) => v.content !== undefined || v.enabled !== undefined, {
    message: "provide at least one of `content` or `enabled`",
  });
export type UpdateChunkRequest = z.infer<typeof UpdateChunkRequestSchema>;

export const DeleteChunkResponseSchema = z.object({
  id: z.string(),
  deleted: z.literal(true),
});
export type DeleteChunkResponse = z.infer<typeof DeleteChunkResponseSchema>;
