// Search's pairing endpoint — the one route on this instance that answers a
// client holding no certificate.
//
// **Copied from actana/control `packages/core/src/core-pairing-routes.ts`**
// (its ADR 0034 D2, D3, D5, D6), with the store made asynchronous and the
// endpoint scheme changed. Every defence, in every order, is Control's; ADR
// 0007 records the copy and TASK-015 lifts it.
//
// A client with a pairing code posts here, and what it gets back is the
// credential every other surface on this instance requires it to already have.
// That makes this file the only pre-auth attack surface, and the reason the
// defences below are not negotiable:
//
//   POST /v1/pair/redeem
//   { "sessionId", "code", "client": { … }, "csr": "-----BEGIN CERTIFICATE REQUEST-----" }
//   → 200 { "endpoint", "caCert", "clientCert", "bearer" }
//
// **The private key is not in that exchange, in either direction.** The client
// generates its key pair, keeps the private half and sends a CSR; this instance
// signs it and sends back a certificate. There is nothing here that could
// return a key because there is nothing here that has one.
//
// **Validation runs in a fixed order** — rate limit, then session lookup and
// binding, then revocation, TTL, single use and the attempt cap, and only then
// the code itself. Every check before the code is one an attacker cannot
// influence with a guess, so a guess reaches the comparison only after the
// cheap defences have had their say — and a guess against a session the
// operator has already cancelled never costs that session one of its five
// attempts.
//
// **Every refusal is the same refusal.** Expired, consumed, unknown, dead,
// wrong code — one status, one body, no header that differs. A response that
// said *which* would tell an attacker whether a session id exists, whether it
// is still live, and whether their last guess was closer; the audit log says
// all of it, because the operator reading that log already owns the instance.
//
// **What the redemption writes that Control's does not: the grant.** The scope
// and the KB ids come off the *session* — what the operator typed when they
// minted the code — and are copied onto `paired_client`. Nothing in the request
// reaches them, which is the same rule the certificate subject already follows.

import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  SEARCH_PAIRING_REDEEM_PATH as SDK_REDEEM_PATH,
  SEARCH_PAIRING_ROUTE_PREFIX as SDK_ROUTE_PREFIX,
} from "@actana/search/pairing-wire";
import type {
  SearchPairingClientInfo,
  SearchPairingRedeemRequest,
  SearchPairingRedeemResponse,
} from "@actana/search/pairing-wire";
import {
  CsrRejectedError,
  assertSignableCsr,
  certFingerprintSha256,
  signClientCsr,
} from "@actana/search-shared/pairing/cert-material";
import { signBearer } from "@actana/search-shared/pairing/bearer";
import { normalisePairingCode } from "@actana/search-shared/pairing/pairing-code";
import {
  isConsumed,
  isDead,
  isExpired,
  isRevoked,
  type PairingSession,
} from "@actana/search-shared/pairing/pairing-session";
import {
  derivePairingCodeKey,
  hashPairingCode,
  pairingCodeMatches,
  type PairedClient,
} from "@actana/search-shared/pairing/pairing-code-digest";
import { pairingAuditor, type PairingAuditEvent } from "@actana/search-shared/pairing/pairing-audit";
import { createLogger } from "@actana/search-shared/log";
import { generateId } from "@actana/search-shared/short-id";
import type { SearchHttpRoutes } from "../api/routes.ts";
import { PairingRateLimiter } from "./pairing-rate-limit.ts";
import type { PairingSessionPort } from "./pairing-store.ts";
import { pairingBearerSubject } from "./pairing-revocation.ts";

const logger = createLogger("pairing.routes");

/** Everything this module answers lives under here. */
export const SEARCH_PAIRING_ROUTE_PREFIX = SDK_ROUTE_PREFIX;

/** The one route. Named so the pre-auth gate and the tests agree on the string. */
export const SEARCH_PAIRING_REDEEM_PATH = SDK_REDEEM_PATH;

