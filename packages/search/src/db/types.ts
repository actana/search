/**
 * Database handle types. Replaces Studio's `@/lib/db/types`.
 *
 * `DbOrTx` is the surface a function takes when it may run standalone or inside
 * a caller's transaction. Drizzle's transaction type is internal and
 * parameterised by schema, so it is derived from the database type rather than
 * imported.
 */

import type { SearchDatabase } from './client.ts'

export type SearchTransaction = Parameters<Parameters<SearchDatabase['transaction']>[0]>[0]

/** The database, or a transaction on it. */
export type DbOrTx = SearchDatabase | SearchTransaction
