/**
 * Unit-test environment.
 *
 * Studio's suites ran with a `.env` loaded by Next, so `DATABASE_URL` was
 * always present and the lazy database proxy never complained at import time.
 * Search has no such file, and a unit test that merely *imports* a module which
 * declares `db` at module scope would otherwise fail on a missing variable it
 * never intended to use.
 *
 * So: a placeholder. It is deliberately not a reachable server — `postgres()`
 * opens no socket until a query is issued, so a unit test that does not touch
 * the database never notices, and one that accidentally does fails loudly on
 * connect rather than quietly writing to something real.
 *
 * `SEARCH_TEST_DATABASE_URL` is untouched. That is the variable the integration
 * suites gate on, and it must stay unset unless the developer set it.
 */

process.env.SEARCH_DATABASE_URL ??= 'postgresql://search:search@127.0.0.1:1/unit-tests-never-connect'
process.env.SEARCH_LOG_LEVEL ??= 'silent'
process.env.SEARCH_ENCRYPTION_KEY ??= '0'.repeat(64)
