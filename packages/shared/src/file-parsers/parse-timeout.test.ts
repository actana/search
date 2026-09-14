/**
 * Tests for the throughput-based parse timeout (ticket 16, D3):
 * 10s per MB of input, 30s floor, 20 minute ceiling — the timeout kills the
 * parse promise, not the process.
 *
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'

import {
  computeParseTimeoutMs,
  MAX_PARSE_TIMEOUT_MS,
  MIN_PARSE_TIMEOUT_MS,
  PARSE_TIMEOUT_MS_PER_MB,
  withParseTimeout,
} from './index.ts'

const MB = 1024 * 1024

describe('computeParseTimeoutMs', () => {
  it('floors tiny inputs at the minimum budget', () => {
    expect(computeParseTimeoutMs(0)).toBe(MIN_PARSE_TIMEOUT_MS)
    expect(computeParseTimeoutMs(10)).toBe(MIN_PARSE_TIMEOUT_MS)
    expect(computeParseTimeoutMs(1 * MB)).toBe(MIN_PARSE_TIMEOUT_MS)
  })

  it('earns at least 10 seconds per MB of input', () => {
    expect(computeParseTimeoutMs(5 * MB)).toBe(5 * PARSE_TIMEOUT_MS_PER_MB)
    expect(computeParseTimeoutMs(50 * MB)).toBe(50 * PARSE_TIMEOUT_MS_PER_MB)
  })

  it('caps at the ~20 minute ceiling', () => {
    expect(computeParseTimeoutMs(500 * MB)).toBe(MAX_PARSE_TIMEOUT_MS)
    expect(computeParseTimeoutMs(Number.MAX_SAFE_INTEGER)).toBe(MAX_PARSE_TIMEOUT_MS)
  })

  it('treats missing or invalid sizes as empty input', () => {
    expect(computeParseTimeoutMs(undefined)).toBe(MIN_PARSE_TIMEOUT_MS)
    expect(computeParseTimeoutMs(null)).toBe(MIN_PARSE_TIMEOUT_MS)
    expect(computeParseTimeoutMs(Number.NaN)).toBe(MIN_PARSE_TIMEOUT_MS)
  })
})

describe('withParseTimeout', () => {
  it('resolves when the parse finishes within budget', async () => {
    await expect(withParseTimeout(Promise.resolve('parsed'), 1000, 'doc')).resolves.toBe('parsed')
  })

  it('rejects with a clean parse failure when the budget is exceeded', async () => {
    const hung = new Promise<never>(() => {})
    await expect(withParseTimeout(hung, 20, 'bomb.docx')).rejects.toThrow(
      'Parsing bomb.docx timed out after 20ms'
    )
  })

  it('propagates parser failures unchanged', async () => {
    await expect(
      withParseTimeout(Promise.reject(new Error('corrupt file')), 1000, 'doc')
    ).rejects.toThrow('corrupt file')
  })
})
