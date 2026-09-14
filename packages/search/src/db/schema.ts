/**
 * The `search` schema (ADR 0002).
 *
 * Every table Search reads or writes lives in the `search` Postgres schema, and
 * Search references nothing outside it. The columns of the lifted tables are
 * **deliberately identical to Studio's** (`packages/db/schema.ts`) so the
 * phase-4 data move is as close to `ALTER TABLE … SET SCHEMA` as it can be.
 * Three columns are renamed:
 *
 *   - `workspace_id` → `paired_client_id`, and NOT NULL. Search does not know
 *     what a workspace is; it knows which client certificate owns a row
 *     (ADR 0003).
 *   - `user_id` → `owner_id`, plain text, no foreign key. Search has no user
 *     table and will not grow one.
 *   - the endpoint columns point at `search.model_endpoint` instead of
 *     Studio's `workspace_model_endpoints` (ADR 0004).
 *
 * **`SET SCHEMA` alone is not the migration, and this file used to claim it
 * was.** A moved table keeps its foreign keys, and four of Studio's point at
 * tables that stay behind (`public.user`, `public.workspace`,
 * `public.workspace_model_endpoints`, `public.knowledge_connector`); the
 * `knowledge_base` indexes carry `user`/`workspace` in their names and have to
 * be renamed with the columns; `paired_client_id` gains a NOT NULL that
 * Studio's nullable `workspace_id` does not satisfy; and `model_endpoint` is
 * **not** column-compatible with `workspace_model_endpoints` at all — it is
 * mirrored by push (ADR 0004), never moved. The full list, statement by
 * statement, is in `docs/migration-from-studio.md`, which TASK-013 implements.
 *
 * Three Studio tables are deliberately absent. `agent_knowledge_base` stays in
 * Studio — an agent is a Studio concept, and its `knowledge_base_id` becomes a
 * plain remote id. `knowledge_connector` and its sync log stay for the same
 * reason; `document.connector_id` is therefore plain `text` here with nothing
 * behind it.
 *
 * The per-KB vector partitions (`kb_embedding_<sha>`) are **not** in this file
 * and must never be added to it: their vector column is sized to their KB's
 * model, so they are created at runtime by `../kb/ddl.ts`. Listing one here
 * would make `drizzle-kit generate` emit `DROP TABLE` for live data.
 */

