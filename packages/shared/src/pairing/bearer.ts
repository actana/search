// The bearer a redemption hands back, and the only reason it exists.
//
// **Copied from actana/control `packages/shared/src/core-link-bearer.ts`**
// (ADR 0008), with `coreId` reading `instanceId` and the verify half kept.
//
// **Search does not authenticate anybody with this.** ADR 0003 is categorical:
// the client certificate is the identity, and every route resolves its caller
// from the certificate on the connection. Nothing in `api/server.ts` reads a
// bearer, and a request that carries one is answered exactly as one that does
// not.
//
// It is minted and returned anyway, because the redemption response is
// Control's wire and TASK-006 is a copy rather than a redesign: Control's 200
// body is `{endpoint, caCert, clientCert, bearer}`, a Studio sidecar built
// against `@actana/sdk`'s `CoreRegistrationBlob` expects four fields, and
// dropping one would be a wire change made in passing. So the field is filled
// with the same computation Control fills it with, over the same secret, and
// ADR 0008 names it as the one part of the copy that is inert here. If TASK-015
// lifts the pairing code into a shared package, this is what it lifts; if
// Search ever wants an app-layer session, this is already the one it would
// have.
//
// The secret is not otherwise idle: `derivePairingCodeKey` keys the pairing
// code digest off it, which is what keeps a copy of `search.pairing_code` from
// being a list of enumerable code hashes.

import { createHmac, timingSafeEqual } from "node:crypto";

/** The shared HMAC key. Minted with the instance's material. */
export type BearerSecret = string;

export type BearerClaims = {
  /** The instance this bearer speaks for. */
  instanceId: string;
  /** Wall-clock ms expiry (JWT `exp`-style). Inclusive at the boundary. */
  exp: number;
  /** Who issued it — `search:<instanceId>`. */
  iss?: string;
  /** The subject — the paired client's identity, as `pair:<certSerial>`. */
  sub?: string;
  /** The audience: this instance's stable UUID, not its id. */
  aud?: string;
  /** Unique token id, so a later layer can revoke or de-duplicate one. */
  jti?: string;
};

/** The optional standard claims, in the order {@link signBearer} writes them. */
const STANDARD_CLAIMS = ["iss", "sub", "aud", "jti"] as const;

/** HMAC port. The default uses `node:crypto.createHmac`. */
export interface HmacPort {
  sha256(key: string, data: string): Buffer;
}

const defaultHmac: HmacPort = {
  sha256: (key, data) => createHmac("sha256", key).update(data).digest(),
};

/** Separator between the base64url payload and the base64url signature. */
const SEP = ".";

function encodeBase64Url(buf: Buffer): string {
  return buf.toString("base64url");
}

function decodeBase64Url(s: string): Buffer {
  return Buffer.from(s, "base64url");
}

function safeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * Sign `{instanceId, exp}` — plus whichever of `iss`, `sub`, `aud` and `jti`
 * the caller supplied — with `secret`, and return the URL-safe bearer string
 * `base64url(payload).base64url(sig)`.
 *
 * Absent claims are left out of the payload rather than written as `null`.
 */
export function signBearer(
  claims: BearerClaims,
  secret: BearerSecret,
  hmac: HmacPort = defaultHmac,
): string {
  const payload: Record<string, string | number> = {
    instanceId: claims.instanceId,
    exp: claims.exp,
  };
  for (const claim of STANDARD_CLAIMS) {
    const value = claims[claim];
    if (value !== undefined) payload[claim] = value;
  }
  const payloadB64 = encodeBase64Url(Buffer.from(JSON.stringify(payload), "utf8"));
  const sig = hmac.sha256(secret, payloadB64);
  return `${payloadB64}${SEP}${encodeBase64Url(sig)}`;
}

export type BearerVerifyOk = {
  ok: true;
  instanceId: string;
  exp: number;
  iss?: string;
  sub?: string;
  aud?: string;
  jti?: string;
};

export type BearerVerifyErr =
  | { ok: false; reason: "malformed" }
  | { ok: false; reason: "bad-signature" }
  | { ok: false; reason: "expired" };

export type BearerVerifyResult = BearerVerifyOk | BearerVerifyErr;

/**
 * Verify a bearer: split, decode the payload, check the HMAC in constant time,
 * then check `exp` against the current clock. `now` is injectable for tests.
 *
 * Kept even though nothing in the running service calls it, for the same
 * reason the field is minted: this is a copy of Control's module, and a copy
 * that kept only half of a signer/verifier pair is a copy nobody can check.
 */
export function verifyBearer(
  token: string,
  secret: BearerSecret,
  opts: { now?: number; hmac?: HmacPort } = {},
): BearerVerifyResult {
  const hmac = opts.hmac ?? defaultHmac;
  const sep = token.indexOf(SEP);
  if (sep <= 0 || sep === token.length - 1) return { ok: false, reason: "malformed" };
  const payloadB64 = token.slice(0, sep);
  const sigB64 = token.slice(sep + 1);

  let payloadJson: string;
  try {
    payloadJson = decodeBase64Url(payloadB64).toString("utf8");
  } catch {
    return { ok: false, reason: "malformed" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson);
  } catch {
    return { ok: false, reason: "malformed" };
  }

  const actualSig = hmac.sha256(secret, payloadB64);
  let presented: Buffer;
  try {
    presented = decodeBase64Url(sigB64);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!safeEqual(actualSig, presented)) return { ok: false, reason: "bad-signature" };

  if (!parsed || typeof parsed !== "object") return { ok: false, reason: "malformed" };
  const obj = parsed as { instanceId?: unknown; exp?: unknown };
  if (typeof obj.instanceId !== "string" || typeof obj.exp !== "number") {
    return { ok: false, reason: "malformed" };
  }
  const claims = readStandardClaims(parsed as Record<string, unknown>);
  if (claims === null) return { ok: false, reason: "malformed" };

  const now = opts.now ?? Date.now();
  if (now > obj.exp) return { ok: false, reason: "expired" };

  return { ok: true, instanceId: obj.instanceId, exp: obj.exp, ...claims };
}

/**
 * The optional standard claims, or `null` when one of them is present and not
 * a string. A present-but-wrong-typed claim is a malformed token; an absent one
 * is an older token and is fine.
 */
function readStandardClaims(payload: Record<string, unknown>): Partial<BearerClaims> | null {
  const claims: Partial<BearerClaims> = {};
  for (const claim of STANDARD_CLAIMS) {
    const value = payload[claim];
    if (value === undefined) continue;
    if (typeof value !== "string") return null;
    claims[claim] = value;
  }
  return claims;
}
