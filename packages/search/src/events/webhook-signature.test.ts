// The signature a receiver checks, and the cases a receiver gets wrong.
import { describe, expect, it } from "vitest";
import { SEARCH_SIGNATURE_PREFIX } from "@actana/search/contracts";
import { signWebhookBody, verifyWebhookSignature } from "./webhook-signature.ts";

const SECRET = "a-secret-long-enough-to-sign-with";
const BODY = JSON.stringify({
  id: "evt_1",
  event: "document.ingested",
  occurredAt: "2026-09-14T00:00:00.000Z",
  kbId: "kb_1",
});

describe("signWebhookBody", () => {
  it("is `sha256=` and 64 hex characters", () => {
    const signature = signWebhookBody(SECRET, BODY);
    expect(signature.startsWith(SEARCH_SIGNATURE_PREFIX)).toBe(true);
    expect(signature.slice(SEARCH_SIGNATURE_PREFIX.length)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is stable for the same bytes and different for a different secret", () => {
    expect(signWebhookBody(SECRET, BODY)).toBe(signWebhookBody(SECRET, BODY));
    expect(signWebhookBody("another secret", BODY)).not.toBe(signWebhookBody(SECRET, BODY));
  });

  it("signs a Buffer and the same string identically", () => {
    expect(signWebhookBody(SECRET, Buffer.from(BODY, "utf8"))).toBe(
      signWebhookBody(SECRET, BODY),
    );
  });

  it("changes when a single byte of the body changes", () => {
    const tampered = BODY.replace("kb_1", "kb_2");
    expect(signWebhookBody(SECRET, tampered)).not.toBe(signWebhookBody(SECRET, BODY));
  });
});

describe("verifyWebhookSignature", () => {
  it("accepts what the signer produced", () => {
    expect(verifyWebhookSignature(SECRET, BODY, signWebhookBody(SECRET, BODY))).toBe(true);
  });

  it("refuses the wrong secret, a tampered body, and a tampered signature", () => {
    const signature = signWebhookBody(SECRET, BODY);
    expect(verifyWebhookSignature("wrong", BODY, signature)).toBe(false);
    expect(verifyWebhookSignature(SECRET, `${BODY} `, signature)).toBe(false);
    expect(
      verifyWebhookSignature(
        SECRET,
        BODY,
        `${SEARCH_SIGNATURE_PREFIX}${"0".repeat(64)}`,
      ),
    ).toBe(false);
  });

  it("refuses a malformed header rather than throwing", () => {
    // `timingSafeEqual` throws on a length mismatch, and a throw is as timeable
    // as a `false` — so every one of these has to be answered, not raised.
    for (const header of [
      undefined,
      null,
      "",
      "deadbeef",
      "sha256=",
      "sha256=nothex",
      "sha512=0000",
      signWebhookBody(SECRET, BODY).slice(0, -2),
    ]) {
      expect(verifyWebhookSignature(SECRET, BODY, header), String(header)).toBe(false);
    }
  });
});
