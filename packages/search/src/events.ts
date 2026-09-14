/**
 * What Search announces, in-process.
 *
 * Three events, and they are the ones ADR 0006 names as a paired client's whole
 * view of the work it started: `document.ingested`, `document.failed`,
 * `clusters.retrained`. The worker emits them; TASK-004's webhook delivery and
 * its `GET /v1/events` SSE stream subscribe to them.
 *
 * **This is a seam, not a bus.** It is a listener list and a `for` loop — no
 * Redis pub/sub, no ordering guarantee, no delivery guarantee, and deliberately
 * nothing that would make it look like one. Durable, retried delivery to a
 * client's URL is the webhook ledger's job (TASK-004); what this does is let
 * the worker say what happened without knowing who is listening or whether
 * anybody is.
 *
 * **Written here because the worker needs it and TASK-004 has not landed.** If
 * TASK-004's branch brings its own emitter, this file is the one to delete in
 * the rebase: keep that one's `emitSearchEvent`, point the worker at it, and
 * nothing else in TASK-005 moves. The shape is deliberately the smallest thing
 * both could agree on.
 *
 * **A listener never sees a key.** The payloads below are ids, counts and error
 * strings. An error string reaching here has already been through the worker's
 * redaction (`models/endpoint-key-errors.ts`), because a webhook is the one
 * place a leaked credential leaves the machine.
 */

import { createLogger } from '@actana/search-shared/log'

const logger = createLogger('events')

/** A document finished ingesting and is searchable. */
export interface DocumentIngestedEvent {
  type: 'document.ingested'
  pairedClientId: string | null
  knowledgeBaseId: string
  documentId: string
  chunkCount: number
  at: string
}

/** A document will not finish. `error` is the operator-facing reason. */
export interface DocumentFailedEvent {
  type: 'document.failed'
  pairedClientId: string | null
  knowledgeBaseId: string
  documentId: string
  error: string
  /** The machine-readable reason, when there was a typed one. */
  reason?: string
  at: string
}

/** A KB's clusters were refit. */
export interface ClustersRetrainedEvent {
  type: 'clusters.retrained'
  pairedClientId: string | null
  knowledgeBaseId: string
  clusterCount: number
  at: string
}

export type SearchEvent =
  | DocumentIngestedEvent
  | DocumentFailedEvent
  | ClustersRetrainedEvent

export type SearchEventListener = (event: SearchEvent) => void

const listeners = new Set<SearchEventListener>()

/** Subscribe. The returned function unsubscribes; call it or leak a listener. */
export function onSearchEvent(listener: SearchEventListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Drop every listener. Tests, and a process tearing down. */
export function clearSearchEventListeners(): void {
  listeners.clear()
}

/**
 * Announce.
 *
 * Synchronous and never throwing: a listener that fails is logged and the next
 * one still runs, because the alternative is one bad webhook subscriber turning
 * a completed document into a failed job.
 */
export function emitSearchEvent(event: SearchEvent): void {
  logger.debug('Search event', {
    type: event.type,
    knowledgeBaseId: event.knowledgeBaseId,
    ...('documentId' in event ? { documentId: event.documentId } : {}),
  })
  for (const listener of listeners) {
    try {
      listener(event)
    } catch (err) {
      logger.warn('A search-event listener threw; the event still reached the others', {
        type: event.type,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
}

/** `new Date().toISOString()`, so every emitter spells the timestamp once. */
export function eventTimestamp(): string {
  return new Date().toISOString()
}
