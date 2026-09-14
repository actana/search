/**
 * Apply the migrations.
 *
 * Run at boot as well as by hand: Search owns its schema (ADR 0002), so an
 * instance that starts against a database it has not migrated should migrate
 * it rather than fail in the first query. `drizzle-orm`'s migrator records what
 * it has applied, so running it twice is a no-op — which the integration suite
 * asserts rather than assumes.
 *
 * Two things happen before the migrator runs, and neither can be expressed as
 * a migration:
 *
 *   - `CREATE EXTENSION IF NOT EXISTS vector` — the `vector` type has to exist
 *     before the first migration that names it, and the extension is a
 *     database-level object, not a schema-level one.
 *   - `CREATE SCHEMA IF NOT EXISTS search` — drizzle's own migrations table
 *     lives in `search` too (`migrationsSchema`), so the schema must exist
 *     before the migrator can write its first row.
 *
 * One hand edit rides in `drizzle/0000_*.sql`: drizzle-kit emits a bare
 * `CREATE SCHEMA "search"` as its first statement, which fails against the
 * schema created above. It is `IF NOT EXISTS` in the committed file, and it has
 * to be re-applied on the one occasion the baseline is ever regenerated —
 * before the first release, while nothing has applied it yet. After that,
 * changes arrive as new files and 0000 is immutable like any other migration.
 */

import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { createLogger } from "@actana/search-shared/log";
import { createDatabase, type SearchDatabase } from "./client.ts";
import { SEARCH_SCHEMA } from "./schema.ts";

export { SEARCH_SCHEMA } from "./schema.ts";

const logger = createLogger("db/migrate");

/** `packages/search/drizzle` — the generated SQL, beside this source tree. */
export const MIGRATIONS_FOLDER = path.resolve(import.meta.dirname, "../../drizzle");

/** Drizzle's own bookkeeping table, kept inside Search's schema. */
export const MIGRATIONS_TABLE = "__drizzle_migrations";

export interface RunMigrationsOptions {
  /** A connection string. The migrator always opens its own connection. */
  url: string;
  migrationsFolder?: string;
}

/**
 * Create the extension and the schema, then apply every pending migration.
 *
 * It takes a connection string rather than an open handle, and that is not a
 * convenience — it is the correctness condition. The run is serialised with a
 * **session-level** advisory lock, and a session is a connection: hand this an
 * ordinary pooled handle and `pg_advisory_lock`, the migrations, and
 * `pg_advisory_unlock` can each land on a different connection, at which point
 * the lock guards nothing and the unlock returns false. So the migrator opens
 * one connection, keeps it for the whole run, and closes it.
 */
export async function runMigrations(options: RunMigrationsOptions): Promise<void> {
  const folder = options.migrationsFolder ?? MIGRATIONS_FOLDER;
  if (!options.url) {
    throw new Error("runMigrations: a database URL is required.");
  }

  const { db, close } = createDatabase(options.url, { max: 1 });
  try {
    await applyTo(db, folder);
  } finally {
    await close();
  }
}

/**
 * The advisory-lock key. Any constant works as long as it is the same in every
 * process; this one is `hashtext('actana-search-migrations')` frozen as a
 * literal so it cannot drift with a Postgres version.
 */
const MIGRATION_LOCK_KEY = 8_372_119_004_471_155_2n;

