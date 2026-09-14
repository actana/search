// The pending pairing session — what Search holds between `pair new` and the
// client redeeming the code.
//
// **Copied from actana/control `packages/shared/src/pairing-session.ts`** (its
// ADR 0034), with one addition named below. ADR 0008 records the copy.
//
// Everything here is a pure function over a plain object. The session is
// minted, expired, attempted against and consumed by the service, which owns
// the clock, the store and the audit log; this module owns only the rules, so
// it takes `now` as an argument. Nothing here reads a socket, a disk or a clock
// it was not handed, and no test needs fake timers to walk a session past its
// expiry.
//
// The three defences are deliberately separate: a **TTL** bounds how long a
// code is worth stealing, a **cap of five wrong attempts** bounds guessing
// within one session, and **single use** stops a redeemed code being replayed.
// Each has its own field and its own transition below, so a change to one
// cannot silently weaken another. Rate limiting on the endpoint is the fourth
// defence and is *not* here — it is per-caller, not per-session, and belongs to
// the server that can see callers.
//
// **The one addition to Control's shape: `scope`.** A Control pairing issues
// one kind of client; a Search pairing issues a client with a scope and
// optionally a list of KB ids (ADR 0003), and the grant has to be decided by
// the operator who minted the code rather than asked for by the caller
// redeeming it. So it rides on the session, is copied onto `paired_client` at
// redemption, and is never read off the request.

/** How long a freshly minted session stays redeemable. Five minutes. */
export const PAIRING_SESSION_TTL_MS = 5 * 60 * 1000;

/** Wrong codes a single session tolerates before it is dead. */
export const PAIRING_ATTEMPT_CAP = 5;

/** What a paired client may do. Deliberately coarse (ADR 0003). */
export const PAIRING_SCOPES = ["read", "write", "admin"] as const;
export type PairingScope = (typeof PAIRING_SCOPES)[number];

/** The default a `pair new` with no `--scope` mints. */
export const DEFAULT_PAIRING_SCOPE: PairingScope = "admin";

/** Is this a scope Search knows? Used wherever a scope arrives as a string. */
export function isPairingScope(value: unknown): value is PairingScope {
  return typeof value === "string" && (PAIRING_SCOPES as readonly string[]).includes(value);
}

/**
 * The grant a code carries, and the grant its redemption writes onto the
 * paired client.
 *
 * `kbIds` absent or empty means "every KB this client owns" — the same meaning
 * the column's NULL carries in `search.paired_client`.
 */
export type PairingGrant = {
  scope: PairingScope;
  kbIds?: string[] | null;
};

/**
 * A pending pairing session.
 *
 * `codeHash` is a digest, not the code: the plaintext is printed once to the
 * operator's terminal and never stored, so a stolen session store is not a pile
 * of live pairing codes. Which digest is the service's business — this module
 * compares nothing and only carries the field.
 *
 * `created_by`, `tenant_id` and `auth_method` are **inert**, exactly as they
 * are in Control: they are the hooks a later identity layer reads, and nothing
 * here writes or enforces them. They keep the snake_case of the columns they
 * are.
 */
export type PairingSession = {
  /** Opaque session id — what a redemption names, so it cannot be replayed
   *  against a different session. */
  id: string;
  /** Operator-supplied name for the machine being paired. Display only. */
  label: string;
  /** Digest of the pairing code. Never the code itself — see above. */
  codeHash: string;
  /** Wall-clock ms at mint. */
  createdAt: number;
  /** Wall-clock ms after which the session is no longer redeemable. */
  expiresAt: number;
  /** Wrong codes seen so far, capped at `attemptCap`. */
  attempts: number;
  /** This session's cap, copied at mint so a config change cannot retroactively
   *  revive or kill sessions already in flight. */
  attemptCap: number;
  /** Wall-clock ms of the successful redemption, or `null` while pending. */
  consumedAt: number | null;
  /** Wall-clock ms of `pair revoke` cancelling this session before it was
   *  redeemed, or `null` while it stands. Its own field rather than a
   *  `consumedAt` stamp: a cancelled session was never redeemed, so nobody
   *  holds a certificate for it. */
  revokedAt?: number | null;
  /** The scope this code grants — see the header. */
  scope: PairingScope;
  /** The KB ids this code grants, or `null` for all of them. */
  kbIds?: string[] | null;
  /** Inert: the identity that created the session, once there is one. */
  created_by: string | null;
  /** Inert: the tenant the session belongs to, once there are tenants. */
  tenant_id: string | null;
  /** Inert: how that identity authenticated, once it authenticates. */
  auth_method: string | null;
};

