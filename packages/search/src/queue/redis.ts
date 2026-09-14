/**
 * The Redis connection the queue runs on. Replaces Studio's
 * `lib/core/config/redis` and `@actana/queue`'s `connection.ts`.
 *
 * One lazily-created connection, shared by every queue: BullMQ opens its own
 * duplicates for blocking commands, so the process ends up with a handful
 * either way and a second pool on top of that buys nothing.
 */

import { Redis } from 'ioredis'
import { config } from '../config.ts'

let connection: Redis | undefined

export function getQueueConnection(): Redis {
  if (connection) return connection
  connection = new Redis(config().SEARCH_REDIS_URL, {
    // BullMQ requires this: a blocking command that gives up after 20 retries
    // is a job that silently stops being processed.
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  })
  return connection
}

export async function resetQueueConnection(): Promise<void> {
  if (!connection) return
  const open = connection
  connection = undefined
  await open.quit()
}

/**
 * Alias kept for the lifted KB ingestion lock, which reached Studio's
 * `lib/core/config/redis` under this name. Same connection.
 */
export const getRedisClient = getQueueConnection
