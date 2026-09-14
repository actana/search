/**
 * Test doubles the lifted suites reach for. Replaces Studio's
 * `@actana/testing`, trimmed to what the lifted tests actually import.
 *
 * Test-only: nothing in the production graph imports this file. It lives in
 * `shared` because the suites that use it are split across `search` and
 * `shared`, and a mock that only one of them can reach would be copied.
 */

import { vi } from 'vitest'

/** A logger whose every call is captured. */
export function createMockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(() => createMockLogger()),
    withMetadata: vi.fn(() => createMockLogger()),
  }
}

/**
 * Module mock for the logger.
 *
 * ```ts
 * vi.mock('@actana/search-shared/log', () => loggerMock)
 * ```
 */
export const loggerMock = {
  createLogger: vi.fn(() => createMockLogger()),
  logger: createMockLogger(),
}

/** The captured calls, for assertion. */
export function getLoggerCalls(logger: ReturnType<typeof createMockLogger>) {
  return {
    info: logger.info.mock.calls,
    warn: logger.warn.mock.calls,
    error: logger.error.mock.calls,
    debug: logger.debug.mock.calls,
  }
}

/**
 * Module mock for the configuration.
 *
 * ```ts
 * vi.mock('../config.ts', () => createEnvMock({ SEARCH_ENCRYPTION_KEY: 'a'.repeat(64) }))
 * ```
 */
export function createEnvMock(overrides: Record<string, unknown> = {}) {
  const values = {
    SEARCH_DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/search_test',
    SEARCH_REDIS_URL: 'redis://localhost:6379',
    SEARCH_S3_BUCKET: 'search',
    SEARCH_S3_REGION: 'us-east-1',
    SEARCH_S3_FORCE_PATH_STYLE: true,
    SEARCH_PORT: 7443,
    SEARCH_PUBLIC_HOST: 'localhost',
    SEARCH_LOG_LEVEL: 'silent',
    ...overrides,
  }
  return {
    config: () => values,
    resetConfig: () => {},
    databaseUrl: () => values.SEARCH_DATABASE_URL as string,
    env: values,
  }
}
