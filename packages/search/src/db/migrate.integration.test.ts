/**
 * The migrations, against a real Postgres.
 *
 * Gated on `SEARCH_TEST_DATABASE_URL`: without it the suite skips, so a
 * contributor with no database still gets a green `pnpm test`. With it, it
 * asserts the two properties a boot-time migrator has to have — that a fresh
 * database ends up with the schema, and that running it a second time is a
 * no-op rather than an error — plus the one piece of DDL that is deliberately
 * *not* a migration: the per-KB partition.
 *
 * **In a database of its own.** This is the one suite whose job is to drop and
 * rebuild the `search` schema, and every other integration suite in the package
 * works in that schema. Sharing a database with them made failures land
 * anywhere but here — a foreign-key violation in the fixture replay, a missing
 * relation in the partition suite — because the schema went out from under
 * whatever was running. So the suite creates a sibling database next to
 * `SEARCH_TEST_DATABASE_URL`, does everything there, and drops it on the way
 * out. Nothing it does can be seen by anything else.
 */

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dropKbPartition, provisionKbPartition } from "../kb/ddl.ts";
import { kbPartitionName } from "../kb/partition.ts";
import { resetConfig } from "../config.ts";
import { createDatabase, type SearchDatabase } from "./client.ts";
import { MIGRATIONS_TABLE, runMigrations, SEARCH_SCHEMA } from "./migrate.ts";

const configuredUrl = process.env.SEARCH_TEST_DATABASE_URL;

/**
 * A sibling database name derived from the configured one, so a developer and
 * CI both get `<db>_migrator` and neither has to be told about it.
 */
function siblingUrl(base: string): { url: string; adminUrl: string; name: string } {
  const parsed = new URL(base);
  const name = `${parsed.pathname.replace(/^\//, "") || "postgres"}_migrator`;
  const own = new URL(base);
  own.pathname = `/${name}`;
  const admin = new URL(base);
  admin.pathname = "/postgres";
  return { url: own.toString(), adminUrl: admin.toString(), name };
}

const sibling = configuredUrl ? siblingUrl(configuredUrl) : null;
const url = sibling?.url;

// The lifted DDL reaches for the ambient handle when no transaction is passed,
// and that handle reads `SEARCH_DATABASE_URL`. Point it at this suite's own
// database before anything touches it — the parse is memoised on first access.
if (url) {
  process.env.SEARCH_DATABASE_URL = url;
  resetConfig();
}

