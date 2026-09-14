/**
 * The partition is addressed by schema, always.
 *
 * This is a regression suite for a specific, silent failure. A per-KB partition
 * is named `kb_embedding_<sha256(kbId)[0..12]>`, and that hash is of the *KB
 * id* — so Studio and Search, running against the same database with the same
 * KB, name the same table. If any statement in the engine addresses it by bare
 * name, the connection's `search_path` decides which one it gets: `provisionKbPartition`
 * finds Studio's table and skips the CREATE, and every INSERT and SELECT after
 * it then reads and writes Studio's rows. Nothing errors. The corpus is simply
 * someone else's.
 *
 * So the suite plants a decoy: a table with exactly that name in `public`, with
 * a marker column, and then checks that provisioning still creates Search's own,
 * that the DDL's existence probe does not see the decoy, that the writes land in
 * `search`, and that dropping the partition leaves the decoy standing.
 *
 * Gated on `SEARCH_TEST_DATABASE_URL`.
 */

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetConfig } from "../config.ts";
import { createDatabase, type SearchDatabase } from "./../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { SEARCH_SCHEMA } from "../db/schema.ts";
import { dropKbPartition, provisionKbPartition } from "./ddl.ts";
import { kbPartitionName, kbPartitionRef, partitionExists } from "./partition.ts";

const url = process.env.SEARCH_TEST_DATABASE_URL;

if (url) {
  process.env.SEARCH_DATABASE_URL = url;
  resetConfig();
}

describe.skipIf(!url)("partition schema qualification", () => {
  let db: SearchDatabase;
  let close: () => Promise<void>;

  /** A KB id whose partition name the decoy will steal. */
  const kbId = "kb-schema-qualification-fixture";
  const table = kbPartitionName(kbId);

  const rows = async (query: ReturnType<typeof sql>): Promise<Array<Record<string, unknown>>> => {
    const result = (await db.execute(query)) as unknown;
    return Array.isArray(result)
      ? (result as Array<Record<string, unknown>>)
      : ((result as { rows?: Array<Record<string, unknown>> }).rows ?? []);
  };

  const inSchema = async (schema: string): Promise<boolean> => {
    const found = await rows(
      sql`SELECT 1 FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = ${schema} AND c.relname = ${table}`,
    );
    return found.length > 0;
  };

  beforeAll(async () => {
    const created = createDatabase(url!, { max: 1 });
    db = created.db;
    close = created.close;
    // Deliberately *not* dropping the `search` schema: vitest runs suites in
    // parallel and the fixture replay is working in the same database. This
    // suite owns exactly two things — one decoy table and one partition, both
    // named from a KB id no other suite uses — and cleans up only those.
    await db.execute(sql.raw(`DROP TABLE IF EXISTS "public"."${table}" CASCADE`));
    await runMigrations({ url: url! });

    // The decoy: Studio's partition, in `public`, under the same name. One
    // column, so anything written into it by mistake is unmistakable.
    await db.execute(
      sql.raw(`CREATE TABLE "public"."${table}" (id text PRIMARY KEY, belongs_to text)`),
    );
    await db.execute(
      sql.raw(`INSERT INTO "public"."${table}" (id, belongs_to) VALUES ('decoy', 'studio')`),
    );
  });

  afterAll(async () => {
    await db.execute(sql.raw(`DROP TABLE IF EXISTS "public"."${table}" CASCADE`));
    await dropKbPartition({ kbId });
    await close();
  });

  it("does not mistake a same-named public table for the partition", async () => {
    expect(await inSchema("public")).toBe(true);
    // The probe the ingest path gates provisioning on.
    expect(await partitionExists(kbId)).toBe(false);
  });

  it("provisions into search, writes into search, and leaves the decoy alone", async () => {
    await provisionKbPartition({ kbId, dim: 8 });

    expect(await inSchema(SEARCH_SCHEMA)).toBe(true);
    expect(await partitionExists(kbId)).toBe(true);

    // The decoy has no `embedding` column, so this insert could only succeed
    // against Search's own table.
    await db.execute(
      sql.raw(
        `INSERT INTO ${kbPartitionRef(kbId)} (id, kb_id, document_id, chunk_index, content, embedding)
         VALUES ('c1', '${kbId}', 'doc-1', 0, 'hello', '[1,0,0,0,0,0,0,0]')`,
      ),
    );

    const ours = await rows(sql.raw(`SELECT id FROM ${kbPartitionRef(kbId)}`));
    expect(ours.map((r) => String(r.id))).toEqual(["c1"]);

    // And the decoy is untouched — still one row, still Studio's.
    const theirs = await rows(sql.raw(`SELECT id, belongs_to FROM "public"."${table}"`));
    expect(theirs).toEqual([{ id: "decoy", belongs_to: "studio" }]);
  });

  it("drops only its own partition", async () => {
    await dropKbPartition({ kbId });

    expect(await inSchema(SEARCH_SCHEMA)).toBe(false);
    expect(await inSchema("public")).toBe(true);
    expect(await partitionExists(kbId)).toBe(false);
  });
});