import { type SQL, sql } from "drizzle-orm";
import {
  boolean,
  check,
  customType,
  doublePrecision,
  index,
  integer,
  json,
  jsonb,
  pgSchema,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/** The Postgres schema Search owns. Nothing outside it is Search's (ADR 0002). */
export const SEARCH_SCHEMA = "search";

export const searchSchema = pgSchema(SEARCH_SCHEMA);

/**
 * `"search"."<table>"`, for the statements the engine writes by hand.
 *
 * Drizzle qualifies every table it builds a query for, because `pgSchema` told
 * it where the table lives. Raw SQL has no such knowledge, and a bare table
 * name in raw SQL is resolved by the connection's `search_path` — which on a
 * database Search shares with Studio resolves to *Studio's* identically-named
 * table. Every hand-written statement in the engine goes through this.
 */
export function qualified(table: string): string {
  return `"${SEARCH_SCHEMA}"."${table}"`;
}

/**
 * The migration count this schema file describes. Reported by
 * `GET /v1/capabilities` so a client can tell whether the instance it is
 * talking to is older than the SDK it is holding. Bump it in the same commit
 * as a new migration.
 */
export const SCHEMA_VERSION = 2;

/**
 * Dimensionless `vector` column for the shared `embedding` table. The per-KB
 * partition is the authoritative typed vector store, sized to its model's
 * dimension; this column accepts any width (or NULL) so a KB bound to a
 * non-1536-dim model still ingests.
 */
export const dynamicVector = customType<{
  data: number[];
  driverData: string;
}>({
  dataType() {
    return "vector";
  },
  toDriver(value: number[]): string {
    return JSON.stringify(value);
  },
  fromDriver(value: string): number[] {
    return value
      .slice(1, -1)
      .split(",")
      .map((v) => Number.parseFloat(v));
  },
});

/** Full-text search column. Generated, never written directly. */
export const tsvector = customType<{
  data: string;
}>({
  dataType() {
    return "tsvector";
  },
});

/** The seventeen tag slots a Document carries and its chunks inherit. */
export const TEXT_TAG_SLOTS = ["tag1", "tag2", "tag3", "tag4", "tag5", "tag6", "tag7"] as const;
export const NUMBER_TAG_SLOTS = ["number1", "number2", "number3", "number4", "number5"] as const;
export const DATE_TAG_SLOTS = ["date1", "date2"] as const;
export const BOOLEAN_TAG_SLOTS = ["boolean1", "boolean2", "boolean3"] as const;
export const TAG_SLOTS = [
  ...TEXT_TAG_SLOTS,
  ...NUMBER_TAG_SLOTS,
  ...DATE_TAG_SLOTS,
  ...BOOLEAN_TAG_SLOTS,
] as const;

export type TagSlot = (typeof TAG_SLOTS)[number];
export type TextTagSlot = (typeof TEXT_TAG_SLOTS)[number];
export type NumberTagSlot = (typeof NUMBER_TAG_SLOTS)[number];
export type DateTagSlot = (typeof DATE_TAG_SLOTS)[number];
export type BooleanTagSlot = (typeof BOOLEAN_TAG_SLOTS)[number];

// ---------------------------------------------------------------------------
// Identity — who is asking (ADR 0003)
// ---------------------------------------------------------------------------

/**
 * One row per client certificate. Named after Control's per-client
 * certificate, never "tenant": Search's only notion of who is asking is which
 * certificate presented itself on the connection.
 */
export const pairedClient = searchSchema.table(
  "paired_client",
  {
    id: text("id").primaryKey(),
    /** Human label, chosen by the client at redemption ("actanastudio"). */
    label: text("label").notNull(),
    /** Where it runs — free-form, for the operator's benefit only. */
    platform: text("platform"),
    /** Serial of the issued client certificate. The lookup key on every request. */
    certSerial: text("cert_serial").notNull(),
    /** SHA-256 of the certificate, for display and for revocation lists. */
    certFingerprint: text("cert_fingerprint").notNull(),
    /** The subject as issued, e.g. `CN=actanastudio`. Display only. */
    certSubject: text("cert_subject").notNull().default(""),
    /** Wall clock at which the issued certificate stops verifying. */
    certNotAfter: timestamp("cert_not_after"),
    /** The pairing session this client redeemed, so an audit can join the two. */
    sessionId: text("session_id"),
    /** One of `read`, `write`, `admin`. Deliberately coarse (ADR 0003). */
    scope: text("scope").notNull().default("read"),
    /** Optional allow-list of KB ids. NULL means every KB this client owns. */
    kbIds: jsonb("kb_ids"),
    /** 'active' | 'revoked'. */
    status: text("status").notNull().default("active"),
    lastSeenAt: timestamp("last_seen_at"),
    revokedAt: timestamp("revoked_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    certSerialUnique: uniqueIndex("paired_client_cert_serial_unique").on(table.certSerial),
    certFingerprintIdx: index("paired_client_cert_fingerprint_idx").on(table.certFingerprint),
    statusIdx: index("paired_client_status_idx").on(table.status),
  }),
);

/**
 * The short-code pairing session. Control keeps this in a JSON file beside its
 * material; Search keeps it in Postgres because Search may be more than one
 * process and a code redeemed against one of them must be spent for all of
 * them.
 *
 * **The code itself is not in here.** The primary key is the *session id* — the
 * thing a redemption names — and `code_hash` is a digest keyed by the
 * instance's own secret (`@actana/search-shared/pairing/pairing-code-digest`).
 * A copy of this table is therefore not a pile of live pairing codes, which is
 * ADR 0034 D1 and the reason the column the table shipped with in TASK-003 was
 * renamed rather than filled in: a column called `code` that held a digest
 * would have been a lie a reader could act on.
 */
export const pairingCode = searchSchema.table(
  "pairing_code",
  {
    /** The session id. What a redemption names, and what the digest binds to. */
    id: text("id").primaryKey(),
    /** Set on redemption — the client this code minted. */
    pairedClientId: text("paired_client_id").references(() => pairedClient.id, {
      onDelete: "set null",
    }),
    /** The operator's name for the machine being paired. Display only. */
    label: text("label").notNull().default(""),
    /** HMAC of `<sessionId>:<CODE>` under the instance's derived key. */
    codeHash: text("code_hash").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    /** Set once, by the redemption that spent it. Single-use is enforced here. */
    consumedAt: timestamp("consumed_at"),
    /** Set by `pair revoke` cancelling a code before anybody redeemed it. */
    revokedAt: timestamp("revoked_at"),
    /** Failed redemption attempts against this code. */
    attempts: integer("attempts").notNull().default(0),
    /** This session's cap, copied at mint so a config change cannot revive it. */
    attemptCap: integer("attempt_cap").notNull().default(5),
    /** The grant this code carries onto the client that redeems it (ADR 0003). */
    scope: text("scope").notNull().default("admin"),
    kbIds: jsonb("kb_ids"),
    /** Inert, carried from Control: the hooks a later identity layer reads. */
    createdBy: text("created_by"),
    tenantId: text("tenant_id"),
    authMethod: text("auth_method"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    expiresAtIdx: index("pairing_code_expires_at_idx").on(table.expiresAt),
    pairedClientIdx: index("pairing_code_paired_client_idx").on(table.pairedClientId),
  }),
);

// ---------------------------------------------------------------------------
// Models (ADR 0004)
// ---------------------------------------------------------------------------

/**
 * Search's endpoint registry. Standalone it is the source of truth and holds
 * the sealed key; wired it is a mirror of what a paired client pushed, with
 * `key_ciphertext` null and the live key fetched from that client's resolver
 * per job.
 *
 * Column-for-column this is Studio's `workspace_model_endpoints` with
 * `workspace_id → paired_client_id` and two columns added: `source`, which
 * says which of the two it is, and `external_id`, which is the pushing
 * client's own id for the row.
 */
export const modelEndpoint = searchSchema.table(
  "model_endpoint",
  {
    id: text("id").primaryKey(),
    pairedClientId: text("paired_client_id")
      .notNull()
      .references(() => pairedClient.id, { onDelete: "cascade" }),
    /** 'embedding' | 'inference'. */
    kind: text("kind").notNull(),
    /** Catalog provider id — `openai`, `voyage`, `google`, `cohere`, … */
    provider: text("provider").notNull(),
    /** The request shape the endpoint speaks, as distinct from the provider. */
    template: text("template").notNull(),
    /** Provider-side model name. NULL means the template's default. */
    model: text("model"),
    /** Vector width. Required for `embedding`, forbidden for `inference`. */
    dimension: integer("dimension"),
    baseUrl: text("base_url"),
    /** AES-256-GCM under `SEARCH_ENCRYPTION_KEY`. NULL when `source='mirrored'`. */
    keyCiphertext: text("key_ciphertext"),
    /** 'local' | 'mirrored'. */
    source: text("source").notNull().default("local"),
    /** The pushing client's own id for this endpoint. NULL when local. */
    externalId: text("external_id"),
    label: text("label"),
    /** Template-specific extras (Azure api-version, Vertex project, custom shape). */
    config: jsonb("config")
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    pairedClientIdx: index("model_endpoint_paired_client_idx").on(table.pairedClientId),
    pairedClientProviderIdx: index("model_endpoint_client_provider_idx").on(
      table.pairedClientId,
      table.provider,
    ),
    /** A mirrored endpoint is identified by the client's id for it. */
    externalIdUnique: uniqueIndex("model_endpoint_external_id_unique")
      .on(table.pairedClientId, table.externalId)
      .where(sql`${table.externalId} IS NOT NULL`),
    kindCheck: check("model_endpoint_kind_check", sql`"kind" IN ('inference', 'embedding')`),
    sourceCheck: check("model_endpoint_source_check", sql`"source" IN ('local', 'mirrored')`),
    /**
     * The same rule Studio enforces: an embedding endpoint has a dimension and
     * an inference endpoint does not. A KB's partition is sized from it, so a
     * NULL here would be a partition that cannot be created.
     */
    dimensionKindCheck: check(
      "model_endpoint_dimension_kind_check",
      sql`("kind" = 'embedding' AND "dimension" IS NOT NULL) OR ("kind" = 'inference' AND "dimension" IS NULL)`,
    ),
  }),
);

