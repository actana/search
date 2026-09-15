/**
 * When a delivery is tried again, and when it is given up on.
 *
 * Split out from the delivery itself so the policy can be tested as arithmetic
 * rather than by waiting eight seconds for a real backoff.
 */

/** Attempts, the first included. Five is the ledger's `attempts` ceiling. */
export const WEBHOOK_MAX_ATTEMPTS = 5;

/** The first retry's delay. Each later one doubles it. */
export const WEBHOOK_BASE_DELAY_MS = 500;

/** Nothing waits longer than this between attempts. */
export const WEBHOOK_MAX_DELAY_MS = 30_000;

/**
 * How long to wait before attempt `attempt` (1-based).
 *
 * Attempt 1 is immediate. After that it is exponential from
 * {@link WEBHOOK_BASE_DELAY_MS}, capped — 0, 500, 1000, 2000, 4000 for the five
 * attempts, which spends under eight seconds on a receiver that is down and
 * gets through a receiver that was restarting.
 */
export function webhookBackoffMs(attempt: number): number {
  if (attempt <= 1) return 0;
  const delay = WEBHOOK_BASE_DELAY_MS * 2 ** (attempt - 2);
  return Math.min(delay, WEBHOOK_MAX_DELAY_MS);
}

/**
 * Is this status worth trying again?
 *
 * A 2xx is done. A 4xx other than 408 and 429 is the receiver saying the
 * request itself is wrong, and sending it four more times will not change that
 * — so it is terminal, and the ledger records it as failed on the first
 * attempt. Everything else (5xx, a timeout, a connection refused, which arrives
 * here as `status: 0`) is retried.
 */
export function isRetryableStatus(status: number): boolean {
  if (status >= 200 && status < 300) return false;
  if (status === 408 || status === 429) return true;
  if (status >= 400 && status < 500) return false;
  return true;
}

/** Should another attempt be made after this one? */
export function shouldRetry(attempt: number, status: number): boolean {
  return attempt < WEBHOOK_MAX_ATTEMPTS && isRetryableStatus(status);
}