/**
 * The most a redemption body may weigh.
 *
 * A CSR for a 2048-bit RSA key is around 1 KB in PEM; 16 KB leaves room for a
 * larger key and a label without leaving a pre-auth endpoint willing to buffer
 * whatever an attacker feels like sending.
 */
export const MAX_REDEEM_BODY_BYTES = 16 * 1024;

/**
 * How much of an over-sized body is read before the socket is simply dropped.
 *
 * A client that sent a request slightly too big gets a `413` it can act on; a
 * sender still going at a megabyte is not making a request this instance has
 * any reason to finish reading.
 */
export const DRAIN_CEILING_BYTES = 1024 * 1024;

/** How long an issued bearer is good for, when the caller does not say. */
export const DEFAULT_PAIRED_BEARER_DAYS = 365;

/** What this instance signs and speaks as. A slice of `PersistedMaterial`. */
export type PairingIssuerMaterial = {
  /** PEM CA certificate — signed against, and handed to the client. */
  caCert: string;
  /** PEM CA private key. Never leaves this process. */
  caKey: string;
  /** HMAC secret for the issued bearer, and the root of the code digest key. */
  bearerSecret: string;
  /** The instance id the bearer names. */
  instanceId: string;
  /** The stable instance UUID — the `aud` claim. */
  instanceUuid: string;
};

export type SearchPairingRoutesOptions = {
  material: PairingIssuerMaterial;
  sessions: PairingSessionPort;
  /**
   * The `https://host:port` the client that redeemed **this** session posts to
   * afterwards — what goes in the response's `endpoint`, and from there into
   * the client's blob-shaped credential.
   *
   * **The instance's own idea of its public address, and never a value derived
   * from the request.** A `Host` header is chosen by the caller, and a client
   * that pinned it would have pinned whatever an attacker wrote there. The only
   * input is the stored session — a record the operator wrote on the machine
   * that is the instance, minutes before this request existed.
   */
  endpointFor: (session: PairingSession) => string;
  /** Issued bearer lifetime. Defaults to {@link DEFAULT_PAIRED_BEARER_DAYS}. */
  bearerDays?: number;
  /** Shared across requests. A fresh default one is made when omitted. */
  rateLimiter?: PairingRateLimiter;
  /** Where attempts are recorded. Defaults to the instance log. */
  audit?: (event: PairingAuditEvent) => void;
  /** Injectable clock. Defaults to `Date.now`. */
  now?: () => number;
};

/** A refusal, in the JSON shape every route here answers with. */
type Refusal = {
  status: number;
  code: string;
  message: string;
  /** Structured and route-specific — an error id on a `core-error`, and little else. */
  detail?: unknown;
  headers?: Record<string, string>;
};

/**
 * The single refusal every session-state and wrong-code failure answers with.
 *
 * One object, referenced by every branch, because "indistinguishable" is a
 * property that decays the moment two call sites write their own version of it.
 */
const PAIRING_REFUSED: Refusal = {
  status: 403,
  code: "pairing-refused",
  message: "this pairing code cannot be redeemed",
};

