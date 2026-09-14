import { createHash } from 'node:crypto'
import { db } from '../db/client.ts'
import { sql } from 'drizzle-orm'
import { SEARCH_SCHEMA, qualified } from '../db/schema.ts'

/**
 * Minimal transaction-like surface accepted for `tx` parameters.
 *
 * Both the top-level `db` client and drizzle transaction objects expose
 * `.execute(...)`. Defined here to avoid a hard dependency on the drizzle
 * transaction type which is internal and parameterised by schema.
 */
export interface KbPartitionExecutor {
  execute: (query: ReturnType<typeof sql>) => Promise<unknown>
}

/**
 * Deterministic SQL-safe table name for a KB's per-KB embedding partition.
 *
 * Owned by Chunk C (KB v2 ingest/query). This stub lives here so Chunk B's
 * `lib/kb/ddl.ts::provisionKbPartition` and Chunk E's cluster-summary SQL can
 * import a stable shape while C hardens the rest of the helper surface.
 *
 * The name is `kb_embedding_<sha256(kbId)[0..12]>` — 12 hex chars of sha256.
 * Dimension is intentionally NOT in the name; it is fixed by the column type
 * at provision time.
 *
 * Never interpolate `kbId` directly into SQL. Always pass it through this
 * helper.
 */
export function kbPartitionName(kbId: string): string {
  const digest = createHash('sha256').update(kbId).digest('hex')
  return `kb_embedding_${digest.slice(0, 12)}`
}

/**
 * The partition's fully-qualified, quoted identifier — `"search"."kb_embedding_…"`
 * — ready to drop into `sql.raw`.
 *
 * lifted: new, and every raw statement that names a partition goes through it.
 * Studio's raw SQL named the table bare and got the default schema; Search owns
 * `search` (ADR 0002) and the tables are there, so a bare name is not merely
 * unqualified — on a database shared with Studio it resolves to *Studio's*
 * `public.kb_embedding_<sha>`, which has the same name because the hash is of
 * the same KB id. `provisionKbPartition` would then find a table and skip the
 * CREATE, and every INSERT and SELECT after it would read and write Studio's
 * rows. Setting `search_path` on the connection looked like it solved this and
 * did not: it is the same silent-wrong-table failure one `SET` away, and a
 * transaction-pooled PgBouncer drops the setting between statements.
 *
 * Qualify explicitly. There is no configuration that can make this wrong.
 */
export function kbPartitionRef(kbId: string): string {
  return qualified(kbPartitionName(kbId))
}

/**
 * Probe Postgres for the existence of the per-KB partition table.
 *
 * Uses `to_regclass('search.<table>')` which returns NULL when the table is
 * absent. Always safe to call before query/ingest.
 *
 * lifted: the schema was `public.`. It is `search.` and it is never omitted —
 * see {@link kbPartitionRef} for what an unqualified probe costs on a database
 * Search shares with Studio.
 */
export async function partitionExists(kbId: string, tx?: KbPartitionExecutor): Promise<boolean> {
  const executor = tx ?? db
  const tableName = `${SEARCH_SCHEMA}.${kbPartitionName(kbId)}`
  const result = (await executor.execute(sql`SELECT to_regclass(${tableName}) AS exists`)) as
    | { rows?: Array<{ exists: string | null }> }
    | Array<{ exists: string | null }>
  const rows = Array.isArray(result) ? result : Array.isArray(result?.rows) ? result.rows : []
  const first = rows[0]
  return Boolean(first && first.exists)
}