// ---------------------------------------------------------------------------
// The corpus
// ---------------------------------------------------------------------------

export const knowledgeBase = searchSchema.table(
  "knowledge_base",
  {
    id: text("id").primaryKey(),
    /** Plain text. Search has no user table (ADR 0002). */
    ownerId: text("owner_id").notNull(),
    /**
     * lifted: Studio's `workspace_id` was nullable, because a knowledge base
     * there could predate workspaces and belong only to a user. Here it is NOT
     * NULL: every row is owned by a client certificate (ADR 0003), and a KB with
     * no paired client is a row no route could ever return. The data migration
     * has to give Studio's NULL-workspace KBs an owner — see
     * `docs/migration-from-studio.md`.
     */
    pairedClientId: text("paired_client_id")
      .notNull()
      .references(() => pairedClient.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),

    // Token tracking for usage
    tokenCount: integer("token_count").notNull().default(0),

    // Embedding configuration
    embeddingModel: text("embedding_model").default("text-embedding-3-small"),
    embeddingDimension: integer("embedding_dimension").notNull().default(1536),

    /** Catalog id (e.g. `openai:gpt-4o-mini`) used for keyword extraction at ingest + query time. */
    inferenceModelId: text("inference_model_id"),
    /** Endpoint used to generate embeddings. */
    embeddingEndpointId: text("embedding_endpoint_id").references(() => modelEndpoint.id, {
      onDelete: "set null",
    }),
    /** Endpoint used for keyword extraction. Optional — without one, keywords are skipped. */
    inferenceEndpointId: text("inference_endpoint_id").references(() => modelEndpoint.id, {
      onDelete: "set null",
    }),
    /** Current KMeans `k`. Grows via auto-validation as the corpus broadens. */
    kmeansK: integer("kmeans_k").notNull().default(8),
    /** Last KMeans re-validation timestamp. */
    kmeansUpdatedAt: timestamp("kmeans_updated_at"),
    /** Last KMeans silhouette score (validation quality). */
    kmeansSilhouette: real("kmeans_silhouette"),
    /** Language used for the partition's generated `content_tsv` (v1: english/simple). */
    language: text("language").notNull().default("english"),

    // Chunking configuration stored as JSON for flexibility
    chunkingConfig: json("chunking_config")
      .notNull()
      .default('{"maxSize": 1024, "minSize": 1, "overlap": 200}'),

    // Soft delete support
    deletedAt: timestamp("deleted_at"),

    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    ownerIdIdx: index("kb_owner_id_idx").on(table.ownerId),
    pairedClientIdIdx: index("kb_paired_client_id_idx").on(table.pairedClientId),
    ownerClientIdx: index("kb_owner_client_idx").on(table.ownerId, table.pairedClientId),
    deletedAtIdx: index("kb_deleted_at_idx").on(table.deletedAt),
    /** One active (non-deleted) name per paired client. */
    clientNameActiveUnique: uniqueIndex("kb_client_name_active_unique")
      .on(table.pairedClientId, table.name)
      .where(sql`${table.deletedAt} IS NULL`),
  }),
);