/** Build the pairing route family. */
export function createPairingRequestHandler(opts: SearchPairingRoutesOptions): SearchHttpRoutes {
  const now = opts.now ?? (() => Date.now());
  const rateLimiter = opts.rateLimiter ?? new PairingRateLimiter({ now });
  const audit = opts.audit ?? pairingAuditor();
  const bearerDays = opts.bearerDays ?? DEFAULT_PAIRED_BEARER_DAYS;
  const codeKey = derivePairingCodeKey(opts.material.bearerSecret);

  function handle(req: IncomingMessage, res: ServerResponse): boolean {
    const url = new URL(req.url ?? "/", "https://search.invalid");
    if (!url.pathname.startsWith(SEARCH_PAIRING_ROUTE_PREFIX)) return false;
    if (url.pathname !== SEARCH_PAIRING_REDEEM_PATH) return false;
    void route(req, res, url).catch((err: unknown) => {
      // Anything reaching here is a bug in this file: every expected refusal
      // is returned rather than thrown. Say nothing useful on the wire.
      logger.error("pairing.unhandled", { error: err instanceof Error ? err.message : String(err) });
      audit({ outcome: "core-error", reason: "unhandled", peer: peerOf(req), at: now() });
      sendRefusal(res, {
        status: 500,
        code: "core-error",
        message: "this instance failed to handle this request",
      });
    });
    return true;
  }

  /**
   * `Expect: 100-continue` on a redemption.
   *
   * A listener has to exist or Node answers `100 Continue` itself for every
   * route on this server, so the choice is what to do rather than whether to be
   * here. An oversized body is refused before it is sent; everything else is
   * continued and handled exactly as a plain POST, which keeps one path through
   * {@link route} and one rate-limit count.
   */
  function handleContinue(req: IncomingMessage, res: ServerResponse): boolean {
    const url = new URL(req.url ?? "/", "https://search.invalid");
    if (url.pathname !== SEARCH_PAIRING_REDEEM_PATH) return false;
    const declared = Number(req.headers["content-length"] ?? 0);
    if (Number.isFinite(declared) && declared > MAX_REDEEM_BODY_BYTES) {
      sendRefusal(res, tooLarge());
      return true;
    }
    res.writeContinue();
    return handle(req, res);
  }

  async function route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const peer = peerOf(req);

    if (req.method !== "POST") {
      return sendRefusal(res, {
        status: 405,
        code: "method-not-allowed",
        message: `${req.method ?? "?"} is not allowed at ${url.pathname} — use POST`,
        headers: { allow: "POST" },
      });
    }

    // ── 1. Rate limit ──
    // First, and before anything is read off the socket: this is the defence
    // that has to hold when the attacker is not playing along, and every check
    // after it costs this process something an attacker can ask for at will.
    const verdict = rateLimiter.check(peer);
    if (!verdict.ok) {
      audit({ outcome: "rate-limited", reason: verdict.scope, peer, at: now() });
      return sendRefusal(res, {
        status: 429,
        code: "rate-limited",
        message: "too many pairing attempts — wait and try again",
        headers: { "retry-after": String(Math.ceil(verdict.retryAfterMs / 1000)) },
      });
    }

    const body = await readJsonBody(req);
    if (!body.ok) {
      audit({ outcome: "bad-request", reason: body.reason, peer, at: now() });
      return sendRefusal(res, body.refusal);
    }
    const request = parseRedeemRequest(body.value);
    if (!request.ok) {
      audit({ outcome: "bad-request", reason: request.reason, peer, at: now() });
      return sendRefusal(res, { status: 400, code: "bad-request", message: request.message });
    }
    const { sessionId, code, label: clientLabel, platform, csr } = request.value;

    // ── 2. Session lookup and binding ──
    // The redemption names one session and is answered by that session or by
    // nothing. There is no search for a session the code might belong to: the
    // digest is taken over this session's id, so a code lifted from session A
    // does not hash to session B's stored digest even if it is the right code.
    const session = await opts.sessions.getSession(sessionId);
    if (!session) {
      audit({ outcome: "refused", reason: "unknown-session", sessionId, peer, at: now() });
      return sendRefusal(res, PAIRING_REFUSED);
    }

    // ── 3. Revoked · 4. TTL · 5. Single use · 6. Attempt cap ──
    // Written out in the fixed order rather than delegated to `canRedeem`,
    // whose internal order is its own. Nothing observable turns on which of the
    // four answers first — all four produce the one refusal — but the order a
    // reader has to check against the spec is the order it is written in.
    const at = now();
    if (isRevoked(session)) return refuse(res, audit, session, peer, "revoked");
    if (isExpired(session, at)) return refuse(res, audit, session, peer, "expired");
    if (isConsumed(session)) return refuse(res, audit, session, peer, "already-consumed");
    if (isDead(session)) return refuse(res, audit, session, peer, "attempts-exhausted");

    // ── 7. The code ──
    // A code that is not in the alphabet at all is a wrong code, not a protocol
    // error: it is a guess that cannot be right, and treating it as a 400 would
    // hand an attacker a free probe that never costs them an attempt.
    const canonical = normalisePairingCode(code);
    const candidate =
      canonical === null ? null : hashPairingCode({ key: codeKey, sessionId, code: canonical });
    if (candidate === null || !pairingCodeMatches(session.codeHash, candidate)) {
      const after = await opts.sessions.recordWrongAttempt(sessionId);
      audit({
        outcome: "refused",
        reason: canonical === null ? "malformed-code" : "wrong-code",
        sessionId,
        label: session.label,
        peer,
        attempts: after?.attempts ?? session.attempts,
        at: now(),
      });
      return sendRefusal(res, PAIRING_REFUSED);
    }

    // ── The CSR, before anything is spent ──
    // Checked here rather than at the signature below so that a malformed
    // request does not consume the operator's session: the code was right, so
    // this is a client bug rather than an attack, and the operator should not
    // have to mint a new code for it. An attacker gains nothing — they had to
    // know the code to get this far.
    try {
      await assertSignableCsr(csr);
    } catch (err) {
      if (!(err instanceof CsrRejectedError)) throw err;
      audit({
        outcome: "bad-request",
        reason: `csr-${err.rejection}`,
        sessionId,
        label: session.label,
        peer,
        at: now(),
      });
      return sendRefusal(res, {
        status: 400,
        code: "bad-request",
        message: "the CSR was not acceptable",
      });
    }

    // ── Consume, then issue ──
    // This is the step that decides a race, and here it is one conditional
    // `UPDATE`. Two redemptions arriving together both reach here; one claims
    // the row and goes on to sign, the other is told `already-consumed` and
    // gets the same refusal a replay gets.
    const consumed = await opts.sessions.consume(sessionId, at);
    if (!consumed.ok) return refuse(res, audit, session, peer, consumed.reason);

    let issued;
    try {
      issued = await signClientCsr({
        ca: { cert: opts.material.caCert, key: opts.material.caKey },
        csrPem: csr,
        // The subject is the instance's to write, from what the operator typed
        // when they opened the session — never from the CSR, which is the
        // client's to fill in. See `signClientCsr`.
        subject: `CN=${certCommonName(session.label || clientLabel || sessionId)}`,
      });
    } catch (err) {
      // The session is spent and no certificate exists. That is the safe
      // direction: the operator mints another code, where the other one would
      // leave a live code after a failed issuance.
      logger.error("pairing.sign-failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      audit({
        outcome: "core-error",
        reason: "sign-failed",
        sessionId,
        label: session.label,
        peer,
        at: now(),
      });
      return sendRefusal(res, {
        status: 500,
        code: "core-error",
        message: "this instance could not sign the request",
      });
    }

    const client: PairedClient = {
      id: generateId(),
      certSerial: issued.serial,
      certFingerprint: certFingerprintSha256(issued.cert),
      certSubject: issued.subject,
      label: session.label || clientLabel || "paired-client",
      platform,
      sessionId,
      pairedAt: at,
      certNotAfter: issued.notAfter,
      revokedAt: null,
      // From the session the operator minted, and from nothing on this request.
      scope: session.scope,
      kbIds: session.kbIds ?? null,
      created_by: session.created_by,
      tenant_id: session.tenant_id,
      auth_method: session.auth_method,
    };
    try {
      await opts.sessions.recordClient(client);
    } catch (err) {
      // A certificate exists that no row names, which is a certificate this
      // instance will refuse on its very next request (the identity lookup is
      // by serial). Say so rather than answering 200 with a credential that
      // cannot work.
      logger.error("pairing.record-failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      audit({
        outcome: "core-error",
        reason: "record-failed",
        sessionId,
        label: session.label,
        peer,
        certSerial: issued.serial,
        at: now(),
      });
      return sendRefusal(res, {
        status: 500,
        code: "core-error",
        message: "this instance could not record the pairing",
      });
    }

    const bearer = signBearer(
      {
        instanceId: opts.material.instanceId,
        exp: at + bearerDays * 24 * 60 * 60 * 1000,
        // `sub` is the certificate serial because that is what identifies *this
        // pairing* — a label is whatever the operator typed, possibly twice.
        iss: `search:${opts.material.instanceId}`,
        sub: pairingBearerSubject(issued.serial),
        aud: opts.material.instanceUuid,
        jti: randomUUID(),
      },
      opts.material.bearerSecret,
    );

    audit({
      outcome: "issued",
      sessionId,
      label: session.label,
      peer,
      certSerial: issued.serial,
      at: now(),
    });

    // Four fields, and the absence of a fifth is the point: there is no key
    // here, and `pairing-redeem.test.ts` asserts the response never contains
    // one.
    const answer: SearchPairingRedeemResponse = {
      caCert: opts.material.caCert,
      clientCert: issued.cert,
      bearer,
      // From the session this redemption named, and from nothing else on this
      // request — see `endpointFor`. `consumed.session` rather than the copy
      // read at step 2 so the answer is built from the row the store just
      // wrote, which is the row that decided the race.
      endpoint: opts.endpointFor(consumed.session),
    };
    sendJson(res, 200, answer);
  }

  return { handle, handleContinue };
}

