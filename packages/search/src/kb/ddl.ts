/**
 * Per-KB vector partition DDL.
 *
 * Called from `knowledge/service.ts::createKnowledgeBase` AFTER the parent
 * `knowledge_base` row is inserted (and inside the surrounding transaction
 * where possible). The reverse path (`dropKbPartition`) is invoked from the
 * KB delete flow.
 *
 * Partition tables are NOT tracked by Drizzle migrations — they are created at
 * runtime by `provisionKbPartition` and dropped by `dropKbPartition`. They
 * MUST NOT appear in `src/db/schema.ts`; adding them would cause
 * `drizzle-kit generate` to emit DROP statements for live data.
 *
 * lifted: every statement that names the table names it `"search"."<table>"`,
 * through {@link kbPartitionRef}. Studio named it bare and got the default
 * schema; a bare name here would resolve to Studio's identically-named
 * partition on a shared database. The SQL is otherwise byte-identical — the only
 * token that changed is the identifier.
 *
 * The KB v2 re-ingest tool (B4 follow-up) must call `provisionKbPartition` to
 * bring up a partition for a legacy KB before re-ingesting documents into it.
 */

import { db } from '../db/client.ts'
import { createLogger } from '@actana/search-shared/log'
import { sql } from 'drizzle-orm'
import { SEARCH_SCHEMA } from '../db/schema.ts'
import { type KbPartitionExecutor, kbPartitionName, kbPartitionRef } from './partition.ts'

const logger = createLogger('kb/ddl')

/** Catalog upper bound — matches `vector(n)` cap supported by pgvector. */
const MAX_VECTOR_DIM = 4096
/** v1 language whitelist for `to_tsvector(...)` (plan open-Q #5). */
const ALLOWED_LANGUAGES = ['english', 'simple'] as const

export interface ProvisionKbPartitionArgs {
  kbId: string
  dim: number
  language?: string
  /**
   * Drizzle transaction handle. Pass when calling from inside an active
   * transaction — DDL runs on that connection inside a SAVEPOINT so a failure
   * does not abort the outer tx. Omit to run standalone (no SAVEPOINT).
   */
  tx?: KbPartitionExecutor
}

export interface ProvisionKbPartitionResult {
  tableName: string
}

/**
 * Provision a per-KB vector partition table with HNSW + GIN + cluster_id + kb_id
 * indexes. Idempotent: repeated calls with the same `kbId` are no-ops via
 * `IF NOT EXISTS`.
 *
 * Inputs are validated BEFORE any SQL runs:
 * - `dim` must be an integer in [1, 4096].
 * - `language` must be in {'english', 'simple'} (v1).
 * - `kbId` is fed through `kbPartitionName` (sha256) — never inlined.
 */
