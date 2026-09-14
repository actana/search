// The code digest, and the paired-client record the redemption writes.
//
// **Copied from the bottom half of actana/control
// `packages/shared/src/pairing-store.ts`** (its ADR 0034 D6). Control keeps its
// sessions in a JSON file and so keeps the digest beside the file that holds
// it; Search keeps its sessions in Postgres (`search.pairing_code`), so the
// pure half — the digest — lives here and the storage half lives in
// `packages/search/src/pairing/pairing-store.ts`. Nothing about the digest
// changed: split, not rewritten. ADR 0008 records the copy.
//
// `pairing-session.ts` carries a `codeHash` and deliberately says nothing about
// what hashes it. This is that decision, made once for the process that mints a
// session and the process that redeems one.

import { createHmac, timingSafeEqual } from "node:crypto";
import type { PairingScope } from "./pairing-session.ts";

/** Domain separator, so the derived key cannot collide with the bearer's use. */
const PAIRING_CODE_KEY_INFO = "actana:pairing-code:v1";

/**
 * Derive the key the code digest is taken under, from the instance's bearer
 * secret.
 *
 * A bare `sha256(code)` would not do. The code is eight characters from a
 * 31-character alphabet — around 2^39.6 possibilities — which is a number of
 * hashes an attacker who has copied the session table can simply enumerate. A
 * digest keyed by a secret that is *not* in that table cannot be attacked that
 * way at all without the material file too.
 *
 * The bearer secret is reused rather than a second secret invented, because a
 * second secret is a second thing to mint, persist and lose; the separator
 * above is what keeps this from being the same computation the bearer does, so
 * neither use is an oracle for the other.
 *
 * **The separator string is Control's, unchanged.** It is not on the wire and
 * it is not portable between instances — each derives from its own secret — but
 * keeping it identical means the lift in TASK-015 is a move rather than a
 * migration.
 */
export function derivePairingCodeKey(bearerSecret: string): Buffer {
  return createHmac("sha256", bearerSecret).update(PAIRING_CODE_KEY_INFO).digest();
}

/**
 * The digest stored in a session's `codeHash`.
 *
 * Bound to the session id as well as the code, which is session binding at the
 * cryptographic layer rather than only at the lookup: a digest lifted from one
 * session's row cannot be matched against another session, even by something
 * that can write that table.
 *
 * `code` must be the canonical form from `normalisePairingCode` — the hash of
 * `abcd-efgh` and of `ABCDEFGH` are different strings, and the endpoint
 * canonicalises before it gets here for exactly that reason.
 */
export function hashPairingCode(opts: { key: Buffer; sessionId: string; code: string }): string {
  return createHmac("sha256", opts.key).update(`${opts.sessionId}:${opts.code}`).digest("hex");
}

/**
 * Compare a candidate digest against a stored one in constant time.
 *
 * The comparison is on the *digests*, not the codes, so a timing signal here
 * would leak the digest rather than the code — but a digest is enough to
 * redeem, being what the store compares, so it gets `timingSafeEqual` all the
 * same.
 */
export function pairingCodeMatches(storedHash: string, candidateHash: string): boolean {
  const stored = Buffer.from(storedHash, "hex");
  const candidate = Buffer.from(candidateHash, "hex");
  if (stored.length === 0 || stored.length !== candidate.length) return false;
  try {
    return timingSafeEqual(stored, candidate);
  } catch {
    return false;
  }
}

/**
 * A client this instance has paired — one row per issued certificate, and the
 * row `search.paired_client` holds.
 *
 * Control's `PairedClient` plus the two fields ADR 0003 adds: the scope the
 * code was minted with and the KB ids it named. The certificate's serial is
 * here for the same reason it is there — the serial is the only thing that
 * names one issuance unambiguously, where a label is whatever the operator
 * typed twice.
 */
export type PairedClient = {
  /** The row's own id. Control has none; Search's table is keyed by it. */
  id: string;
  /** The certificate serial, hex. The identity of this pairing. */
  certSerial: string;
  /** SHA-256 of the issued certificate, for display and for revocation lists. */
  certFingerprint: string;
  /** The certificate subject as issued, e.g. `CN=laptop`. */
  certSubject: string;
  /** The operator's name for the machine, carried over from the session. */
  label: string;
  /** Where the client runs. Reported by the client, stored, never trusted. */
  platform: string | null;
  /** The session this client redeemed. Kept so an audit can join the two. */
  sessionId: string;
  /** Wall-clock ms of the successful redemption. */
  pairedAt: number;
  /** Wall-clock ms the issued certificate stops verifying. */
  certNotAfter: number;
  /** Wall-clock ms of `pair revoke`, or `null` while the pairing stands. */
  revokedAt: number | null;
  /** What this client may do — copied from the session, never from the request. */
  scope: PairingScope;
  /** The KB ids it may touch, or `null` for every KB it owns. */
  kbIds: string[] | null;
  /** Inert: copied from the session, for a later identity layer. */
  created_by: string | null;
  /** Inert. */
  tenant_id: string | null;
  /** Inert. */
  auth_method: string | null;
};