/** Answer the one refusal, and record which defence produced it. */
function refuse(
  res: ServerResponse,
  audit: (event: PairingAuditEvent) => void,
  session: PairingSession,
  peer: string,
  reason: string,
): void {
  audit({
    outcome: "refused",
    reason,
    sessionId: session.id,
    label: session.label,
    peer,
    attempts: session.attempts,
    at: Date.now(),
  });
  sendRefusal(res, PAIRING_REFUSED);
}

/**
 * A redemption, as this instance uses it.
 *
 * The load-bearing fields are the wire's own declarations rather than re-typed
 * copies, so renaming or retyping one in the SDK stops this file compiling
 * instead of producing two processes that disagree at runtime. `label` and
 * `platform` are deliberately *not* the wire shape: the parser flattens
 * `client.label` and `client.platform` to trimmed strings or null, which is a
 * projection of the contract rather than a second version of it.
 */
type RedeemRequest = Pick<SearchPairingRedeemRequest, "sessionId" | "code" | "csr"> & {
  label: string | null;
  platform: string | null;
};

type ParseResult = { ok: true; value: RedeemRequest } | { ok: false; reason: string; message: string };

/**
 * Read the redemption out of a parsed JSON body.
 *
 * Refuses everything it does not recognise rather than coercing it: this is the
 * one endpoint where the sender is unauthenticated, so "was it a string?" is
 * the last question asked before the answer is used in a cryptographic
 * operation.
 */
