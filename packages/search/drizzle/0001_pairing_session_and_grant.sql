-- TASK-006 — the pairing tables as Control's copied handshake needs them.
--
-- Hand-written rather than generated, because two of the changes are renames
-- and `drizzle-kit generate` can only be told a rename from a rename is not a
-- drop-and-add through an interactive prompt. The snapshot beside this file is
-- the generator's own, so `drizzle-kit generate` keeps working from here.
--
--   * `pairing_code.code` -> `pairing_code.id`. The column never held a code
--     and never will: what a redemption names is the *session*, and the code
--     itself exists only in the terminal that printed it (ADR 0034 D1). The
--     digest goes in the new `code_hash`.
--   * `paired_client.scopes` -> `paired_client.scope`. One of `read`, `write`,
--     `admin`, not a list (ADR 0003, CONTEXT.md "Scope").
--
-- Everything else is additive.

ALTER TABLE "search"."pairing_code" RENAME COLUMN "code" TO "id";--> statement-breakpoint
ALTER TABLE "search"."paired_client" RENAME COLUMN "scopes" TO "scope";--> statement-breakpoint

ALTER TABLE "search"."pairing_code" ADD COLUMN "code_hash" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "search"."pairing_code" ALTER COLUMN "code_hash" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "search"."pairing_code" ALTER COLUMN "label" SET DEFAULT '';--> statement-breakpoint
UPDATE "search"."pairing_code" SET "label" = '' WHERE "label" IS NULL;--> statement-breakpoint
ALTER TABLE "search"."pairing_code" ALTER COLUMN "label" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "search"."pairing_code" ADD COLUMN "revoked_at" timestamp;--> statement-breakpoint
ALTER TABLE "search"."pairing_code" ADD COLUMN "attempt_cap" integer DEFAULT 5 NOT NULL;--> statement-breakpoint
ALTER TABLE "search"."pairing_code" ADD COLUMN "scope" text DEFAULT 'admin' NOT NULL;--> statement-breakpoint
ALTER TABLE "search"."pairing_code" ADD COLUMN "kb_ids" jsonb;--> statement-breakpoint
ALTER TABLE "search"."pairing_code" ADD COLUMN "created_by" text;--> statement-breakpoint
ALTER TABLE "search"."pairing_code" ADD COLUMN "tenant_id" text;--> statement-breakpoint
ALTER TABLE "search"."pairing_code" ADD COLUMN "auth_method" text;--> statement-breakpoint

ALTER TABLE "search"."paired_client" ADD COLUMN "cert_subject" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "search"."paired_client" ADD COLUMN "cert_not_after" timestamp;--> statement-breakpoint
ALTER TABLE "search"."paired_client" ADD COLUMN "session_id" text;
