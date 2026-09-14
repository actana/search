/**
 * The database handle. Replaces Studio's `@actana/db`.
 *
 * Lazy behind a proxy, exactly as Studio's was, and for the same reason: every
 * lifted module imports `db` at module scope, and a module that is imported by
 * a test which never touches Postgres must not open a connection — or demand a
 * URL — just by being imported.
 */

import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { databaseUrl } from "../config.ts";
import * as schema from "./schema.ts";

export type SearchDatabase = PostgresJsDatabase<typeof schema>;

/**
 * A transaction handle or the database itself. The lifted DDL and ingest code
 * takes this where it may be running inside a caller's transaction.
 */
export type SearchExecutor = SearchDatabase | Parameters<Parameters<SearchDatabase["transaction"]>[0]>[0];

let instance: SearchDatabase | undefined;

/**
 * Open a connection pool. Exported because the migrator and the integration
 * suites need a handle they can close, which the ambient `db` deliberately
 * does not offer.
 */
export function createDatabase(url: string, options: { max?: number } = {}): {
  db: SearchDatabase;
  close: () => Promise<void>;
} {
  const sqlClient = postgres(url, {
    prepare: false,
    idle_timeout: 20,
    connect_timeout: 30,
    max: options.max ?? 10,
    onnotice: () => {},
  });
  return {
    db: drizzle(sqlClient, { schema }),
    close: () => sqlClient.end({ timeout: 5 }),
  };
}

/** The ambient handle every lifted module reaches for. */
export const db: SearchDatabase = new Proxy({} as SearchDatabase, {
  get(_target, prop, receiver) {
    if (!instance) {
      // The pool is deliberately not closable from here. A caller that needs
      // to end one — the migrator, an integration suite — uses
      // `createDatabase` and gets its own `close`.
      instance = createDatabase(databaseUrl()).db;
    }
    return Reflect.get(instance, prop, receiver);
  },
});

export * from "./schema.ts";