function parseRedeemRequest(body: unknown): ParseResult {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, reason: "not-an-object", message: "the body must be a JSON object" };
  }
  const o = body as Record<string, unknown>;
  const sessionId = o.sessionId;
  const code = o.code;
  const csr = o.csr;
  if (typeof sessionId !== "string" || sessionId.length === 0 || sessionId.length > 128) {
    return { ok: false, reason: "bad-session-id", message: "`sessionId` must be a non-empty string" };
  }
  if (typeof code !== "string" || code.length === 0 || code.length > 64) {
    return { ok: false, reason: "bad-code", message: "`code` must be a non-empty string" };
  }
  if (typeof csr !== "string" || !csr.includes("BEGIN CERTIFICATE REQUEST")) {
    return { ok: false, reason: "bad-csr", message: "`csr` must be a PEM certificate request" };
  }
  // Read through the wire's own `client` declaration.
  const client = o.client as SearchPairingClientInfo | undefined;
  const readable = client && typeof client === "object" ? client : undefined;
  const label = typeof readable?.label === "string" ? readable.label.slice(0, 64) : null;
  const platform = typeof readable?.platform === "string" ? readable.platform.slice(0, 64) : null;
  return { ok: true, value: { sessionId, code, label, platform, csr } };
}

type BodyResult = { ok: true; value: unknown } | { ok: false; reason: string; refusal: Refusal };

