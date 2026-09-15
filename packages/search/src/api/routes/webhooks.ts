/**
 * `/v1/webhooks` — where to POST `document.ingested`, `document.failed` and
 * `clusters.retrained`.
 *
 * One hook per paired client, replaced wholesale by `PUT`. The secret is sealed
 * with `SEARCH_ENCRYPTION_KEY` on the way in and is never in a response: `GET`
 * answers `hasSecret`, which is the only fact about it a caller can act on
 * without already knowing the value.
 */

import { desc, eq } from "drizzle-orm";
import { PutWebhookRequestSchema } from "@actana/search/contracts";
import type { Webhook } from "@actana/search/contracts";
import { generateId } from "@actana/search-shared/short-id";
import { db } from "../../db/client.ts";
import { webhook } from "../../db/schema.ts";
import { encryptSecret } from "../../core/security/encryption.ts";
import { validateExternalUrl } from "../../core/security/url-guard.ts";
import { recentDeliveries, webhookForClient } from "../../events/webhooks.ts";
import { badRequest, parseWith, readJsonBody, route, sendJson } from "../http.ts";
import type { SearchRouter } from "../routes.ts";
import { iso, isoRequired } from "../serialize.ts";

const webhookToWire = (row: typeof webhook.$inferSelect): Webhook => ({
  id: row.id,
  url: row.url,
  events: (row.events as Webhook["events"]) ?? [],
  hasSecret: row.secretCiphertext !== "",
  createdAt: isoRequired(row.createdAt),
});

export function registerWebhookRoutes(router: SearchRouter): void {
  router.add(
    route("GET", "/v1/webhooks", "read", async ({ res, client }) => {
      const hook = await webhookForClient(client!.id);
      if (!hook) {
        sendJson(res, 200, { webhook: null });
        return;
      }
      const deliveries = await recentDeliveries(hook.id);
      sendJson(res, 200, {
        webhook: webhookToWire(hook),
        recentDeliveries: deliveries.map((d) => ({
          id: d.id,
          eventId: d.eventId,
          status: d.status as "pending" | "delivered" | "failed",
          attempts: d.attempts,
          lastError: d.lastError,
          createdAt: iso(d.createdAt),
        })),
      });
    }),
  );

  router.add(
    route("PUT", "/v1/webhooks", "admin", async ({ req, res, client }) => {
      const body = parseWith(PutWebhookRequestSchema, await readJsonBody(req));

      /**
       * Checked here as well as on every delivery. A URL that can never be
       * delivered to is worth refusing at registration, when somebody is
       * watching, rather than silently at 3 a.m. in a delivery ledger.
       */
      const verdict = validateExternalUrl(body.url, "url");
      if (!verdict.isValid) throw badRequest(verdict.error ?? "that URL cannot be delivered to");

      const sealed = await encryptSecret(body.secret);
      // One hook per client: the replacement is a delete and an insert rather
      // than an update, so the old hook's delivery ledger goes with it.
      await db.delete(webhook).where(eq(webhook.pairedClientId, client!.id));
      const id = generateId();
      await db.insert(webhook).values({
        id,
        pairedClientId: client!.id,
        url: body.url,
        secretCiphertext: sealed.encrypted,
        events: body.events,
        createdAt: new Date(),
      });

      const [row] = await db
        .select()
        .from(webhook)
        .where(eq(webhook.id, id))
        .orderBy(desc(webhook.createdAt))
        .limit(1);
      sendJson(res, 200, { webhook: row ? webhookToWire(row) : null });
    }),
  );

  router.add(
    route("DELETE", "/v1/webhooks", "admin", async ({ res, client }) => {
      const removed = await db
        .delete(webhook)
        .where(eq(webhook.pairedClientId, client!.id))
        .returning({ id: webhook.id });
      sendJson(res, 200, { deleted: removed.length > 0 });
    }),
  );
}
