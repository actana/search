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
  ALL_TAG_SLOTS,
  IsoDateTimeSchema,
  MetadataSchema,
  NullableIsoDateTimeSchema,
  PaginationSchema,
  TagFieldTypeSchema,
  type TagFieldType,
  TagSlotSchema,
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
 *
 * **The tag slots are {@link TagWritesSchema}, flattened.** The JSON encoding
 * carries them as one nested `tags` object and a form has no nesting, so the
 * same seventeen keys are seventeen string parts — `tag1`…`tag7` and the
 * number, date and boolean slots beside them, with identical meanings and the
 * same parsers behind them. They are what the SDK already sends and what the
 * route already stages; declaring them is what makes that typed, validated,
 * and visible to a reader of the contract rather than true by coincidence
 * (TASK-009's rework notes: Studio's `TagWrites` on the multipart ingest).
 */
export const IngestMultipartFieldsSchema = TagWritesSchema.extend({
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

/**
 * `PUT /v1/kbs/:kbId/documents/:docId/blob` — the non-file fields of the attach.
 *
 * **The bytes of a document that already exists, without re-ingesting it.**
 * Every other way of getting bytes onto this instance creates a document and
 * runs a pipeline over them; this one repoints an existing row at a new object
 * and touches nothing else — `processingStatus`, the chunks, the embeddings and
 * the keyword overlay are exactly what they were. That is what makes it usable
 * as a *migration*: Studio's TASK-013 moves `search.document` rows by SQL, and
 * the objects those rows name live in Studio's bucket rather than Search's.
 * Re-ingest would rewrite every chunk id and every vector the fixture suite
 * froze, so it is not a move.
 *
 * There are two fields because there is nothing else to say about bytes that
 * are already a document's: the tags, the metadata and the `includedInKb` flag
 * belong to the row, and the row is not being created here.
 *
 * `filename` names the **object**, not the document: it is what the bucket key
 * is built from (`kb/<timestamp>-<random>-<sanitised>`), and `document.filename`
 * is left alone — a rename is `PATCH …/documents/:docId`.
 */
export const AttachBlobMultipartFieldsSchema = z.object({
  /** The name to build the storage key from. Defaults to the file part's own. */
  filename: z.string().min(1).max(512).optional(),
  /** Written to `document.mime_type`. Defaults to the file part's content type. */
  mimeType: z.string().min(1).max(255).optional(),
});
export type AttachBlobMultipartFields = z.infer<typeof AttachBlobMultipartFieldsSchema>;

/** What ingest answers with, before any of the work has happened. */
export const IngestResponseSchema = z.object({
  documentId: z.string(),
  processingStatus: ProcessingStatusSchema,
  /**
   * How many chunks the document has — **when the row already carries one**.
   *
   * Present for the idempotent re-ingest of a `documentId` already taken in
   * this KB (that document's real count, beside its real status) and for any
   * ingest whose work had already landed by the time the route answered.
   * Absent otherwise, which on a first ingest is the normal case: ingest is
   * asynchronous, the answer is a `202`, and this route does **not** wait for a
   * chunker in order to make this field true.
   *
   * Absent rather than `0`, because "not known yet" and "no chunks" are
   * different claims and a caller that cannot tell them apart is the reason
   * this field exists: Studio's `ingestDocument` returns a count and
   * `kb_add_file` surfaces it as a block output, so a wrapper with no field to
   * read reports `0` (TASK-009's rework notes, contract change 5). While a
   * document is still processing the count arrives on `document.ingested` —
   * over the webhook or the SSE stream — or from `GET …/documents/:docId`.
   */
  chunkCount: z.number().int().nonnegative().optional(),
});
export type IngestResponse = z.infer<typeof IngestResponseSchema>;

/**
 * One tag filter on a document listing.
 *
 * `TagFilterCondition` as the lifted `getDocuments` already accepts it, field
 * for field: the slot, how to read the value, the operator, and `valueTo` as
 * the upper bound of `between`.
 *
 * **Every field of it is closed, and for one reason: the engine's
 * `buildTagFilterCondition` answers a condition it cannot build with
 * `undefined`, and an undefined condition is dropped — which answers a
 * *filtered* listing with the *unfiltered* one.** A caller cannot tell those
 * two apart from the rows, so anything that would be dropped is a `400` here
 * instead:
 *
 *   - `tagSlot` is the seventeen-slot enum, not the lifted signature's bare
 *     `string`;
 *   - `operator` is the closed set below, which is exactly what the engine
 *     implements. `contains`, `not_contains`, `starts_with` and `ends_with` are
 *     its `LIKE` forms, `between` reads `valueTo`, and there is no `in`, no
 *     `is_null` and no `regex` — a request for one of those was answered with
 *     every document in the KB;
 *   - the **slot's own prefix** fixes `fieldType` (`tag*` is text, `number*`
 *     number, `date*` date, `boolean*` boolean). A mismatch is not merely
 *     dropped: `{ tagSlot: 'number1', fieldType: 'text' }` reaches Postgres as
 *     a text comparison against an integer column, which is a type error and a
 *     `500`;
 *   - a `fieldType` that does not implement the `operator` (`contains` on a
 *     number, `gt` on a boolean) is the dropped-condition case again, so it is
 *     refused too;
 *   - `between` without `valueTo` is dropped by the engine for both types that
 *     have it, so `valueTo` is required exactly there.
 *
 * `value` stays a **string** whatever the column's type is — the service parses
 * it, exactly as it does for a tag write. More than one condition on the same
 * slot is allowed and they are ANDed, as the engine ANDs them.
 */
export const TagFilterOperatorSchema = z.enum([
  "eq",
  "neq",
  "contains",
  "not_contains",
  "starts_with",
  "ends_with",
  "gt",
  "gte",
  "lt",
  "lte",
  "between",
]);
export type TagFilterOperator = z.infer<typeof TagFilterOperatorSchema>;

/** Which operators each column type's branch of `buildTagFilterCondition` builds. */
const OPERATORS_BY_FIELD_TYPE: Record<TagFieldType, readonly TagFilterOperator[]> = {
  text: ["eq", "neq", "contains", "not_contains", "starts_with", "ends_with"],
  number: ["eq", "neq", "gt", "gte", "lt", "lte", "between"],
  date: ["eq", "neq", "gt", "gte", "lt", "lte", "between"],
  boolean: ["eq", "neq"],
};

/** The field type a slot name commits to. The prefix *is* the column's type. */
const fieldTypeOfSlot = (slot: string): TagFieldType => {
  if (slot.startsWith("number")) return "number";
  if (slot.startsWith("date")) return "date";
  if (slot.startsWith("boolean")) return "boolean";
  return "text";
};

export const TagFilterConditionSchema = z
  .object({
    tagSlot: TagSlotSchema,
    fieldType: TagFieldTypeSchema,
    operator: TagFilterOperatorSchema,
    value: z.string(),
    valueTo: z.string().optional(),
  })
  .superRefine((condition, ctx) => {
    const expected = fieldTypeOfSlot(condition.tagSlot);
    if (condition.fieldType !== expected) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["fieldType"],
        message:
          `\`${condition.tagSlot}\` is a ${expected} column, so \`fieldType\` must be ` +
          `'${expected}' and not '${condition.fieldType}'; the slot's prefix is its type`,
      });
      return;
    }
    if (!OPERATORS_BY_FIELD_TYPE[expected].includes(condition.operator)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["operator"],
        message:
          `\`${condition.operator}\` is not an operator on a ${expected} tag; ` +
          `${expected} takes ${OPERATORS_BY_FIELD_TYPE[expected].join(", ")}`,
      });
    }
    if (condition.operator === "between" && condition.valueTo === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["valueTo"],
        message: "`between` is an inclusive range, so `valueTo` is its upper bound",
      });
    }
  });
