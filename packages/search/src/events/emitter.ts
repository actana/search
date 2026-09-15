/**
 * The in-process fan-out that `GET /v1/events` reads from.
 *
 * **Per paired client, and nothing global.** A subscriber names the client it
 * is, and it is handed that client's events and no others — an SSE stream is an
 * authenticated connection and the events on it have to be scoped the same way
 * every other route is (ADR 0003).
 *
 * In-process, deliberately. A second instance of Search does not see this one's
 * events on its own streams, and that is the honest limit of an SSE endpoint
 * without a broker: a UI is connected to one instance. The durable path is the
 * webhook, which goes through the database and is the one to reach for when the
 * delivery has to survive.
 */

import { createLogger } from "@actana/search-shared/log";
import type { SearchEvent } from "@actana/search/contracts";

const logger = createLogger("events/emitter");

export type SearchEventListener = (event: SearchEvent) => void;

/** `paired_client_id` → its open streams. */
const listeners = new Map<string, Set<SearchEventListener>>();

/**
 * Listen for one client's events. Returns the unsubscribe, which the SSE route
 * calls from the connection's `close` — a listener that outlives its socket is
 * a leak that looks like a working feature.
 *
 * Named `onSearchEvent` to match the worker side's listener (TASK-005's
 * `src/events.ts`), so the two halves of the fan-out are one vocabulary once
 * the branches meet.
 */
export function onSearchEvent(
  pairedClientId: string,
  listener: SearchEventListener,
): () => void {
  let set = listeners.get(pairedClientId);
  if (!set) {
    set = new Set();
    listeners.set(pairedClientId, set);
  }
  set.add(listener);
  return () => {
    const current = listeners.get(pairedClientId);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) listeners.delete(pairedClientId);
  };
}

/**
 * Hand an event to every stream this client has open.
 *
 * A listener that throws is logged and skipped rather than allowed to take the
 * publish down: one broken stream must not stop the webhook beside it.
 */
export function emitSearchEvent(pairedClientId: string, event: SearchEvent): void {
  const set = listeners.get(pairedClientId);
  if (!set || set.size === 0) return;
  for (const listener of set) {
    try {
      listener(event);
    } catch (err) {
      logger.warn("An events listener threw", {
        pairedClientId,
        event: event.event,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/** How many streams this client has open. For the tests and for a health line. */
export function openEventStreams(pairedClientId: string): number {
  return listeners.get(pairedClientId)?.size ?? 0;
}

/** Drop every subscription. A test's `afterEach`, and a shutdown. */
export function resetSearchEventListeners(): void {
  listeners.clear();
}