describe.skipIf(!url)("migrations", () => {
  let db: SearchDatabase;
  let close: () => Promise<void>;

  const rows = async (query: ReturnType<typeof sql>): Promise<Array<Record<string, unknown>>> => {
    const result = (await db.execute(query)) as unknown;
    return Array.isArray(result)
      ? (result as Array<Record<string, unknown>>)
      : (((result as { rows?: Array<Record<string, unknown>> }).rows ?? []));
  };

  const tableNames = async (): Promise<string[]> => {
    const found = await rows(
      sql`SELECT table_name FROM information_schema.tables WHERE table_schema = ${SEARCH_SCHEMA} ORDER BY table_name`,
    );
    return found.map((r) => String(r.table_name));
  };

  beforeAll(async () => {
    // Build the sibling database first. `CREATE DATABASE` cannot run inside a
    // transaction and cannot be `IF NOT EXISTS`, so it is dropped and recreated
    // — which is also what makes a re-run after a crashed one clean.
    const admin = createDatabase(sibling!.adminUrl, { max: 1 });
    try {
      await admin.db.execute(sql.raw(`DROP DATABASE IF EXISTS "${sibling!.name}" WITH (FORCE)`));
      await admin.db.execute(sql.raw(`CREATE DATABASE "${sibling!.name}"`));
    } finally {
      await admin.close();
    }

    const created = createDatabase(url!, { max: 1 });
    db = created.db;
    close = created.close;
    await db.execute(sql.raw(`DROP SCHEMA IF EXISTS "${SEARCH_SCHEMA}" CASCADE`));
  });

  afterAll(async () => {
    await close();
    const admin = createDatabase(sibling!.adminUrl, { max: 1 });
    try {
      // `WITH (FORCE)` because the ambient `db` proxy — which the lifted DDL
      // reaches for when no transaction is passed — opened a pool against this
      // database and has no close of its own.
      await admin.db.execute(sql.raw(`DROP DATABASE IF EXISTS "${sibling!.name}" WITH (FORCE)`));
    } finally {
      await admin.close();
    }
  });

  it("brings an empty database up to the schema, and is idempotent", async () => {
    await runMigrations({ url: url! });

    const first = await tableNames();
    // Every table in `schema.ts`, plus drizzle's own ledger. The per-KB
    // partitions are deliberately absent — they are runtime DDL (ADR 0002).
    expect(first).toEqual([
      MIGRATIONS_TABLE,
      "document",
      "document_embed_batch",
      "document_keyword",
      "embedding",
      "embedding_keyword",
      "kb_cluster",
      "kb_keyword",
      "knowledge_base",
      "knowledge_base_tag_definitions",
      "model_endpoint",
      "paired_client",
      "pairing_code",
      "webhook",
      "webhook_delivery",
    ]);

    // pgvector, and the shared `embedding` table's dimensionless vector column.
    const ext = await rows(sql`SELECT extname FROM pg_extension WHERE extname = 'vector'`);
    expect(ext).toHaveLength(1);

    const applied = await rows(
      sql.raw(`SELECT id FROM "${SEARCH_SCHEMA}"."${MIGRATIONS_TABLE}"`),
    );
    expect(applied.length).toBeGreaterThan(0);

    // The second run: no error, no new tables, no new ledger rows.
    await runMigrations({ url: url! });

    expect(await tableNames()).toEqual(first);
    const appliedAgain = await rows(
      sql.raw(`SELECT id FROM "${SEARCH_SCHEMA}"."${MIGRATIONS_TABLE}"`),
    );
    expect(appliedAgain).toHaveLength(applied.length);
  });

  it("survives two migrators starting at once", async () => {
    // A deployment that starts three replicas starts three migrators. Drizzle's
    // own migrator has no interlock: each reads the ledger, sees nothing
    // applied, and creates the tables — and the loser dies on `relation
    // "document" already exists`, leaving a schema with tables and an empty
    // ledger, which the *next* boot then tries to create again.
    //
    // `runMigrations` takes an advisory lock. This is the test that says so;
    // it was a real flake in this suite before the lock went in.
    await db.execute(sql.raw(`DROP SCHEMA IF EXISTS "${SEARCH_SCHEMA}" CASCADE`));

    await Promise.all([runMigrations({ url: url! }), runMigrations({ url: url! })]);

    expect(await tableNames()).toContain("knowledge_base");
    // One ledger row, not two: the second migrator found nothing to do.
    const applied = await rows(sql.raw(`SELECT id FROM "${SEARCH_SCHEMA}"."${MIGRATIONS_TABLE}"`));
    expect(applied).toHaveLength(1);
  });

  it("creates and drops a per-KB partition in the search schema", async () => {
    await runMigrations({ url: url! });

    const kbId = "kb-migration-suite-fixture";
    const expected = kbPartitionName(kbId);

    await provisionKbPartition({ kbId, dim: 256 });
    expect(await tableNames()).toContain(expected);

    // The column is typed to the KB's dimension, and it is in `search`.
    const column = await rows(
      sql`SELECT format_type(a.atttypid, a.atttypmod) AS type
            FROM pg_attribute a
            JOIN pg_class c ON c.oid = a.attrelid
            JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = ${SEARCH_SCHEMA}
             AND c.relname = ${expected}
             AND a.attname = 'embedding'`,
    );
    expect(column).toHaveLength(1);
    expect(String(column[0].type)).toBe("vector(256)");

    // HNSW over the vector, GIN over the generated tsvector, plus cluster_id
    // and kb_id — the four the query path depends on.
    const indexes = await rows(
      sql`SELECT indexname FROM pg_indexes WHERE schemaname = ${SEARCH_SCHEMA} AND tablename = ${expected} ORDER BY indexname`,
    );
    expect(indexes.map((r) => String(r.indexname))).toEqual([
      `${expected}_cluster`,
      `${expected}_hnsw`,
      `${expected}_kb`,
      `${expected}_pkey`,
      `${expected}_tsv`,
    ]);

    // Idempotent: provisioning again is a no-op, not a duplicate-table error.
    await provisionKbPartition({ kbId, dim: 256 });

    await dropKbPartition({ kbId });
    expect(await tableNames()).not.toContain(expected);

    // And dropping one that was never provisioned is a no-op too.
    await dropKbPartition({ kbId: "kb-never-provisioned" });
  });
});
