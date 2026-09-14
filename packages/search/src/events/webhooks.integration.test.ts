/**
 * @vitest-environment node
 *
 * One delivery, against a real `http.createServer`.
 *
 * The signer and the retry policy are unit-tested beside this file; what needs
 * a socket and a database is the part between them — that the request actually
 * carries the two headers, that a 503 is tried again and a 404 is not, that the
 * `webhook_delivery` row ends up saying what happened, and that the same event
 * is never POSTed twice.
 *
 * Env-gated on `SEARCH_TEST_DATABASE_URL`; without it the whole suite skips.
 */

import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { SearchEvent } from "@actana/search/contracts";
import {
  SEARCH_EVENT_ID_HEADER,
  SEARCH_SIGNATURE_HEADER,
} from "@actana/search/contracts";
import { generateId, generateShortId } from "@actana/search-shared/short-id";
import { resetConfig } from "../config.ts";
import { db } from "../db/client.ts";
import { pairedClient, webhook, webhookDelivery } from "../db/schema.ts";
import { runMigrations } from "../db/migrate.ts";
import { encryptSecret } from "../core/security/encryption.ts";
import { deliverSearchEvent, recentDeliveries } from "./webhooks.ts";
import { verifyWebhookSignature } from "./webhook-signature.ts";

const TEST_DATABASE_URL = process.env.SEARCH_TEST_DATABASE_URL;
const describeDb = TEST_DATABASE_URL ? describe : describe.skip;

const PREFIX = `whook-${generateShortId(8)}`;
const SECRET = "a-secret-long-enough-to-sign-with";

/** What the receiver saw, in arrival order. */
const received: Array<{ headers: http.IncomingHttpHeaders; raw: string; path: string }> = [];
/** The status the receiver will answer with, popped per request. */
let answers: number[] = [];

let server: http.Server;
let origin: string;

const eventFor = (name: SearchEvent["event"], id: string): SearchEvent => ({
  id,
  event: name,
  occurredAt: new Date().toISOString(),
  kbId: `${PREFIX}-kb`,
  documentId: `${PREFIX}-doc`,
  filename: "handbook.md",
  chunkCount: 6,
});

async function registerWebhook(events: string[]): Promise<string> {
  const id = generateId();
  await db.delete(webhook).where(eq(webhook.pairedClientId, `${PREFIX}-client`));
  await db.insert(webhook).values({
    id,
    pairedClientId: `${PREFIX}-client`,
    url: `${origin}/hook`,
    secretCiphertext: (await encryptSecret(SECRET)).encrypted,
    events,
    createdAt: new Date(),
  });
  return id;
}