export type TagFilterCondition = z.infer<typeof TagFilterConditionSchema>;

/**
 * `GET /v1/kbs/:id/documents`.
 *
 * **`tagFilters` is one JSON-encoded query parameter**, not a family of
 * `tag1=…&tag2=…` ones. Studio's filter is a list of *conditions* — an
 * operator per entry, a second bound for `between`, several conditions allowed
 * on one slot — and a flat `tag1=value` can carry none of that: it would
 * round-trip the easy filters and quietly lose the rest. One
 * `?tagFilters=<json>` round-trips `TagFilterCondition[]` exactly, which is the
 * type on both sides of the wire (TASK-009's rework notes, contract change 6).
 * A value that is not JSON, or not a list of conditions, is `400
 * validation-failed` naming the parameter.
 */
export const ListDocumentsQuerySchema = z.object({
  enabledFilter: z.enum(["all", "enabled", "disabled"]).optional(),
  search: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  sortBy: z
    .enum(["filename", "fileSize", "tokenCount", "chunkCount", "uploadedAt", "processingStatus"])
    .optional(),
  sortOrder: z.enum(["asc", "desc"]).optional(),
  tagFilters: z
    .preprocess(
      (raw) => (typeof raw === "string" ? jsonOrRaw(raw) : raw),
      z.array(TagFilterConditionSchema).max(2 * ALL_TAG_SLOTS.length),
    )
    .optional(),
});
export type ListDocumentsQuery = z.infer<typeof ListDocumentsQuerySchema>;

/**
 * A JSON string as the value it encodes, or the string unchanged.
 *
 * Handing the raw string on rather than throwing is what makes a malformed
 * `?tagFilters=` a `400 validation-failed` — the array schema refuses a string
 * — instead of a `500` out of a `JSON.parse` inside a preprocessor.
 */