/**
 * KMeans cluster centroids — one row per cluster per KB. Centroid stored as
 * `jsonb` (number[]) because the dimension varies per KB and centroids are
 * consumed in JS by the KMeans code, never by SQL `<=>`.
 */
export const kbCluster = searchSchema.table(
  "kb_cluster",
  {
    id: text("id").primaryKey(),
    kbId: text("kb_id")
      .notNull()
      .references(() => knowledgeBase.id, { onDelete: "cascade" }),
    clusterId: integer("cluster_id").notNull(),
    centroid: jsonb("centroid").notNull(),
    size: integer("size").notNull().default(0),
    inertia: real("inertia"),
  },
  (table) => ({
    kbClusterUnique: uniqueIndex("kb_cluster_kb_cluster_unique").on(table.kbId, table.clusterId),
    kbIdx: index("kb_cluster_kb_idx").on(table.kbId),
  }),
);

export const document = searchSchema.table(
  "document",
  {
    id: text("id").primaryKey(),
    knowledgeBaseId: text("knowledge_base_id")
      .notNull()
      .references(() => knowledgeBase.id, { onDelete: "cascade" }),

    // File information
    filename: text("filename").notNull(),
    fileUrl: text("file_url").notNull(),
    fileSize: integer("file_size").notNull(),
    mimeType: text("mime_type").notNull(),

    // Content statistics
    chunkCount: integer("chunk_count").notNull().default(0),
    /** Running count of chunks embedded AND keyworded — drives "Processing N/M". */
    processedChunks: integer("processed_chunks").notNull().default(0),
    tokenCount: integer("token_count").notNull().default(0),
    characterCount: integer("character_count").notNull().default(0),

    // Processing status
    processingStatus: text("processing_status").notNull().default("pending"),
    processingStartedAt: timestamp("processing_started_at"),
    processingCompletedAt: timestamp("processing_completed_at"),
    processingError: text("processing_error"),

    // Document state
    enabled: boolean("enabled").notNull().default(true),
    /** v2 opt-in: false = uploaded but not ingested. */
    includedInKb: boolean("included_in_kb").notNull().default(false),
    archivedAt: timestamp("archived_at"),
    deletedAt: timestamp("deleted_at"),
    userExcluded: boolean("user_excluded").notNull().default(false),

    // Document tags for filtering (inherited by all chunks)
    tag1: text("tag1"),
    tag2: text("tag2"),
    tag3: text("tag3"),
    tag4: text("tag4"),
    tag5: text("tag5"),
    tag6: text("tag6"),
    tag7: text("tag7"),
    number1: doublePrecision("number1"),
    number2: doublePrecision("number2"),
    number3: doublePrecision("number3"),
    number4: doublePrecision("number4"),
    number5: doublePrecision("number5"),
    date1: timestamp("date1"),
    date2: timestamp("date2"),
    boolean1: boolean("boolean1"),
    boolean2: boolean("boolean2"),
    boolean3: boolean("boolean3"),

    /**
     * Plain text, with no foreign key: connectors keep their OAuth credentials
     * and their sync log in Studio, so this is a remote id Search records and
     * never resolves.
     */
    connectorId: text("connector_id"),
    externalId: text("external_id"),
    contentHash: text("content_hash"),
    sourceUrl: text("source_url"),

    /** 'pending' | 'extracted' | 'skipped:no-inference-endpoint' | 'failed'. */
    keywordStatus: text("keyword_status"),

    uploadedAt: timestamp("uploaded_at").notNull().defaultNow(),
  },
  (table) => ({
    knowledgeBaseIdIdx: index("doc_kb_id_idx").on(table.knowledgeBaseId),
    filenameIdx: index("doc_filename_idx").on(table.filename),
    processingStatusIdx: index("doc_processing_status_idx").on(
      table.knowledgeBaseId,
      table.processingStatus,
    ),
    connectorExternalIdIdx: uniqueIndex("doc_connector_external_id_idx")
      .on(table.connectorId, table.externalId)
      .where(sql`${table.deletedAt} IS NULL`),
    connectorIdIdx: index("doc_connector_id_idx").on(table.connectorId),
    archivedAtIdx: index("doc_archived_at_idx").on(table.archivedAt),
    deletedAtIdx: index("doc_deleted_at_idx").on(table.deletedAt),
    tag1Idx: index("doc_tag1_idx").on(table.tag1),
    tag2Idx: index("doc_tag2_idx").on(table.tag2),
    tag3Idx: index("doc_tag3_idx").on(table.tag3),
    tag4Idx: index("doc_tag4_idx").on(table.tag4),
    tag5Idx: index("doc_tag5_idx").on(table.tag5),
    tag6Idx: index("doc_tag6_idx").on(table.tag6),
    tag7Idx: index("doc_tag7_idx").on(table.tag7),
    number1Idx: index("doc_number1_idx").on(table.number1),
    number2Idx: index("doc_number2_idx").on(table.number2),
    number3Idx: index("doc_number3_idx").on(table.number3),
    number4Idx: index("doc_number4_idx").on(table.number4),
    number5Idx: index("doc_number5_idx").on(table.number5),
    date1Idx: index("doc_date1_idx").on(table.date1),
    date2Idx: index("doc_date2_idx").on(table.date2),
    boolean1Idx: index("doc_boolean1_idx").on(table.boolean1),
    boolean2Idx: index("doc_boolean2_idx").on(table.boolean2),
    boolean3Idx: index("doc_boolean3_idx").on(table.boolean3),
  }),
);

