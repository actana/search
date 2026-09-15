/**
 * The authenticated surface's rate limit: per paired client, on the query
 * route.
 *
 * **Reused rather than rewritten.** `PairingRateLimiter` is a fixed-window
 * counter with a bounded key map and no timers, copied into this repo from
 * Control for the pre-auth endpoint (ADR 0008). The only thing that changes
 * here is what the key means — a paired client's id instead of a socket
 * address — and the numbers. A second implementation of the same arithmetic
 * would be a second place for the eviction bug that module's header describes
 * to come back.
 *
 * **Why the query route and not everything.** A query is the one route a caller
 * can issue in a loop at no cost to itself and real cost to the instance: an
 * embedding call, an ANN scan over a partition, a re-rank. The writes are
 * bounded by the work they enqueue and the reads are bounded by Postgres. So
 * this is a limit on the expensive path, not a general throttle — and the
 * limits are set where an honest caller (a UI typing ahead, an agent running a
 * few searches per turn) will never meet them.
 *
 * Per process, like the pairing one. Two instances behind one address each
 * allow the full limit; the real ceiling is the limit times the process count,
 * and a shared counter is a Redis round trip on the hot path for a bound that
 * is about noise rather than about correctness.
 */

import { createLogger } from "@actana/search-shared/log";
import {
  PairingRateLimiter,
  type RateLimitWindow,
} from "../pairing/pairing-rate-limit.ts";
import { HttpError } from "./http.ts";

const logger = createLogger("api/rate-limit");

/**
 * Six hundred queries a minute from one paired client — ten a second,
 * sustained.
 *
 * A search-as-you-type UI sends a handful per keystroke burst and an agent a
 * few per turn. Ten a second is far above either and far below what a loop
 * costs.
 */
export const DEFAULT_QUERY_CLIENT_WINDOW: RateLimitWindow = { limit: 600, windowMs: 60_000 };

/** Six thousand a minute across every client — the "one instance" backstop. */
export const DEFAULT_QUERY_GLOBAL_WINDOW: RateLimitWindow = { limit: 6_000, windowMs: 60_000 };

let limiter: PairingRateLimiter | undefined;

/** The process's query limiter. Lazy so importing this opens nothing. */
export function queryRateLimiter(): PairingRateLimiter {
  limiter ??= new PairingRateLimiter({
    peer: DEFAULT_QUERY_CLIENT_WINDOW,
    global: DEFAULT_QUERY_GLOBAL_WINDOW,
  });
  return limiter;
}

/** Replace the limiter. For a test that does not want to send six hundred queries. */
export function setQueryRateLimiter(replacement: PairingRateLimiter | undefined): void {
  limiter = replacement;
}

/**
 * Take one query for this client, or refuse with `429`.
 *
 * `Retry-After` is in seconds, rounded up, because that is what the header
 * means; `detail.retryAfterMs` is the precise figure for a client that would
 * rather back off exactly.
 */
export function chargeQuery(pairedClientId: string): void {
  const verdict = queryRateLimiter().check(pairedClientId);
  if (verdict.ok) return;
  logger.warn("Query rate limit", { pairedClientId, scope: verdict.scope });
  throw new HttpError(
    429,
    "rate-limited",
    verdict.scope === "peer"
      ? "this client has sent too many queries; try again shortly"
      : "this instance is answering too many queries; try again shortly",
    { scope: verdict.scope, retryAfterMs: verdict.retryAfterMs },
    { "retry-after": String(Math.ceil(verdict.retryAfterMs / 1000)) },
  );
}
