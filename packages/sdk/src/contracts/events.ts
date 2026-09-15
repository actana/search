/**
 * What Search tells a paired client about, and the two ways it tells them.
 *
 * One payload, two transports (ADR 0009). A **webhook** is a POST to a URL the
 * client registered, signed, retried, and written down in a delivery ledger —
 * it is what a server-side integration wants, because it survives the client
 * not being connected. **SSE** on `GET /v1/events` is the same payload pushed
 * down an open connection — it is what a UI wants, because it is live and it
 * needs no public URL. A client may have both, one, or neither.
 */

import { z } from "zod";
import { IsoDateTimeSchema } from "./common.ts";

/** Every event name. Closed, and a webhook registers a subset of it. */
export const SEARCH_EVENT_NAMES = [
  "document.ingested",
  "document.failed",
  "clusters.retrained",
] as const;

export const SearchEventNameSchema = z.enum(SEARCH_EVENT_NAMES);
export type SearchEventName = z.infer<typeof SearchEventNameSchema>;

/**
 * One event.
 *
 * `id` is deterministic — derived from what happened, not from when it was
 * noticed — so a redelivery after an ambiguous timeout is recognisably the same
 * event and the delivery ledger's `(webhook, event)` unique index does the
 * deduplication for the receiver.
 */
export const SearchEventSchema = z.object({
  id: z.string(),
  event: SearchEventNameSchema,
  occurredAt: IsoDateTimeSchema,
  kbId: z.string(),
  documentId: z.string().optional(),
  filename: z.string().optional(),
  chunkCount: z.number().int().optional(),
  error: z.string().optional(),
  /**
   * The machine-readable half of a `document.failed`, when there was a typed
   * failure behind it.
   *
   * `error` is the operator's sentence and must not be parsed; this is the
   * classification the worker already had in hand — `unknown-endpoint`,
   * `decrypt-failed`, `model-mismatch`, `resolver-error`, … (ADR 0010 D3) — and
   * it is what lets a client's handler tell "your resolver has forgotten this
   * endpoint" from "that PDF is a picture of a PDF" without reading prose.
   * Deliberately an open string rather than an enum: the reasons are Search's
   * own vocabulary and a client must not break when one is added. Absent for an
   * ordinary failure, and absent from the other two events.
   */
  reason: z.string().optional(),
});
export type SearchEvent = z.infer<typeof SearchEventSchema>;

/** The header carrying {@link SearchEventSchema.id} on a webhook POST. */
export const SEARCH_EVENT_ID_HEADER = "x-search-event-id";

/**
 * The header carrying the signature: `sha256=<hex>`, an HMAC-SHA256 over the
 * **raw request body** keyed by the webhook's secret. Over the raw bytes and
 * not over a re-serialisation, because a receiver that re-encodes the JSON
 * before checking is a receiver whose check passes on a body it did not see.
 */
export const SEARCH_SIGNATURE_HEADER = "x-search-signature";

/** The `sha256=` prefix, named so both sides spell it the same way. */
export const SEARCH_SIGNATURE_PREFIX = "sha256=";
