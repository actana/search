/**
 * drizzle-kit configuration.
 *
 * `schemaFilter` is not a nicety: without it `drizzle-kit generate` compares
 * against *every* schema in the database and, when Search shares a Postgres
 * with Studio, happily emits `DROP TABLE` for Studio's tables. Search owns
 * `search` and nothing else (ADR 0002), and this is where that is enforced
 * against the generator.
 *
 * The per-KB vector partitions are created at runtime by `src/kb/ddl.ts` and
 * are deliberately absent from the schema file; a `tablesFilter` keeps the
 * generator from proposing to drop them.
 */
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  schemaFilter: ["search"],
  tablesFilter: ["!kb_embedding_*"],
  dbCredentials: {
    url: process.env.SEARCH_DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/search",
  },
  migrations: {
    schema: "search",
    table: "__drizzle_migrations",
  },
  strict: true,
  verbose: true,
});