function jsonOrRaw(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

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

/**
 * `POST /v1/kbs/:id/documents/bulk` — enable, disable or delete many documents
 * in one request.
 *
 * **Exactly one of `documentIds` and `enabledFilter`**, and they are the two
 * forms the lifted service has: `bulkDocumentOperation` takes a list of ids and
 * `bulkDocumentOperationByFilter` takes an `enabledFilter`. Nothing else is
 * offered because nothing else exists behind it — the frozen by-filter form
 * reads `enabled` and no other column (ADR 0005), so a `tags` or
 * `processingStatus` filter here would be a route inventing engine behaviour
 * rather than exposing it. Filter by tag with `GET …/documents?tagFilters=…`
 * and pass the ids.
 *
 * Studio's two bulk paths were N requests for N documents on a wired
 * workspace, and the by-filter one was additionally capped by the listing's
 * `limit` of 500 — so a KB of more than 500 documents needed paging that this
 * route does not (TASK-009's second round, contract change 11).
 */
export const BulkDocumentOperationSchema = z.enum(["enable", "disable", "delete"]);
export type BulkDocumentOperation = z.infer<typeof BulkDocumentOperationSchema>;

export const BulkDocumentsRequestSchema = z
  .object({
    operation: BulkDocumentOperationSchema,
    /**
     * The documents to act on. **All of them have to be in this KB**: one id
     * that is not is `404` and the call writes nothing, rather than a partial
     * success a caller has to diff. Capped at 500 per call.
     */
    documentIds: z.array(z.string().min(1)).min(1).max(500).optional(),
    /** Every document in the KB, or every enabled or disabled one. */
    enabledFilter: z.enum(["all", "enabled", "disabled"]).optional(),
  })
  .superRefine((value, ctx) => {
    if ((value.documentIds === undefined) === (value.enabledFilter === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["documentIds"],
        message: "provide exactly one of `documentIds` or `enabledFilter`",
      });
    }
  });
export type BulkDocumentsRequest = z.infer<typeof BulkDocumentsRequestSchema>;

/**
 * How many documents the operation actually changed.
 *
 * One number and not a per-id outcome: for the ids form every id was checked
 * to be in this KB before anything was written, so a caller that got a `200`
 * knows which documents it named — and for the by-filter form it never held a
 * list to reconcile against. A count below what was asked for means a document
 * was concurrently deleted, which is the same answer a re-read gives.
 */
export const BulkDocumentsResponseSchema = z.object({
  affected: z.number().int().nonnegative(),
});
export type BulkDocumentsResponse = z.infer<typeof BulkDocumentsResponseSchema>;

// ─── Chunks ──────────────────────────────────────────────────────────────────

/**
 * A chunk as the chunk routes return it. The shared `embedding` table's row.
 *
 * **`documentId` is required, on every route that answers with a chunk.** The
 * column is `NOT NULL` — a chunk with no document is not a row this table holds
 * — and each of the four producers already knows which document it is answering
 * about without a second query: the listing, the create and the `PATCH` are
 * addressed *through* a document, and the chunk-by-id read is handed the whole
 * `embedding` row by `requireChunkInKb`. So none of them had to make it
 * optional.
 *
 * It is here because the chunk-by-id read could not say it. Studio's unwired
 * chunk lookup filters `embedding.document_id = :documentId`, asserting the
 * chunk is in *this* document rather than a sibling in the same KB, and
 * `chunks.get` takes no document — so the wrapper stamped the caller's own
 * `documentId` back onto the answer rather than reading one (TASK-009c,
 * contract request 12). Now the row says which document it is in, and a caller
 * comparing the two is making the assertion itself.
 */
export const ChunkSchema = z.object({
  id: z.string(),
  /** The document this chunk belongs to. Off the row, never inferred. */
  documentId: z.string(),
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

/**
 * `POST /v1/kbs/:id/documents/:docId/chunks` — one chunk, written by hand.
 *
 * The content is **embedded through the KB's own endpoint** before it is
 * stored, exactly as a content change on {@link UpdateChunkRequestSchema} is:
 * a chunk whose text and vector disagree ranks for the wrong query. The chunk
 * is appended at the next `chunkIndex`, inherits every tag value from its
 * document, and the document's `chunkCount`, `tokenCount` and
 * `characterCount` go up by what it added — all of that is the lifted
 * `createChunk` and none of it is this route's decision (ADR 0005).
 *
 * Studio's chunk editor has always been able to add one
 * (`POST /api/knowledge/[id]/documents/[documentId]/chunks`) and there was
 * nothing on the wire for it, so the action refused on a wired workspace
 * (TASK-009's second round, contract change 9).
 */
export const CreateChunkRequestSchema = z.object({
  content: z.string().min(1),
  /** `true` when absent: a chunk added by hand is one a caller wants found. */
  enabled: z.boolean().optional(),
});
export type CreateChunkRequest = z.infer<typeof CreateChunkRequestSchema>;

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