/**
 * Per-document embedding batch ledger (the v2 fan-out).
 *
 * The ingestion planner partitions a document's chunks into ranges, assigns
 * each range to an embedding endpoint, and writes one row here per range. Each
 * `kb.embed.batch` job moves its row through
 * `pending → processing → completed | failed`, and the fan-in finalize step
 * reads them to summarise per-batch failures. The embedded chunks themselves
 * are the resume anchor; this table is the orchestration ledger.
 */
export const documentEmbedBatch = searchSchema.table(
  "document_embed_batch",
  {
    id: text("id").primaryKey(),
    documentId: text("document_id")
      .notNull()
      .references(() => document.id, { onDelete: "cascade" }),
    knowledgeBaseId: text("knowledge_base_id")
      .notNull()
      .references(() => knowledgeBase.id, { onDelete: "cascade" }),
    /** Inclusive lower / exclusive upper `chunk_index` bound of this batch. */
    startIndex: integer("start_index").notNull(),
    endIndex: integer("end_index").notNull(),
    /** Embedding endpoint this batch is routed to (null = the KB's default). */
    endpointId: text("endpoint_id"),
    /** 'pending' | 'processing' | 'completed' | 'failed'. */
    status: text("status").notNull().default("pending"),
    /** Highest worker attempt observed (queue retries, capped at queue attempts). */
    attempt: integer("attempt").notNull().default(0),
    error: text("error"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    documentIdIdx: index("doc_embed_batch_doc_idx").on(table.documentId),
    knowledgeBaseIdIdx: index("doc_embed_batch_kb_idx").on(table.knowledgeBaseId),
  }),
);