export async function provisionKbPartition(
  args: ProvisionKbPartitionArgs
): Promise<ProvisionKbPartitionResult> {
  const { kbId, dim, tx } = args
  const language = args.language ?? 'english'

  if (!Number.isInteger(dim) || dim < 1 || dim > MAX_VECTOR_DIM) {
    throw new Error(
      `provisionKbPartition: invalid dim ${dim} (must be integer in [1, ${MAX_VECTOR_DIM}])`
    )
  }
  if (!(ALLOWED_LANGUAGES as readonly string[]).includes(language)) {
    throw new Error(
      `provisionKbPartition: invalid language '${language}' (allowed: ${ALLOWED_LANGUAGES.join(', ')})`
    )
  }

  const tableName = kbPartitionName(kbId)
  logger.info('Provisioning KB partition', { kbId, tableName, dim, language })

  const executor: KbPartitionExecutor = tx ?? db
  // lifted: was `sql.raw(`"${tableName}"`)` — the bare name. Qualified now;
  // see `kbPartitionRef`. The index names below stay bare on purpose: Postgres
  // creates an index in its table's schema and rejects a qualified name there.
  const tableIdent = sql.raw(kbPartitionRef(kbId))
  const dimLit = sql.raw(String(dim))
  const langLit = sql.raw(`'${language}'`)

  /**
   * Race guard: when several documents are uploaded into a fresh KB at the
   * same time, each ingest tx sees `partitionExists === false` and tries to
   * CREATE TABLE concurrently. `CREATE TABLE IF NOT EXISTS` is NOT safe
   * under concurrency in Postgres — two callers can collide on the system
   * catalog unique indexes (pg_class_relname_nsp_index, pg_type_*) and the
   * loser errors with a duplicate-key violation.
   *
   * We hold a `pg_advisory_xact_lock` keyed by the partition table name
   * for the rest of the transaction. The first uploader wins the lock,
   * runs the CREATE, and commits; the others block here, then re-check
   * existence under the lock and skip the CREATE entirely. The lock
   * releases at tx commit, so there's nothing to unlock manually.
   */
  if (tx) {
    await executor.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${tableName}))`)

    const existsRes = (await executor.execute(
      // lifted: was `public.${tableName}`. See the note in `partition.ts`.
      sql`SELECT to_regclass(${`${SEARCH_SCHEMA}.${tableName}`}) AS exists`
    )) as { rows?: Array<{ exists: string | null }> } | Array<{ exists: string | null }>
    const existsRows = Array.isArray(existsRes) ? existsRes : (existsRes.rows ?? [])
    if (existsRows[0]?.exists) {
      logger.info('Provisioning KB partition: already exists, skipping DDL', {
        kbId,
        tableName,
      })
      return { tableName }
    }
  }

  const runDdl = async () => {
    await executor.execute(sql`
      CREATE TABLE IF NOT EXISTS ${tableIdent} (
        id          text PRIMARY KEY,
        kb_id       text NOT NULL,
        document_id text NOT NULL,
        chunk_index integer NOT NULL,
        content     text NOT NULL,
        content_tsv tsvector GENERATED ALWAYS AS (to_tsvector(${langLit}, content)) STORED,
        cluster_id  integer,
        metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
        embedding   vector(${dimLit}) NOT NULL,
        created_at  timestamptz NOT NULL DEFAULT now()
      )
    `)
    await executor.execute(sql`
      CREATE INDEX IF NOT EXISTS ${sql.raw(`"${tableName}_hnsw"`)}
        ON ${tableIdent} USING hnsw (embedding vector_cosine_ops)
    `)
    await executor.execute(sql`
      CREATE INDEX IF NOT EXISTS ${sql.raw(`"${tableName}_tsv"`)}
        ON ${tableIdent} USING gin (content_tsv)
    `)
    await executor.execute(sql`
      CREATE INDEX IF NOT EXISTS ${sql.raw(`"${tableName}_cluster"`)}
        ON ${tableIdent} (cluster_id)
    `)
    await executor.execute(sql`
      CREATE INDEX IF NOT EXISTS ${sql.raw(`"${tableName}_kb"`)}
        ON ${tableIdent} (kb_id)
    `)
  }

  if (!tx) {
    await runDdl()
    return { tableName }
  }

  await executor.execute(sql`SAVEPOINT kb_provision`)
  try {
    await runDdl()
    await executor.execute(sql`RELEASE SAVEPOINT kb_provision`)
  } catch (err) {
    logger.error('provisionKbPartition failed; rolling back to savepoint', {
      kbId,
      tableName,
      error: err instanceof Error ? err.message : String(err),
    })
    await executor.execute(sql`ROLLBACK TO SAVEPOINT kb_provision`)
    throw err
  }

  return { tableName }
}

export interface DropKbPartitionArgs {
  kbId: string
  /**
   * Drizzle transaction handle. Pass when calling from inside an active
   * transaction — DROP runs on that connection inside a SAVEPOINT so a failure
   * does not abort the outer tx. Omit to run standalone (no SAVEPOINT).
   */
  tx?: KbPartitionExecutor
}

/**
 * Drop a per-KB partition. Idempotent — silently no-ops if the partition was
 * never provisioned. No DB-level FKs target the partition, so CASCADE is
 * cosmetic but kept for safety.
 */
export async function dropKbPartition(args: DropKbPartitionArgs): Promise<void> {
  const { kbId, tx } = args
  const tableName = kbPartitionName(kbId)
  logger.info('Dropping KB partition', { kbId, tableName })

  const executor: KbPartitionExecutor = tx ?? db
  // lifted: was the bare name. See `kbPartitionRef`.
  const dropStmt = sql`DROP TABLE IF EXISTS ${sql.raw(kbPartitionRef(kbId))} CASCADE`

  if (!tx) {
    await executor.execute(dropStmt)
    return
  }

  await executor.execute(sql`SAVEPOINT kb_drop`)
  try {
    await executor.execute(dropStmt)
    await executor.execute(sql`RELEASE SAVEPOINT kb_drop`)
  } catch (err) {
    logger.error('dropKbPartition failed; rolling back to savepoint', {
      kbId,
      tableName,
      error: err instanceof Error ? err.message : String(err),
    })
    await executor.execute(sql`ROLLBACK TO SAVEPOINT kb_drop`)
    throw err
  }
}
