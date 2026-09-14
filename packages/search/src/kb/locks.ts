/**
 * Per-KB ingestion mutex.
 *
 * The KB ingestion pipeline (chunk → embed → cluster → keyword) is
 * resource-heavy and the keyword-extraction prompt benefits from seeing
 * earlier files' KB keywords. To enforce both, every document worker
 * acquires this lock for its `kbId` before processing and releases it on
 * exit. Different KBs run in parallel; same-KB docs run strictly serial.
 *
 * The lock is a Redis `SET NX PX` token with a renewable TTL. When the
 * lock is taken the caller can wait (poll with backoff) or throw a
 * retry-able error so the queue redelivers the job.
 */

import { createLogger } from '@actana/search-shared/log'
import { getRedisClient } from '../queue/redis.ts'
import { generateShortId } from '@actana/search-shared/short-id'

const logger = createLogger('kb/locks')

/** Default TTL (ms). Refresh via {@link extendKbIngestLock} before expiry. */
const DEFAULT_LOCK_TTL_MS = 5 * 60 * 1000
/** Default polling cadence (ms) for {@link acquireKbIngestLock}. */
const DEFAULT_POLL_MS = 1000
/** Default max wait (ms) for {@link acquireKbIngestLock} before giving up. */
const DEFAULT_MAX_WAIT_MS = 60 * 60 * 1000

/** Returns the canonical Redis key for a KB's ingestion lock. */
export function kbIngestLockKey(kbId: string): string {
  return `kb:${kbId}:ingest-lock`
}

/** Handle returned from {@link acquireKbIngestLock}; pass to release/extend. */
export interface KbIngestLockHandle {
  kbId: string
  token: string
}

/**
 * Acquire the per-KB ingestion lock. Polls until the lock is free or
 * `maxWaitMs` elapses; returns `null` on timeout. Different KBs never
 * block each other; same-KB callers queue up here.
 */