export const knowledgeBaseTagDefinitions = searchSchema.table(
  "knowledge_base_tag_definitions",
  {
    id: text("id").primaryKey(),
    knowledgeBaseId: text("knowledge_base_id")
      .notNull()
      .references(() => knowledgeBase.id, { onDelete: "cascade" }),
    tagSlot: text("tag_slot", { enum: TAG_SLOTS }).notNull(),
    displayName: text("display_name").notNull(),
    fieldType: text("field_type").notNull().default("text"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    kbTagSlotIdx: uniqueIndex("kb_tag_definitions_kb_slot_idx").on(
      table.knowledgeBaseId,
      table.tagSlot,
    ),
    kbDisplayNameIdx: uniqueIndex("kb_tag_definitions_kb_display_name_idx").on(
      table.knowledgeBaseId,
      table.displayName,
    ),
    kbIdIdx: index("kb_tag_definitions_kb_id_idx").on(table.knowledgeBaseId),
  }),
);

/**
 * The shared chunk table — the v1 tag+vector path, moved across as it is
 * (ADR 0005). The per-KB partition is where v2 chunks live; this table still
 * carries the metadata every mode reads and is the resume anchor for ingest.
 */
export const embedding = searchSchema.table(
  "embedding",
  {
    id: text("id").primaryKey(),
    knowledgeBaseId: text("knowledge_base_id")
      .notNull()
      .references(() => knowledgeBase.id, { onDelete: "cascade" }),
    documentId: text("document_id")
      .notNull()
      .references(() => document.id, { onDelete: "cascade" }),

    chunkIndex: integer("chunk_index").notNull(),
    chunkHash: text("chunk_hash").notNull(),
    content: text("content").notNull(),
    contentLength: integer("content_length").notNull(),
    tokenCount: integer("token_count").notNull(),

    /** Dimensionless — see `dynamicVector`. */
    embedding: dynamicVector("embedding"),
    embeddingModel: text("embedding_model").notNull().default("text-embedding-3-small"),

    startOffset: integer("start_offset").notNull(),
    endOffset: integer("end_offset").notNull(),

    // Tag columns inherited from the document, for filtering without a join
    tag1: text("tag1"),
    tag2: text("tag2"),
    tag3: text("tag3"),
    tag4: text("tag4"),
    tag5: text("tag5"),
    tag6: text("tag6"),
    tag7: text("tag7"),
    number1: doublePrecision("number1"),
    number2: doublePrecision("number2"),
    number3: doublePrecision("number3"),
    number4: doublePrecision("number4"),
    number5: doublePrecision("number5"),
    date1: timestamp("date1"),
    date2: timestamp("date2"),
    boolean1: boolean("boolean1"),
    boolean2: boolean("boolean2"),
    boolean3: boolean("boolean3"),

    enabled: boolean("enabled").notNull().default(true),

    contentTsv: tsvector("content_tsv").generatedAlwaysAs(
      (): SQL => sql`to_tsvector('english', ${embedding.content})`,
    ),

    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    kbIdIdx: index("emb_kb_id_idx").on(table.knowledgeBaseId),
    docIdIdx: index("emb_doc_id_idx").on(table.documentId),
    docChunkIdx: uniqueIndex("emb_doc_chunk_idx").on(table.documentId, table.chunkIndex),
    kbModelIdx: index("emb_kb_model_idx").on(table.knowledgeBaseId, table.embeddingModel),
    kbEnabledIdx: index("emb_kb_enabled_idx").on(table.knowledgeBaseId, table.enabled),
    docEnabledIdx: index("emb_doc_enabled_idx").on(table.documentId, table.enabled),
    tag1Idx: index("emb_tag1_idx").on(table.tag1),
    tag2Idx: index("emb_tag2_idx").on(table.tag2),
    tag3Idx: index("emb_tag3_idx").on(table.tag3),
    tag4Idx: index("emb_tag4_idx").on(table.tag4),
    tag5Idx: index("emb_tag5_idx").on(table.tag5),
    tag6Idx: index("emb_tag6_idx").on(table.tag6),
    tag7Idx: index("emb_tag7_idx").on(table.tag7),
    number1Idx: index("emb_number1_idx").on(table.number1),
    number2Idx: index("emb_number2_idx").on(table.number2),
    number3Idx: index("emb_number3_idx").on(table.number3),
    number4Idx: index("emb_number4_idx").on(table.number4),
    number5Idx: index("emb_number5_idx").on(table.number5),
    date1Idx: index("emb_date1_idx").on(table.date1),
    date2Idx: index("emb_date2_idx").on(table.date2),
    boolean1Idx: index("emb_boolean1_idx").on(table.boolean1),
    boolean2Idx: index("emb_boolean2_idx").on(table.boolean2),
    boolean3Idx: index("emb_boolean3_idx").on(table.boolean3),
    contentFtsIdx: index("emb_content_fts_idx").using("gin", table.contentTsv),
  }),
);