async function applyTo(db: SearchDatabase, migrationsFolder: string): Promise<void> {
  /**
   * One migrator at a time, across processes.
   *
   * Migrations run at every boot, so a deployment that starts three replicas
   * together starts three migrators together. Drizzle's migrator reads the
   * ledger, sees nothing applied, and runs the first migration — and so does
   * the second process, which then fails with `relation "document" already
   * exists`. The loser crashes on startup and the schema is left with tables
   * and an empty ledger, which is worse than the crash: the next boot tries to
   * create them again.
   *
   * `CREATE ... IF NOT EXISTS` is no defence. It is not atomic against a
   * concurrent creator: both see the object missing and both insert into the
   * system catalog, and the loser gets a duplicate-key violation on
   * `pg_namespace_nspname_index`. `kb/ddl.ts` guards the same race for the
   * per-KB partitions, and for the same reason.
   *
   * So everything below — the extension, the schema, and the migrations
   * themselves — runs under one session-level advisory lock. The second process
   * blocks, takes the lock once the first has committed its ledger rows, finds
   * nothing to do, and starts. The lock is released explicitly rather than left
   * to the connection closing, because the caller may be reusing a pooled
   * handle.
   */
  await db.execute(sql`SELECT pg_advisory_lock(${MIGRATION_LOCK_KEY})`);
  try {
    await db.execute(sql`CREATE EXTENSION IF NOT EXISTS vector`);
    await db.execute(sql.raw(`CREATE SCHEMA IF NOT EXISTS "${SEARCH_SCHEMA}"`));

    try {
      await migrate(db, {
        migrationsFolder,
        migrationsSchema: SEARCH_SCHEMA,
        migrationsTable: MIGRATIONS_TABLE,
      });
    } catch (err) {
      /**
       * `42P07` is duplicate_table: the migrator tried to create something that
       * is already there, which means the schema and the ledger disagree. The
       * raw error names one table and explains nothing, and the fix is not
       * obvious, so say both.
       *
       * It happens for one reason in practice — a database that applied an
       * earlier version of a migration file. Regenerating a baseline before the
       * first release does exactly that to any database that already had it.
       */
      if ((err as { code?: string })?.code === "42P07") {
        throw new Error(
          `The '${SEARCH_SCHEMA}' schema already has tables that the migrations are trying to create, ` +
            `which means its '${MIGRATIONS_TABLE}' ledger does not match the migration files. ` +
            `That happens when a database applied an earlier version of a migration that has since ` +
            `been regenerated. Drop the schema and let it rebuild, or reconcile the ledger by hand. ` +
            `Original error: ${(err as Error).message}`,
          { cause: err },
        );
      }
      throw err;
    }

    // Under the lock, and after the migrator: reading the ledger while another
    // migrator is halfway through it would compare a count against a moving
    // target and refuse a database that was perfectly fine a moment later.
    await assertNothingWasSkipped(db, migrationsFolder);
  } finally {
    await db.execute(sql`SELECT pg_advisory_unlock(${MIGRATION_LOCK_KEY})`);
  }
  logger.info("Migrations applied", { migrationsFolder });
}

/**
 * Refuse a database that came back from `migrate()` missing a migration.
 *
 * **Drizzle decides what to apply by timestamp, not by identity.** It records
 * one row per applied migration carrying that migration's `when` from
 * `meta/_journal.json`, and on the next run it applies only the entries whose
 * `when` is greater than the newest row's. It does not record which *file* a
 * row was, so a database migrated by a different checkout — a second clone of
 * this repository, a branch whose `0000` was regenerated with a later `when` —
 * leaves a row newer than a migration this checkout has not applied yet, and
 * that migration is then skipped **silently, for ever**. The first symptom is a
 * query failing on a column, several files away from the cause.
 *
 * That is not hypothetical: it is how a reviewer's clone and this one, sharing
 * one `search_test` database, spent an afternoon producing errors about
 * `cert_subject`.
 *
 * So: one row per journal entry, or say so. The count is exact — `migrate()`
 * inserts exactly one row per migration it runs — and the message names the fix
 * rather than the symptom, because the fix (drop the schema and migrate again)
 * is not one a reader deduces from "column does not exist".
 */
async function assertNothingWasSkipped(db: SearchDatabase, migrationsFolder: string): Promise<void> {
  const journalPath = path.join(migrationsFolder, "meta", "_journal.json");
  let expected: number;
  try {
    const journal = JSON.parse(await readFile(journalPath, "utf8")) as { entries?: unknown[] };
    expected = Array.isArray(journal.entries) ? journal.entries.length : 0;
  } catch {
    // No journal is not this function's problem — `migrate()` has already
    // thrown for it. Nothing to compare against, so nothing to report.
    return;
  }
  if (expected === 0) return;

  const rows = (await db.execute(
    sql.raw(`SELECT count(*)::int AS applied FROM "${SEARCH_SCHEMA}"."${MIGRATIONS_TABLE}"`),
  )) as unknown;
  const applied = Number(
    (Array.isArray(rows) ? rows[0] : (rows as { rows?: Array<{ applied?: unknown }> }).rows?.[0])
      ?.applied ?? 0,
  );
  if (applied >= expected) return;

  throw new Error(
    `${applied} of ${expected} migrations are recorded in "${SEARCH_SCHEMA}"."${MIGRATIONS_TABLE}", ` +
      "so at least one was skipped rather than applied. Drizzle applies a migration only when its " +
      "journal timestamp is newer than the newest recorded one, so this database was migrated by a " +
      "different checkout of this repository whose migration timestamps are newer than ours. Drop " +
      `the "${SEARCH_SCHEMA}" schema and migrate again, or point this instance at a database of its own.`,
  );
}
