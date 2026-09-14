/**
 * How a webhook delivery is signed, and how a receiver checks it.
 *
 * `x-search-signature: sha256=<hex>`, an HMAC-SHA256 **over the raw request
 * body** keyed by the secret the client registered. Over the raw bytes and not
 * over a re-serialisation of the parsed JSON, because two encoders do not agree
 * on key order or on whitespace and a receiver that re-encodes before checking
 * is a receiver whose check passes on a body it never saw.
 *
 * The verifier is here rather than only in a test because the receiver is the
 * paired client, the paired client is usually holding this SDK's sibling, and
 * "write your own constant-time compare" is the instruction that produces the
 * `===` that leaks the signature a byte at a time.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";
import { SEARCH_SIGNATURE_PREFIX } from "@actana/search/contracts";

/**
 * The value of `x-search-signature` for this body under this secret.
 *
 * `body` is a string or a Buffer and both are hashed as the bytes that will be
 * sent — pass exactly what goes on the wire.
 */
export function signWebhookBody(secret: string, body: string | Buffer): string {
  const mac = createHmac("sha256", secret).update(body).digest("hex");
  return `${SEARCH_SIGNATURE_PREFIX}${mac}`;
}

/**
 * Is `header` the signature for this body under this secret?
 *
 * Constant-time over the hex digest. A malformed header — wrong prefix, wrong
 * length, absent — is `false` without reaching the compare, because
 * `timingSafeEqual` throws on a length mismatch and a throw is an answer an
 * attacker can time just as well as a `false`.
 */
export function verifyWebhookSignature(
  secret: string,
  body: string | Buffer,
  header: string | null | undefined,
): boolean {
  if (typeof header !== "string" || !header.startsWith(SEARCH_SIGNATURE_PREFIX)) return false;
  const offered = Buffer.from(header.slice(SEARCH_SIGNATURE_PREFIX.length), "hex");
  const expected = Buffer.from(
    signWebhookBody(secret, body).slice(SEARCH_SIGNATURE_PREFIX.length),
    "hex",
  );
  if (offered.length !== expected.length || expected.length === 0) return false;
  return timingSafeEqual(offered, expected);
}