export async function acquireKbIngestLock(
  kbId: string,
  opts?: { ttlMs?: number; pollMs?: number; maxWaitMs?: number }
): Promise<KbIngestLockHandle | null> {
  const redis = getRedisClient()
  if (!redis) {
    /** Without Redis we can't enforce cross-process serialisation; let the
     *  caller proceed so dev environments without Redis don't deadlock. */
    logger.warn('acquireKbIngestLock: Redis unavailable; proceeding without lock', { kbId })
    return { kbId, token: 'no-redis' }
  }

  const ttlMs = opts?.ttlMs ?? DEFAULT_LOCK_TTL_MS
  const pollMs = opts?.pollMs ?? DEFAULT_POLL_MS
  const maxWaitMs = opts?.maxWaitMs ?? DEFAULT_MAX_WAIT_MS
  const key = kbIngestLockKey(kbId)
  const token = generateShortId()
  const start = Date.now()

  while (true) {
    const set = await redis.set(key, token, 'PX', ttlMs, 'NX')
    if (set === 'OK') {
      return { kbId, token }
    }
    if (Date.now() - start >= maxWaitMs) {
      logger.warn('acquireKbIngestLock: max wait elapsed', { kbId, maxWaitMs })
      return null
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
}

/** Lua script for atomic compare-and-delete. */
const RELEASE_SCRIPT = `
  if redis.call("GET", KEYS[1]) == ARGV[1] then
    return redis.call("DEL", KEYS[1])
  else
    return 0
  end
`

/**
 * Release the lock if and only if `handle.token` still owns it. A
 * mismatched token means our TTL expired and another worker has taken
 * over; in that case we do nothing.
 */
export async function releaseKbIngestLock(handle: KbIngestLockHandle): Promise<void> {
  if (handle.token === 'no-redis') return
  const redis = getRedisClient()
  if (!redis) return
  try {
    await redis.eval(RELEASE_SCRIPT, 1, kbIngestLockKey(handle.kbId), handle.token)
  } catch (err) {
    logger.warn('releaseKbIngestLock: eval failed', {
      kbId: handle.kbId,
      err: err instanceof Error ? err.message : String(err),
    })
  }
}

/** Lua script for atomic compare-and-pexpire. */
const EXTEND_SCRIPT = `
  if redis.call("GET", KEYS[1]) == ARGV[1] then
    return redis.call("PEXPIRE", KEYS[1], ARGV[2])
  else
    return 0
  end
`

/**
 * Refresh the lock's TTL while we still own it. Long-running jobs should
 * call this periodically (e.g. once per chunk batch) so the lock doesn't
 * time out mid-flight.
 */
export async function extendKbIngestLock(
  handle: KbIngestLockHandle,
  ttlMs: number = DEFAULT_LOCK_TTL_MS
): Promise<boolean> {
  if (handle.token === 'no-redis') return true
  const redis = getRedisClient()
  if (!redis) return false
  try {
    const result = await redis.eval(
      EXTEND_SCRIPT,
      1,
      kbIngestLockKey(handle.kbId),
      handle.token,
      String(ttlMs)
    )
    return result === 1
  } catch (err) {
    logger.warn('extendKbIngestLock: eval failed', {
      kbId: handle.kbId,
      err: err instanceof Error ? err.message : String(err),
    })
    return false
  }
}

/**
 * Convenience wrapper: run `fn` while holding the KB's ingest lock.
 * Releases the lock in `finally`. Returns the result of `fn`. When the
 * lock cannot be acquired within `maxWaitMs`, throws so the queue can
 * redeliver the job.
 */
export async function withKbIngestLock<T>(
  kbId: string,
  fn: () => Promise<T>,
  opts?: { ttlMs?: number; pollMs?: number; maxWaitMs?: number }
): Promise<T> {
  const handle = await acquireKbIngestLock(kbId, opts)
  if (!handle) {
    throw new Error(`kb-ingest-lock: failed to acquire lock for kb ${kbId} within wait budget`)
  }
  try {
    return await fn()
  } finally {
    await releaseKbIngestLock(handle)
  }
}

/** TTL for the clustering-active flag — long enough to span a full re-fit. */
const CLUSTERING_ACTIVE_TTL_MS = 30 * 60 * 1000

/** Returns the Redis key used for the clustering-active flag. */
export function kbClusteringActiveKey(kbId: string): string {
  return `kb:${kbId}:clustering-active`
}

/**
 * Mark the KB as actively clustering. The flag is TTL-protected so a
 * crashed worker can't leave the banner stuck on forever; long jobs
 * should re-call this periodically to refresh.
 */
export async function markKbClusteringActive(kbId: string): Promise<void> {
  const redis = getRedisClient()
  if (!redis) return
  try {
    await redis.set(kbClusteringActiveKey(kbId), '1', 'PX', CLUSTERING_ACTIVE_TTL_MS)
  } catch (err) {
    logger.warn('markKbClusteringActive: set failed', {
      kbId,
      err: err instanceof Error ? err.message : String(err),
    })
  }
}

/** Clear the clustering-active flag once the job completes. */
export async function clearKbClusteringActive(kbId: string): Promise<void> {
  const redis = getRedisClient()
  if (!redis) return
  try {
    await redis.del(kbClusteringActiveKey(kbId))
  } catch (err) {
    logger.warn('clearKbClusteringActive: del failed', {
      kbId,
      err: err instanceof Error ? err.message : String(err),
    })
  }
}

/**
 * Read the clustering-active flag. Returns `false` when Redis is
 * unavailable so the UI never gets stuck on a phantom "clustering"
 * banner.
 */
export async function isKbClusteringActive(kbId: string): Promise<boolean> {
  const redis = getRedisClient()
  if (!redis) return false
  try {
    const value = await redis.get(kbClusteringActiveKey(kbId))
    return value !== null
  } catch (err) {
    logger.warn('isKbClusteringActive: get failed', {
      kbId,
      err: err instanceof Error ? err.message : String(err),
    })
    return false
  }
}