export const kbKeyword = searchSchema.table(
  "kb_keyword",
  {
    id: text("id").primaryKey(),
    knowledgeBaseId: text("knowledge_base_id")
      .notNull()
      .references(() => knowledgeBase.id, { onDelete: "cascade" }),
    /** Canonical lowercase trimmed form, used for dedup + lookup. */
    keyword: text("keyword").notNull(),
    /** Original-cased label shown in a UI. */
    displayLabel: text("display_label").notNull(),
    /** Total chunk-link count across the KB; maintained by the app. */
    usageCount: integer("usage_count").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
    /** Plain text — Search has no user table. */
    createdByUserId: text("created_by_user_id"),
  },
  (table) => ({
    kbKeywordUnique: uniqueIndex("kb_keyword_kb_keyword_idx").on(
      table.knowledgeBaseId,
      table.keyword,
    ),
    kbIdIdx: index("kb_keyword_kb_id_idx").on(table.knowledgeBaseId),
    kbUsageIdx: index("kb_keyword_kb_usage_idx").on(
      table.knowledgeBaseId,
      sql`${table.usageCount} DESC`,
    ),
  }),
);

export const embeddingKeyword = searchSchema.table(
  "embedding_keyword",
  {
    embeddingId: text("embedding_id")
      .notNull()
      .references(() => embedding.id, { onDelete: "cascade" }),
    kbKeywordId: text("kb_keyword_id")
      .notNull()
      .references(() => kbKeyword.id, { onDelete: "cascade" }),
    /** Origin of the link: 'llm' | 'manual'. */
    source: text("source").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.embeddingId, table.kbKeywordId] }),
    embeddingIdIdx: index("embedding_keyword_embedding_idx").on(table.embeddingId),
    kbKeywordIdIdx: index("embedding_keyword_kb_keyword_idx").on(table.kbKeywordId),
    kbKeywordEmbeddingIdx: index("embedding_keyword_kw_emb_idx").on(
      table.kbKeywordId,
      table.embeddingId,
    ),
  }),
);

