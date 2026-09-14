/**
 * Delivering an event to the URL a paired client registered.
 *
 * Four properties, and each one is a thing that goes wrong without it:
 *
 *   - **Signed.** `x-search-signature: sha256=<hex>` over the raw body, so the
 *     receiver can tell a delivery from a POST anybody could have made.
 *   - **Through the SSRF guard.** The URL is a string a client handed over, and
 *     "POST to whatever URL you were given, from inside the deployment's
 *     network" is the entire SSRF class. `secureFetch` validates the protocol,
 *     the port and the resolved address, then connects to *that address*.
 *   - **Retried, with a ledger.** Five attempts on a retryable answer, and one
 *     `webhook_delivery` row per event whose state says how it went. The row's
 *     `(webhook, event)` unique index is also what makes a redelivery after an
 *     ambiguous timeout idempotent.
 *   - **Never fatal to the caller.** A delivery failure is recorded, not
 *     thrown: an ingestion that finished is an ingestion that finished, whether
 *     or not somebody's endpoint was up to hear about it.
 */

import { and, desc, eq } from "drizzle-orm";
import { createLogger } from "@actana/search-shared/log";
import { generateId } from "@actana/search-shared/short-id";
import type { SearchEvent } from "@actana/search/contracts";
import { SEARCH_EVENT_ID_HEADER, SEARCH_SIGNATURE_HEADER } from "@actana/search/contracts";
import { db } from "../db/client.ts";
import { webhook, webhookDelivery } from "../db/schema.ts";
import { decryptSecret } from "../core/security/encryption.ts";
import { secureFetch } from "../core/security/url-guard.ts";
import { signWebhookBody } from "./webhook-signature.ts";
import { shouldRetry, webhookBackoffMs, WEBHOOK_MAX_ATTEMPTS } from "./webhook-retry.ts";

const logger = createLogger("events/webhooks");

/** How long one attempt may take before it is abandoned. */
const DELIVERY_TIMEOUT_MS = 10_000;

/** `setTimeout` as a promise. One line, and not worth a dependency. */
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export type WebhookRow = typeof webhook.$inferSelect;

/** The hook this client registered, or `null`. */
export async function webhookForClient(pairedClientId: string): Promise<WebhookRow | null> {
  const [row] = await db
    .select()
    .from(webhook)
    .where(eq(webhook.pairedClientId, pairedClientId))
    .orderBy(desc(webhook.createdAt))
    .limit(1);
  return row ?? null;
}

/** The last few attempts against this hook, newest first. For an operator. */
export async function recentDeliveries(
  webhookId: string,
  limit = 10,
): Promise<Array<typeof webhookDelivery.$inferSelect>> {
  return db
    .select()
    .from(webhookDelivery)
    .where(eq(webhookDelivery.webhookId, webhookId))
    .orderBy(desc(webhookDelivery.createdAt))
    .limit(limit);
}

export type DeliveryOutcome =
  | { delivered: true; attempts: number; status: number }
  | { delivered: false; attempts: number; status: number; error: string }
  | { delivered: false; skipped: "no-webhook" | "not-subscribed" | "already-recorded" };

/**
 * Deliver one event to this client's hook, if it has one that wants it.
 *
 * Returns what happened rather than throwing, because every caller is a
 * finished job that has nothing useful to do with a failure but log it.
 */
export async function deliverSearchEvent(
  pairedClientId: string,
  event: SearchEvent,
): Promise<DeliveryOutcome> {
  const hook = await webhookForClient(pairedClientId);
  if (!hook) return { delivered: false, skipped: "no-webhook" };

  const subscribed = Array.isArray(hook.events) ? (hook.events as string[]) : [];
  if (!subscribed.includes(event.event)) {
    return { delivered: false, skipped: "not-subscribed" };
  }

  /**
   * Claim the event before sending it. The unique index on
   * `(webhook_id, event_id)` means a second worker holding the same event
   * inserts nothing and returns here — one POST per event per hook, which is
   * what makes a retry after a timeout a redelivery rather than a duplicate.
   */
  const ledgerId = generateId();
  const claimed = await db
    .insert(webhookDelivery)
    .values({
      id: ledgerId,
      webhookId: hook.id,
      eventId: event.id,
      status: "pending",
      attempts: 0,
      createdAt: new Date(),
    })
    .onConflictDoNothing()
    .returning({ id: webhookDelivery.id });
  if (claimed.length === 0) return { delivered: false, skipped: "already-recorded" };

  const secret = await decryptSecret(hook.secretCiphertext).then((r) => r.decrypted);
  const body = JSON.stringify(event);
  const signature = signWebhookBody(secret, body);

  let lastStatus = 0;
  let lastError = "";
  for (let attempt = 1; attempt <= WEBHOOK_MAX_ATTEMPTS; attempt++) {
    const wait = webhookBackoffMs(attempt);
    if (wait > 0) await sleep(wait);

    await db
      .update(webhookDelivery)
      .set({ attempts: attempt, status: "pending" })
      .where(eq(webhookDelivery.id, ledgerId));

    try {
      const response = await secureFetch(
        hook.url,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [SEARCH_EVENT_ID_HEADER]: event.id,
            [SEARCH_SIGNATURE_HEADER]: signature,
          },
          body,
          timeout: DELIVERY_TIMEOUT_MS,
          maxResponseBytes: 64 * 1024,
        },
        "webhook.url",
      );
      lastStatus = response.status;
      if (response.ok) {
        await db
          .update(webhookDelivery)
          .set({ status: "delivered", attempts: attempt, lastError: null })
          .where(eq(webhookDelivery.id, ledgerId));
        logger.info("Webhook delivered", { event: event.event, attempt, status: response.status });
        return { delivered: true, attempts: attempt, status: response.status };
      }
      lastError = `${response.status} ${response.statusText}`;
    } catch (err) {
      lastStatus = 0;
      lastError = err instanceof Error ? err.message : String(err);
    }

    await db
      .update(webhookDelivery)
      .set({ attempts: attempt, lastError: lastError.slice(0, 2000) })
      .where(eq(webhookDelivery.id, ledgerId));

    if (!shouldRetry(attempt, lastStatus)) break;
  }

  await db
    .update(webhookDelivery)
    .set({ status: "failed", lastError: lastError.slice(0, 2000) })
    .where(eq(webhookDelivery.id, ledgerId));
  logger.warn("Webhook delivery failed", {
    event: event.event,
    status: lastStatus,
    error: lastError,
  });

  const [final] = await db
    .select({ attempts: webhookDelivery.attempts })
    .from(webhookDelivery)
    .where(and(eq(webhookDelivery.id, ledgerId)))
    .limit(1);
  return {
    delivered: false,
    attempts: final?.attempts ?? WEBHOOK_MAX_ATTEMPTS,
    status: lastStatus,
    error: lastError,
  };
}
