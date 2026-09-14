/**
 * Where to POST the events.
 *
 * One hook per paired client, replaced wholesale by `PUT`. The secret goes in
 * and never comes back — `GET` reports that a secret exists, which is the only
 * thing a caller can act on without already knowing it.
 */

import { z } from "zod";
import { IsoDateTimeSchema, NullableIsoDateTimeSchema } from "./common.ts";
import { SearchEventNameSchema } from "./events.ts";

export const PutWebhookRequestSchema = z.object({
  /**
   * An `https://` URL. It goes through the SSRF guard on every delivery, so a
   * private or reserved address is refused at delivery time rather than here —
   * an operator running everything on one machine sets
   * `SEARCH_ALLOW_LOCAL_FETCH` and this works.
   */
  url: z.string().url(),
  /** The HMAC key. At least sixteen characters; sealed at rest, never returned. */
  secret: z.string().min(16).max(512),
  events: z.array(SearchEventNameSchema).min(1),
});
export type PutWebhookRequest = z.infer<typeof PutWebhookRequestSchema>;

export const WebhookSchema = z.object({
  id: z.string(),
  url: z.string(),
  events: z.array(SearchEventNameSchema),
  /** A secret is held. Never which one. */
  hasSecret: z.boolean(),
  createdAt: IsoDateTimeSchema,
});
export type Webhook = z.infer<typeof WebhookSchema>;

/** `GET /v1/webhooks`. `webhook: null` when none is registered. */
export const GetWebhookResponseSchema = z.object({
  webhook: WebhookSchema.nullable(),
  /** The last few delivery attempts, newest first. For an operator debugging one. */
  recentDeliveries: z
    .array(
      z.object({
        id: z.string(),
        eventId: z.string(),
        status: z.enum(["pending", "delivered", "failed"]),
        attempts: z.number().int(),
        lastError: z.string().nullable(),
        createdAt: NullableIsoDateTimeSchema,
      }),
    )
    .optional(),
});
export type GetWebhookResponse = z.infer<typeof GetWebhookResponseSchema>;

export const DeleteWebhookResponseSchema = z.object({ deleted: z.boolean() });
export type DeleteWebhookResponse = z.infer<typeof DeleteWebhookResponseSchema>;