/** What a caller must supply to mint a session; everything else is derived. */
export type NewPairingSession = {
  id: string;
  label: string;
  codeHash: string;
  /** Mint time. The caller's clock, never this module's. */
  now: number;
  /** Override the five-minute default, e.g. `pair new --ttl`. */
  ttlMs?: number;
  /** Override the cap of five. Present for tests and future policy, not for a
   *  caller looking for a way around the cap. */
  attemptCap?: number;
  /** The grant. Omitted is {@link DEFAULT_PAIRING_SCOPE} over every KB. */
  scope?: PairingScope;
  kbIds?: string[] | null;
};

/** Mint a pending session. The three inert fields default to `null` here. */
export function createPairingSession(input: NewPairingSession): PairingSession {
  const ttlMs = input.ttlMs ?? PAIRING_SESSION_TTL_MS;
  return {
    id: input.id,
    label: input.label,
    codeHash: input.codeHash,
    createdAt: input.now,
    expiresAt: input.now + ttlMs,
    attempts: 0,
    attemptCap: input.attemptCap ?? PAIRING_ATTEMPT_CAP,
    consumedAt: null,
    revokedAt: null,
    scope: input.scope ?? DEFAULT_PAIRING_SCOPE,
    kbIds: input.kbIds ?? null,
    created_by: null,
    tenant_id: null,
    auth_method: null,
  };
}

/**
 * Has the session outlived its TTL at `now`?
 *
 * Inclusive at the boundary — a session whose `expiresAt` is exactly `now` is
 * still live. One rule for "expiry" is worth more than the millisecond either
 * way.
 */
export function isExpired(session: PairingSession, now: number): boolean {
  return now > session.expiresAt;
}

/** Has the cap been reached? A dead session can never be redeemed again. */
export function isDead(session: PairingSession): boolean {
  return session.attempts >= session.attemptCap;
}

/** Has the session already been redeemed? Single use is single use. */
export function isConsumed(session: PairingSession): boolean {
  return session.consumedAt !== null;
}

/**
 * Has the operator taken this session back?
 *
 * `?? null` rather than `!== null`, because the field is optional: a session
 * persisted before it existed has no `revokedAt` at all, and `undefined !==
 * null` would read every one of them as revoked.
 */
export function isRevoked(session: PairingSession): boolean {
  return (session.revokedAt ?? null) !== null;
}

/** Why a session would refuse a redemption. Ordered by how it is checked. */
export type PairingRefusal = "expired" | "attempts-exhausted" | "already-consumed" | "revoked";

export type PairingRedeemability = { ok: true } | { ok: false; reason: PairingRefusal };

/**
 * May this session be redeemed at `now`? A typed reason rather than a boolean,
 * so the caller can audit-log *which* defence refused.
 *
 * The caller still has to check the code itself; this is only the state gate.
 */
export function canRedeem(session: PairingSession, now: number): PairingRedeemability {
  // Revocation is checked first because it is the operator's own decision, and
  // it is the answer the audit log should carry when several of these are true
  // at once — a session revoked and then left to expire was revoked.
  if (isRevoked(session)) return { ok: false, reason: "revoked" };
  if (isConsumed(session)) return { ok: false, reason: "already-consumed" };
  if (isDead(session)) return { ok: false, reason: "attempts-exhausted" };
  if (isExpired(session, now)) return { ok: false, reason: "expired" };
  return { ok: true };
}

/**
 * Record a wrong code. Returns the next session — the input is never mutated,
 * so a caller that fails to persist has not already changed its in-memory copy.
 *
 * The counter stops at the cap rather than climbing past it: past the cap the
 * session is dead and the exact number of attempts beyond it says nothing.
 */
export function recordWrongAttempt(session: PairingSession): PairingSession {
  return { ...session, attempts: Math.min(session.attempts + 1, session.attemptCap) };
}

export type PairingConsumeResult =
  | { ok: true; session: PairingSession }
  | { ok: false; reason: PairingRefusal };

/**
 * Redeem the session once, stamping `consumedAt`. A second consume is refused
 * with `already-consumed`, which is the whole of single use.
 */
export function consumePairingSession(
  session: PairingSession,
  now: number,
): PairingConsumeResult {
  const gate = canRedeem(session, now);
  if (!gate.ok) return gate;
  return { ok: true, session: { ...session, consumedAt: now } };
}