export const documentKeyword = searchSchema.table(
  "document_keyword",
  {
    documentId: text("document_id")
      .notNull()
      .references(() => document.id, { onDelete: "cascade" }),
    kbKeywordId: text("kb_keyword_id")
      .notNull()
      .references(() => kbKeyword.id, { onDelete: "cascade" }),
    /** Count of enabled chunks of the doc carrying this keyword. */
    chunkCount: integer("chunk_count").notNull().default(0),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.documentId, table.kbKeywordId] }),
    documentIdIdx: index("document_keyword_document_idx").on(table.documentId),
    kbKeywordIdIdx: index("document_keyword_kb_keyword_idx").on(table.kbKeywordId),
    kbKeywordChunkCountIdx: index("document_keyword_kw_count_idx").on(
      table.kbKeywordId,
      sql`${table.chunkCount} DESC`,
    ),
  }),
);

// ---------------------------------------------------------------------------
// Events out (ADR 0006)
// ---------------------------------------------------------------------------

/**
 * Where to POST `document.ingested`, `document.failed`, `clusters.retrained`.
 * Search does not know what the other end does with the call.
 */
export const webhook = searchSchema.table(
  "webhook",
  {
    id: text("id").primaryKey(),
    pairedClientId: text("paired_client_id")
      .notNull()
      .references(() => pairedClient.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    /** AES-256-GCM under `SEARCH_ENCRYPTION_KEY`. Signs the delivery. */
    secretCiphertext: text("secret_ciphertext").notNull(),
    /** Event names this hook wants. */
    events: jsonb("events")
      .notNull()
      .default(sql`'[]'::jsonb`),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    pairedClientIdx: index("webhook_paired_client_idx").on(table.pairedClientId),
  }),
);

export const webhookDelivery = searchSchema.table(
  "webhook_delivery",
  {
    id: text("id").primaryKey(),
    webhookId: text("webhook_id")
      .notNull()
      .references(() => webhook.id, { onDelete: "cascade" }),
    /**
     * The id of the event being delivered. Unique per hook so a retry after an
     * ambiguous timeout is a redelivery rather than a second event.
     */
    eventId: text("event_id").notNull(),
    /** 'pending' | 'delivered' | 'failed'. */
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    webhookEventUnique: uniqueIndex("webhook_delivery_hook_event_unique").on(
      table.webhookId,
      table.eventId,
    ),
    statusIdx: index("webhook_delivery_status_idx").on(table.status),
  }),
);