describeDb("webhook delivery", () => {
  beforeAll(async () => {
    process.env.SEARCH_DATABASE_URL = TEST_DATABASE_URL as string;
    // The receiver is on loopback, and the SSRF guard refuses loopback unless a
    // deployment says it is all on one machine. A test is one machine.
    process.env.SEARCH_ALLOW_LOCAL_FETCH = "1";
    resetConfig();
    await runMigrations({ url: TEST_DATABASE_URL as string });

    await db.insert(pairedClient).values({
      id: `${PREFIX}-client`,
      label: PREFIX,
      certSerial: `${PREFIX}-serial`,
      certFingerprint: `${PREFIX}-fingerprint`,
      scope: "admin",
      status: "active",
      createdAt: new Date(),
    });

    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        received.push({
          headers: req.headers,
          raw: Buffer.concat(chunks).toString("utf8"),
          path: req.url ?? "/",
        });
        res.writeHead(answers.shift() ?? 204).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 120_000);

  afterAll(async () => {
    await db.delete(pairedClient).where(eq(pairedClient.id, `${PREFIX}-client`));
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  }, 60_000);

  it("POSTs the event signed, with its id in a header, and records the delivery", async () => {
    received.length = 0;
    answers = [204];
    const hookId = await registerWebhook(["document.ingested"]);
    const event = eventFor("document.ingested", `${PREFIX}-evt-ok`);

    const outcome = await deliverSearchEvent(`${PREFIX}-client`, event);
    expect(outcome).toMatchObject({ delivered: true, attempts: 1, status: 204 });

    expect(received).toHaveLength(1);
    const [got] = received;
    expect(got!.path).toBe("/hook");
    expect(got!.headers["content-type"]).toBe("application/json");
    expect(got!.headers[SEARCH_EVENT_ID_HEADER]).toBe(event.id);
    expect(JSON.parse(got!.raw)).toEqual(event);
    // Verified over the raw bytes, which is the only thing a receiver can do.
    expect(
      verifyWebhookSignature(SECRET, got!.raw, got!.headers[SEARCH_SIGNATURE_HEADER] as string),
    ).toBe(true);

    const ledger = await recentDeliveries(hookId);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      eventId: event.id,
      status: "delivered",
      attempts: 1,
      lastError: null,
    });
  }, 60_000);

  it("tries a 503 again and lands delivered, with the attempt count to show it", async () => {
    received.length = 0;
    answers = [503, 204];
    const hookId = await registerWebhook(["document.ingested"]);
    const event = eventFor("document.ingested", `${PREFIX}-evt-retry`);

    const outcome = await deliverSearchEvent(`${PREFIX}-client`, event);
    expect(outcome).toMatchObject({ delivered: true, attempts: 2, status: 204 });
    expect(received).toHaveLength(2);
    // Both attempts carry the same event id, so a receiver can deduplicate.
    expect(received.map((r) => r.headers[SEARCH_EVENT_ID_HEADER])).toEqual([event.id, event.id]);

    const [row] = await recentDeliveries(hookId);
    expect(row).toMatchObject({ status: "delivered", attempts: 2 });
  }, 60_000);

  it("does not try a 404 again — the request itself is what it rejected", async () => {
    received.length = 0;
    answers = [404, 204, 204, 204, 204];
    const hookId = await registerWebhook(["document.ingested"]);
    const event = eventFor("document.ingested", `${PREFIX}-evt-gone`);

    const outcome = await deliverSearchEvent(`${PREFIX}-client`, event);
    expect(outcome).toMatchObject({ delivered: false, status: 404 });
    expect(received).toHaveLength(1);

    const [row] = await recentDeliveries(hookId);
    expect(row).toMatchObject({ status: "failed", attempts: 1 });
    expect(row!.lastError).toContain("404");
  }, 60_000);

  it("POSTs an event only once per hook, however often it is published", async () => {
    received.length = 0;
    answers = [204, 204];
    await registerWebhook(["document.ingested"]);
    const event = eventFor("document.ingested", `${PREFIX}-evt-once`);

    await expect(deliverSearchEvent(`${PREFIX}-client`, event)).resolves.toMatchObject({
      delivered: true,
    });
    await expect(deliverSearchEvent(`${PREFIX}-client`, event)).resolves.toMatchObject({
      skipped: "already-recorded",
    });
    expect(received).toHaveLength(1);
  }, 60_000);

  it("skips an event the hook did not subscribe to, and a client with no hook", async () => {
    received.length = 0;
    answers = [204];
    await registerWebhook(["clusters.retrained"]);
    await expect(
      deliverSearchEvent(`${PREFIX}-client`, eventFor("document.ingested", `${PREFIX}-evt-unsub`)),
    ).resolves.toEqual({ delivered: false, skipped: "not-subscribed" });

    await db.delete(webhook).where(eq(webhook.pairedClientId, `${PREFIX}-client`));
    await expect(
      deliverSearchEvent(`${PREFIX}-client`, eventFor("document.ingested", `${PREFIX}-evt-none`)),
    ).resolves.toEqual({ delivered: false, skipped: "no-webhook" });

    expect(received).toHaveLength(0);
    const remaining = await db
      .select({ id: webhookDelivery.id })
      .from(webhookDelivery)
      .where(eq(webhookDelivery.eventId, `${PREFIX}-evt-unsub`));
    // Nothing was claimed, so nothing is sitting in the ledger as `pending`.
    expect(remaining).toHaveLength(0);
  }, 60_000);
});