/**
 * Read the request body, refusing anything over {@link MAX_REDEEM_BODY_BYTES}.
 *
 * The cap is enforced as the bytes arrive, not against `content-length`: a
 * `content-length` is whatever the sender wrote, and a chunked body has none at
 * all.
 *
 * Past the cap nothing is kept, and the rest of the body is **drained rather
 * than cut off**. Destroying the socket there is the obvious move and it is
 * wrong: the refusal would be written into a connection that is about to be
 * reset, so a client sending one byte too many would see a dropped connection
 * instead of the `413` telling it why. Draining stops at
 * {@link DRAIN_CEILING_BYTES} — past *that* the sender is not a client that
 * mis-sized a request, and the socket goes.
 */
function readJsonBody(req: IncomingMessage): Promise<BodyResult> {
  const contentType = String(req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
  if (contentType !== "" && contentType !== "application/json") {
    return Promise.resolve({
      ok: false,
      reason: "content-type",
      refusal: {
        status: 415,
        code: "unsupported-media-type",
        message: "a redemption is `application/json`",
      },
    });
  }
  return new Promise<BodyResult>((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooBig = false;
    let settled = false;
    const settle = (result: BodyResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_REDEEM_BODY_BYTES) {
        tooBig = true;
        chunks.length = 0;
        if (size > DRAIN_CEILING_BYTES) {
          settle({ ok: false, reason: "too-large", refusal: tooLarge() });
          req.destroy();
        }
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooBig) return settle({ ok: false, reason: "too-large", refusal: tooLarge() });
      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        settle({
          ok: false,
          reason: "bad-json",
          refusal: { status: 400, code: "bad-request", message: "the body was not JSON" },
        });
        return;
      }
      settle({ ok: true, value: parsed });
    });
    req.on("error", () => {
      settle({
        ok: false,
        reason: "read-failed",
        refusal: { status: 400, code: "bad-request", message: "the request body could not be read" },
      });
    });
  });
}

function tooLarge(): Refusal {
  return {
    status: 413,
    code: "payload-too-large",
    message: `a redemption is at most ${MAX_REDEEM_BODY_BYTES} bytes`,
  };
}

/**
 * The address this attempt came from, for the audit log.
 *
 * `unknown` rather than an empty string when the socket has already gone: a log
 * line that says where it came from and a log line that says nothing must not
 * look the same.
 */
function peerOf(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? "unknown";
}

/**
 * A label as it can appear inside a certificate subject.
 *
 * The operator typed this, and it ends up in an X.509 distinguished name where
 * `,`, `=` and `+` are structure rather than text. Everything outside a
 * conservative set is replaced rather than escaped: a certificate subject is
 * not the place to be clever.
 */
function certCommonName(label: string): string {
  const cleaned = label.replace(/[^A-Za-z0-9 ._-]/g, "-").trim().slice(0, 48);
  return cleaned.length > 0 ? cleaned : "paired-client";
}

export function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(body)),
    "cache-control": "no-store",
  });
  res.end(body);
}

/**
 * Write a refusal: `{ code, message, error }`, and `detail` where there is one.
 *
 * **All three keys, always.** `ErrorBodySchema` (`@actana/search/contracts`)
 * requires `message`, and ADR 0009 D6 says `error` is written *beside* it with
 * the same string — so a body carrying only `error`, which is what this wrote
 * while the pre-auth surface was its only caller, does not validate against the
 * contract the SDK infers its error type from. The router refuses through this
 * function too (`api/server.ts`), so that gap was every scope, KB, route and
 * certificate refusal on the authenticated surface.
 */
export function sendRefusal(res: ServerResponse, refusal: Refusal): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const body = JSON.stringify({
    code: refusal.code,
    message: refusal.message,
    error: refusal.message,
    ...(refusal.detail === undefined ? {} : { detail: refusal.detail }),
  });
  res.writeHead(refusal.status, {
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(body)),
    "cache-control": "no-store",
    ...refusal.headers,
  });
  res.end(body);
}
