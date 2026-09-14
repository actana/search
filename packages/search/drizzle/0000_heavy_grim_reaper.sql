CREATE SCHEMA IF NOT EXISTS "search";
--> statement-breakpoint
CREATE TABLE "search"."document" (
	"id" text PRIMARY KEY NOT NULL,
	"knowledge_base_id" text NOT NULL,
	"filename" text NOT NULL,
	"file_url" text NOT NULL,
	"file_size" integer NOT NULL,
	"mime_type" text NOT NULL,
	"chunk_count" integer DEFAULT 0 NOT NULL,
	"processed_chunks" integer DEFAULT 0 NOT NULL,
	"token_count" integer DEFAULT 0 NOT NULL,
	"character_count" integer DEFAULT 0 NOT NULL,
	"processing_status" text DEFAULT 'pending' NOT NULL,
	"processing_started_at" timestamp,
	"processing_completed_at" timestamp,
	"processing_error" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"included_in_kb" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp,
	"deleted_at" timestamp,
	"user_excluded" boolean DEFAULT false NOT NULL,
	"tag1" text,
	"tag2" text,
	"tag3" text,
	"tag4" text,
	"tag5" text,
	"tag6" text,
	"tag7" text,
	"number1" double precision,
	"number2" double precision,
	"number3" double precision,
	"number4" double precision,
	"number5" double precision,
	"date1" timestamp,
	"date2" timestamp,
	"boolean1" boolean,
	"boolean2" boolean,
	"boolean3" boolean,
	"connector_id" text,
	"external_id" text,
	"content_hash" text,
	"source_url" text,
	"keyword_status" text,
	"uploaded_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "search"."document_embed_batch" (
	"id" text PRIMARY KEY NOT NULL,
	"document_id" text NOT NULL,
	"knowledge_base_id" text NOT NULL,
	"start_index" integer NOT NULL,
	"end_index" integer NOT NULL,
	"endpoint_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "search"."document_keyword" (
	"document_id" text NOT NULL,
	"kb_keyword_id" text NOT NULL,
	"chunk_count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "document_keyword_document_id_kb_keyword_id_pk" PRIMARY KEY("document_id","kb_keyword_id")
);
--> statement-breakpoint
CREATE TABLE "search"."embedding" (
	"id" text PRIMARY KEY NOT NULL,
	"knowledge_base_id" text NOT NULL,
	"document_id" text NOT NULL,
	"chunk_index" integer NOT NULL,
	"chunk_hash" text NOT NULL,
	"content" text NOT NULL,
	"content_length" integer NOT NULL,
	"token_count" integer NOT NULL,
	"embedding" vector,
	"embedding_model" text DEFAULT 'text-embedding-3-small' NOT NULL,
	"start_offset" integer NOT NULL,
	"end_offset" integer NOT NULL,
	"tag1" text,
	"tag2" text,
	"tag3" text,
	"tag4" text,
	"tag5" text,
	"tag6" text,
	"tag7" text,
	"number1" double precision,
	"number2" double precision,
	"number3" double precision,
	"number4" double precision,
	"number5" double precision,
	"date1" timestamp,
	"date2" timestamp,
	"boolean1" boolean,
	"boolean2" boolean,
	"boolean3" boolean,
	"enabled" boolean DEFAULT true NOT NULL,
	"content_tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', "search"."embedding"."content")) STORED,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "search"."embedding_keyword" (
	"embedding_id" text NOT NULL,
	"kb_keyword_id" text NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "embedding_keyword_embedding_id_kb_keyword_id_pk" PRIMARY KEY("embedding_id","kb_keyword_id")
);
--> statement-breakpoint
CREATE TABLE "search"."kb_cluster" (
	"id" text PRIMARY KEY NOT NULL,
	"kb_id" text NOT NULL,
	"cluster_id" integer NOT NULL,
	"centroid" jsonb NOT NULL,
	"size" integer DEFAULT 0 NOT NULL,
	"inertia" real
);
--> statement-breakpoint
CREATE TABLE "search"."kb_keyword" (
	"id" text PRIMARY KEY NOT NULL,
	"knowledge_base_id" text NOT NULL,
	"keyword" text NOT NULL,
	"display_label" text NOT NULL,
	"usage_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"created_by_user_id" text
);
--> statement-breakpoint
CREATE TABLE "search"."knowledge_base" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"paired_client_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"token_count" integer DEFAULT 0 NOT NULL,
	"embedding_model" text DEFAULT 'text-embedding-3-small',
	"embedding_dimension" integer DEFAULT 1536 NOT NULL,
	"inference_model_id" text,
	"embedding_endpoint_id" text,
	"inference_endpoint_id" text,
	"kmeans_k" integer DEFAULT 8 NOT NULL,
	"kmeans_updated_at" timestamp,
	"kmeans_silhouette" real,
	"language" text DEFAULT 'english' NOT NULL,
	"chunking_config" json DEFAULT '{"maxSize": 1024, "minSize": 1, "overlap": 200}' NOT NULL,
	"deleted_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "search"."knowledge_base_tag_definitions" (
	"id" text PRIMARY KEY NOT NULL,
	"knowledge_base_id" text NOT NULL,
	"tag_slot" text NOT NULL,
	"display_name" text NOT NULL,
	"field_type" text DEFAULT 'text' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "search"."model_endpoint" (
	"id" text PRIMARY KEY NOT NULL,
	"paired_client_id" text NOT NULL,
	"kind" text NOT NULL,
	"provider" text NOT NULL,
	"template" text NOT NULL,
	"model" text,
	"dimension" integer,
	"base_url" text,
	"key_ciphertext" text,
	"source" text DEFAULT 'local' NOT NULL,
	"external_id" text,
	"label" text,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "model_endpoint_kind_check" CHECK ("kind" IN ('inference', 'embedding')),
	CONSTRAINT "model_endpoint_source_check" CHECK ("source" IN ('local', 'mirrored')),
	CONSTRAINT "model_endpoint_dimension_kind_check" CHECK (("kind" = 'embedding' AND "dimension" IS NOT NULL) OR ("kind" = 'inference' AND "dimension" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "search"."paired_client" (
	"id" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"platform" text,
	"cert_serial" text NOT NULL,
	"cert_fingerprint" text NOT NULL,
	"scopes" text DEFAULT 'read' NOT NULL,
	"kb_ids" jsonb,
	"status" text DEFAULT 'active' NOT NULL,
	"last_seen_at" timestamp,
	"revoked_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "search"."pairing_code" (
	"code" text PRIMARY KEY NOT NULL,
	"paired_client_id" text,
	"label" text,
	"expires_at" timestamp NOT NULL,
	"consumed_at" timestamp,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "search"."webhook" (
	"id" text PRIMARY KEY NOT NULL,
	"paired_client_id" text NOT NULL,
	"url" text NOT NULL,
	"secret_ciphertext" text NOT NULL,
	"events" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "search"."webhook_delivery" (
	"id" text PRIMARY KEY NOT NULL,
	"webhook_id" text NOT NULL,
	"event_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "search"."document" ADD CONSTRAINT "document_knowledge_base_id_knowledge_base_id_fk" FOREIGN KEY ("knowledge_base_id") REFERENCES "search"."knowledge_base"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search"."document_embed_batch" ADD CONSTRAINT "document_embed_batch_document_id_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "search"."document"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search"."document_embed_batch" ADD CONSTRAINT "document_embed_batch_knowledge_base_id_knowledge_base_id_fk" FOREIGN KEY ("knowledge_base_id") REFERENCES "search"."knowledge_base"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search"."document_keyword" ADD CONSTRAINT "document_keyword_document_id_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "search"."document"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search"."document_keyword" ADD CONSTRAINT "document_keyword_kb_keyword_id_kb_keyword_id_fk" FOREIGN KEY ("kb_keyword_id") REFERENCES "search"."kb_keyword"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search"."embedding" ADD CONSTRAINT "embedding_knowledge_base_id_knowledge_base_id_fk" FOREIGN KEY ("knowledge_base_id") REFERENCES "search"."knowledge_base"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search"."embedding" ADD CONSTRAINT "embedding_document_id_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "search"."document"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search"."embedding_keyword" ADD CONSTRAINT "embedding_keyword_embedding_id_embedding_id_fk" FOREIGN KEY ("embedding_id") REFERENCES "search"."embedding"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search"."embedding_keyword" ADD CONSTRAINT "embedding_keyword_kb_keyword_id_kb_keyword_id_fk" FOREIGN KEY ("kb_keyword_id") REFERENCES "search"."kb_keyword"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search"."kb_cluster" ADD CONSTRAINT "kb_cluster_kb_id_knowledge_base_id_fk" FOREIGN KEY ("kb_id") REFERENCES "search"."knowledge_base"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search"."kb_keyword" ADD CONSTRAINT "kb_keyword_knowledge_base_id_knowledge_base_id_fk" FOREIGN KEY ("knowledge_base_id") REFERENCES "search"."knowledge_base"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search"."knowledge_base" ADD CONSTRAINT "knowledge_base_paired_client_id_paired_client_id_fk" FOREIGN KEY ("paired_client_id") REFERENCES "search"."paired_client"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search"."knowledge_base" ADD CONSTRAINT "knowledge_base_embedding_endpoint_id_model_endpoint_id_fk" FOREIGN KEY ("embedding_endpoint_id") REFERENCES "search"."model_endpoint"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search"."knowledge_base" ADD CONSTRAINT "knowledge_base_inference_endpoint_id_model_endpoint_id_fk" FOREIGN KEY ("inference_endpoint_id") REFERENCES "search"."model_endpoint"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search"."knowledge_base_tag_definitions" ADD CONSTRAINT "knowledge_base_tag_definitions_knowledge_base_id_knowledge_base_id_fk" FOREIGN KEY ("knowledge_base_id") REFERENCES "search"."knowledge_base"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search"."model_endpoint" ADD CONSTRAINT "model_endpoint_paired_client_id_paired_client_id_fk" FOREIGN KEY ("paired_client_id") REFERENCES "search"."paired_client"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search"."pairing_code" ADD CONSTRAINT "pairing_code_paired_client_id_paired_client_id_fk" FOREIGN KEY ("paired_client_id") REFERENCES "search"."paired_client"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search"."webhook" ADD CONSTRAINT "webhook_paired_client_id_paired_client_id_fk" FOREIGN KEY ("paired_client_id") REFERENCES "search"."paired_client"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search"."webhook_delivery" ADD CONSTRAINT "webhook_delivery_webhook_id_webhook_id_fk" FOREIGN KEY ("webhook_id") REFERENCES "search"."webhook"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "doc_kb_id_idx" ON "search"."document" USING btree ("knowledge_base_id");--> statement-breakpoint
CREATE INDEX "doc_filename_idx" ON "search"."document" USING btree ("filename");--> statement-breakpoint
CREATE INDEX "doc_processing_status_idx" ON "search"."document" USING btree ("knowledge_base_id","processing_status");--> statement-breakpoint
CREATE UNIQUE INDEX "doc_connector_external_id_idx" ON "search"."document" USING btree ("connector_id","external_id") WHERE "search"."document"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "doc_connector_id_idx" ON "search"."document" USING btree ("connector_id");--> statement-breakpoint
CREATE INDEX "doc_archived_at_idx" ON "search"."document" USING btree ("archived_at");--> statement-breakpoint
CREATE INDEX "doc_deleted_at_idx" ON "search"."document" USING btree ("deleted_at");--> statement-breakpoint
CREATE INDEX "doc_tag1_idx" ON "search"."document" USING btree ("tag1");--> statement-breakpoint
CREATE INDEX "doc_tag2_idx" ON "search"."document" USING btree ("tag2");--> statement-breakpoint
CREATE INDEX "doc_tag3_idx" ON "search"."document" USING btree ("tag3");--> statement-breakpoint
CREATE INDEX "doc_tag4_idx" ON "search"."document" USING btree ("tag4");--> statement-breakpoint
CREATE INDEX "doc_tag5_idx" ON "search"."document" USING btree ("tag5");--> statement-breakpoint
CREATE INDEX "doc_tag6_idx" ON "search"."document" USING btree ("tag6");--> statement-breakpoint
CREATE INDEX "doc_tag7_idx" ON "search"."document" USING btree ("tag7");--> statement-breakpoint
CREATE INDEX "doc_number1_idx" ON "search"."document" USING btree ("number1");--> statement-breakpoint
CREATE INDEX "doc_number2_idx" ON "search"."document" USING btree ("number2");--> statement-breakpoint
CREATE INDEX "doc_number3_idx" ON "search"."document" USING btree ("number3");--> statement-breakpoint
CREATE INDEX "doc_number4_idx" ON "search"."document" USING btree ("number4");--> statement-breakpoint
CREATE INDEX "doc_number5_idx" ON "search"."document" USING btree ("number5");--> statement-breakpoint
CREATE INDEX "doc_date1_idx" ON "search"."document" USING btree ("date1");--> statement-breakpoint
CREATE INDEX "doc_date2_idx" ON "search"."document" USING btree ("date2");--> statement-breakpoint
CREATE INDEX "doc_boolean1_idx" ON "search"."document" USING btree ("boolean1");--> statement-breakpoint
CREATE INDEX "doc_boolean2_idx" ON "search"."document" USING btree ("boolean2");--> statement-breakpoint
CREATE INDEX "doc_boolean3_idx" ON "search"."document" USING btree ("boolean3");--> statement-breakpoint
CREATE INDEX "doc_embed_batch_doc_idx" ON "search"."document_embed_batch" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "doc_embed_batch_kb_idx" ON "search"."document_embed_batch" USING btree ("knowledge_base_id");--> statement-breakpoint
CREATE INDEX "document_keyword_document_idx" ON "search"."document_keyword" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "document_keyword_kb_keyword_idx" ON "search"."document_keyword" USING btree ("kb_keyword_id");--> statement-breakpoint
CREATE INDEX "document_keyword_kw_count_idx" ON "search"."document_keyword" USING btree ("kb_keyword_id","chunk_count" DESC);--> statement-breakpoint
CREATE INDEX "emb_kb_id_idx" ON "search"."embedding" USING btree ("knowledge_base_id");--> statement-breakpoint
CREATE INDEX "emb_doc_id_idx" ON "search"."embedding" USING btree ("document_id");--> statement-breakpoint
CREATE UNIQUE INDEX "emb_doc_chunk_idx" ON "search"."embedding" USING btree ("document_id","chunk_index");--> statement-breakpoint
CREATE INDEX "emb_kb_model_idx" ON "search"."embedding" USING btree ("knowledge_base_id","embedding_model");--> statement-breakpoint
CREATE INDEX "emb_kb_enabled_idx" ON "search"."embedding" USING btree ("knowledge_base_id","enabled");--> statement-breakpoint
CREATE INDEX "emb_doc_enabled_idx" ON "search"."embedding" USING btree ("document_id","enabled");--> statement-breakpoint
CREATE INDEX "emb_tag1_idx" ON "search"."embedding" USING btree ("tag1");--> statement-breakpoint
CREATE INDEX "emb_tag2_idx" ON "search"."embedding" USING btree ("tag2");--> statement-breakpoint
CREATE INDEX "emb_tag3_idx" ON "search"."embedding" USING btree ("tag3");--> statement-breakpoint
CREATE INDEX "emb_tag4_idx" ON "search"."embedding" USING btree ("tag4");--> statement-breakpoint
CREATE INDEX "emb_tag5_idx" ON "search"."embedding" USING btree ("tag5");--> statement-breakpoint
CREATE INDEX "emb_tag6_idx" ON "search"."embedding" USING btree ("tag6");--> statement-breakpoint
CREATE INDEX "emb_tag7_idx" ON "search"."embedding" USING btree ("tag7");--> statement-breakpoint
CREATE INDEX "emb_number1_idx" ON "search"."embedding" USING btree ("number1");--> statement-breakpoint
CREATE INDEX "emb_number2_idx" ON "search"."embedding" USING btree ("number2");--> statement-breakpoint
CREATE INDEX "emb_number3_idx" ON "search"."embedding" USING btree ("number3");--> statement-breakpoint
CREATE INDEX "emb_number4_idx" ON "search"."embedding" USING btree ("number4");--> statement-breakpoint
CREATE INDEX "emb_number5_idx" ON "search"."embedding" USING btree ("number5");--> statement-breakpoint
CREATE INDEX "emb_date1_idx" ON "search"."embedding" USING btree ("date1");--> statement-breakpoint
CREATE INDEX "emb_date2_idx" ON "search"."embedding" USING btree ("date2");--> statement-breakpoint
CREATE INDEX "emb_boolean1_idx" ON "search"."embedding" USING btree ("boolean1");--> statement-breakpoint
CREATE INDEX "emb_boolean2_idx" ON "search"."embedding" USING btree ("boolean2");--> statement-breakpoint
CREATE INDEX "emb_boolean3_idx" ON "search"."embedding" USING btree ("boolean3");--> statement-breakpoint
CREATE INDEX "emb_content_fts_idx" ON "search"."embedding" USING gin ("content_tsv");--> statement-breakpoint
CREATE INDEX "embedding_keyword_embedding_idx" ON "search"."embedding_keyword" USING btree ("embedding_id");--> statement-breakpoint
CREATE INDEX "embedding_keyword_kb_keyword_idx" ON "search"."embedding_keyword" USING btree ("kb_keyword_id");--> statement-breakpoint
CREATE INDEX "embedding_keyword_kw_emb_idx" ON "search"."embedding_keyword" USING btree ("kb_keyword_id","embedding_id");--> statement-breakpoint
CREATE UNIQUE INDEX "kb_cluster_kb_cluster_unique" ON "search"."kb_cluster" USING btree ("kb_id","cluster_id");--> statement-breakpoint
CREATE INDEX "kb_cluster_kb_idx" ON "search"."kb_cluster" USING btree ("kb_id");--> statement-breakpoint
CREATE UNIQUE INDEX "kb_keyword_kb_keyword_idx" ON "search"."kb_keyword" USING btree ("knowledge_base_id","keyword");--> statement-breakpoint
CREATE INDEX "kb_keyword_kb_id_idx" ON "search"."kb_keyword" USING btree ("knowledge_base_id");--> statement-breakpoint
CREATE INDEX "kb_keyword_kb_usage_idx" ON "search"."kb_keyword" USING btree ("knowledge_base_id","usage_count" DESC);--> statement-breakpoint
CREATE INDEX "kb_owner_id_idx" ON "search"."knowledge_base" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "kb_paired_client_id_idx" ON "search"."knowledge_base" USING btree ("paired_client_id");--> statement-breakpoint
CREATE INDEX "kb_owner_client_idx" ON "search"."knowledge_base" USING btree ("owner_id","paired_client_id");--> statement-breakpoint
CREATE INDEX "kb_deleted_at_idx" ON "search"."knowledge_base" USING btree ("deleted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "kb_client_name_active_unique" ON "search"."knowledge_base" USING btree ("paired_client_id","name") WHERE "search"."knowledge_base"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "kb_tag_definitions_kb_slot_idx" ON "search"."knowledge_base_tag_definitions" USING btree ("knowledge_base_id","tag_slot");--> statement-breakpoint
CREATE UNIQUE INDEX "kb_tag_definitions_kb_display_name_idx" ON "search"."knowledge_base_tag_definitions" USING btree ("knowledge_base_id","display_name");--> statement-breakpoint
CREATE INDEX "kb_tag_definitions_kb_id_idx" ON "search"."knowledge_base_tag_definitions" USING btree ("knowledge_base_id");--> statement-breakpoint
CREATE INDEX "model_endpoint_paired_client_idx" ON "search"."model_endpoint" USING btree ("paired_client_id");--> statement-breakpoint
CREATE INDEX "model_endpoint_client_provider_idx" ON "search"."model_endpoint" USING btree ("paired_client_id","provider");--> statement-breakpoint
CREATE UNIQUE INDEX "model_endpoint_external_id_unique" ON "search"."model_endpoint" USING btree ("paired_client_id","external_id") WHERE "search"."model_endpoint"."external_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "paired_client_cert_serial_unique" ON "search"."paired_client" USING btree ("cert_serial");--> statement-breakpoint
CREATE INDEX "paired_client_cert_fingerprint_idx" ON "search"."paired_client" USING btree ("cert_fingerprint");--> statement-breakpoint
CREATE INDEX "paired_client_status_idx" ON "search"."paired_client" USING btree ("status");--> statement-breakpoint
CREATE INDEX "pairing_code_expires_at_idx" ON "search"."pairing_code" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "pairing_code_paired_client_idx" ON "search"."pairing_code" USING btree ("paired_client_id");--> statement-breakpoint
CREATE INDEX "webhook_paired_client_idx" ON "search"."webhook" USING btree ("paired_client_id");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_delivery_hook_event_unique" ON "search"."webhook_delivery" USING btree ("webhook_id","event_id");--> statement-breakpoint
CREATE INDEX "webhook_delivery_status_idx" ON "search"."webhook_delivery" USING btree ("status");