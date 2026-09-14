// Where Search keeps its pending pairing sessions and the clients it has
// already paired.
//
// **The storage half of actana/control's `packages/shared/src/pairing-store.ts`**
// (ADR 0008). The rules did not move — they are in
// `@actana/search-shared/pairing/pairing-session` and
// `.../pairing-code-digest`, copied verbatim — and neither did the
// read-modify-write order. What changed is the medium: Control keeps one JSON
// file that a daemon and a one-shot CLI both open, and Search keeps two
// Postgres tables because Search may be more than one process and a code
// redeemed against one of them has to be spent for all of them.
//
// **That swap makes one of Control's stated limits go away, and it is worth
// naming.** Control's own header concedes that two processes racing on the file
// can lose a write, and that a lost `revokedAt` fails *open*. Here `consume`
// is a single conditional `UPDATE … WHERE consumed_at IS NULL … RETURNING`, so
// the race is decided by Postgres rather than by whose `writeFileSync` landed
// last, and a revocation is a row nobody can lose. ADR 0034 D6 asks that the
// code be consumed before the certificate is signed; this keeps that and makes
// it hold across processes as well as within one.
//
// Everything is addressed by session id, never by code: the digest is bound to
// the session (`hashPairingCode`), so there is no query here that searches for
// a session a code might fit — the oracle ADR 0034 D5 exists to deny.

import { and, desc, eq, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import {
  canRedeem,
  isPairingScope,
  recordWrongAttempt as nextAttempt,
  type PairingRefusal,
  type PairingScope,
  type PairingSession,
} from "@actana/search-shared/pairing/pairing-session";
import { normaliseCertSerial } from "@actana/search-shared/pairing/cert-material";
import type { PairedClient } from "@actana/search-shared/pairing/pairing-code-digest";
import type { SearchDatabase } from "../db/client.ts";
import { pairedClient as pairedClientTable, pairingCode } from "../db/schema.ts";

/** How long a settled session stays on file before it is pruned. A day. */
export const PAIRING_SESSION_RETENTION_MS = 24 * 60 * 60 * 1000;

/** How often one client's `last_seen_at` is written. See `touchLastSeen`. */
export const LAST_SEEN_THROTTLE_MS = 60_000;

/**
 * How many clients the throttle remembers before it forgets all of them.
 *
 * A bound rather than a policy: the keys are paired-client ids, which only a
 * successful pairing can create, so this is not a surface anybody can grow —
 * it is here so that an instance with a very large number of clients cannot
 * accumulate a map nothing prunes. Clearing costs one extra write per client.
 */
const MAX_TRACKED_LAST_SEEN = 10_000;

export type PairingConsumeOutcome =
  | { ok: true; session: PairingSession }
  | { ok: false; reason: PairingRefusal | "unknown" };

/**
 * The store of sessions and paired clients, as the endpoint uses it.
 *
 * A port rather than the class, so the endpoint can be exercised against an
 * in-memory double — {@link SearchPairingStore} satisfies it structurally, and
 * that is what the service passes.
 */
export interface PairingSessionPort {
  /** The session with this id, or `null`. */
  getSession(id: string): Promise<PairingSession | null>;
  /** Count a wrong code. Returns the session as it now stands, or `null`. */
  recordWrongAttempt(id: string): Promise<PairingSession | null>;
  /** Mark consumed if it may be — the step that decides who wins a race. */
  consume(id: string, now: number): Promise<PairingConsumeOutcome>;
  /** Persist the identity of a client that just paired. */
  recordClient(client: PairedClient): Promise<void>;
}

type SessionRow = typeof pairingCode.$inferSelect;
type ClientRow = typeof pairedClientTable.$inferSelect;

/** A `pairing_code` row as the rules module sees it. */
export function sessionFromRow(row: SessionRow): PairingSession {
  return {
    id: row.id,
    label: row.label,
    codeHash: row.codeHash,
    createdAt: row.createdAt.getTime(),
    expiresAt: row.expiresAt.getTime(),
    attempts: row.attempts,
    attemptCap: row.attemptCap,
    consumedAt: row.consumedAt ? row.consumedAt.getTime() : null,
    revokedAt: row.revokedAt ? row.revokedAt.getTime() : null,
    scope: readScope(row.scope),
    kbIds: readKbIds(row.kbIds),
    created_by: row.createdBy,
    tenant_id: row.tenantId,
    auth_method: row.authMethod,
  };
}

/** A `paired_client` row as the endpoint and the revocation sweep see it. */
export function clientFromRow(row: ClientRow): PairedClient {
  return {
    id: row.id,
    certSerial: row.certSerial,
    certFingerprint: row.certFingerprint,
    certSubject: row.certSubject,
    label: row.label,
    platform: row.platform,
    sessionId: row.sessionId ?? "",
    pairedAt: row.createdAt.getTime(),
    certNotAfter: row.certNotAfter ? row.certNotAfter.getTime() : 0,
    revokedAt: row.revokedAt ? row.revokedAt.getTime() : null,
    scope: readScope(row.scope),
    kbIds: readKbIds(row.kbIds),
    created_by: null,
    tenant_id: null,
    auth_method: null,
  };
}

/**
 * A scope read back out of the database.
 *
 * Anything the column holds that is not one of the three is read as `read`,
 * the least of them. A row hand-edited to `superuser` must not become one.
 */
function readScope(value: unknown): PairingScope {
  return isPairingScope(value) ? value : "read";
}

/** A KB allow-list read back. Anything that is not a list of strings is `null`. */
function readKbIds(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const ids = value.filter((id): id is string => typeof id === "string");
  return ids.length > 0 ? ids : null;
}

/** The Postgres-backed pairing store. */
export class SearchPairingStore implements PairingSessionPort {
  private readonly db: SearchDatabase;
  /** Client id → when `last_seen_at` was last written. See `touchLastSeen`. */
  private readonly lastSeenWrites = new Map<string, number>();

  constructor(db: SearchDatabase) {
    this.db = db;
  }

  /** Add a freshly minted session, and prune the ones that settled a day ago. */
  async createSession(session: PairingSession, now: number = Date.now()): Promise<void> {
    await this.db.insert(pairingCode).values({
      id: session.id,
      label: session.label,
      codeHash: session.codeHash,
      createdAt: new Date(session.createdAt),
      expiresAt: new Date(session.expiresAt),
      attempts: session.attempts,
      attemptCap: session.attemptCap,
      consumedAt: session.consumedAt === null ? null : new Date(session.consumedAt),
      revokedAt: session.revokedAt ? new Date(session.revokedAt) : null,
      scope: session.scope,
      kbIds: session.kbIds ?? null,
      createdBy: session.created_by,
      tenantId: session.tenant_id,
      authMethod: session.auth_method,
    });
    await this.prune(now);
  }

  /** One session by id, or `null`. */
  async getSession(id: string): Promise<PairingSession | null> {
    const rows = await this.db.select().from(pairingCode).where(eq(pairingCode.id, id)).limit(1);
    return rows[0] ? sessionFromRow(rows[0]) : null;
  }

  /** Every session still on file, newest first. */
  async listSessions(): Promise<PairingSession[]> {
    const rows = await this.db.select().from(pairingCode).orderBy(desc(pairingCode.createdAt));
    return rows.map(sessionFromRow);
  }

  /**
   * Count a wrong code against a session and persist the count.
   *
   * Returns the session as it now stands — at the cap, it is dead and no later
   * redemption can revive it. Returns `null` for a session that is not there,
   * which the caller must treat exactly as it treats a refusal, so that a guess
   * cannot be used to learn whether a session id exists.
   *
   * `least(attempts + 1, attempt_cap)` in SQL rather than a read, a bump and a
   * write: the counter is the guessing bound, and two guesses arriving together
   * must count as two.
   */
  async recordWrongAttempt(id: string): Promise<PairingSession | null> {
    const rows = await this.db
      .update(pairingCode)
      .set({ attempts: sql`least(${pairingCode.attempts} + 1, ${pairingCode.attemptCap})` })
      .where(eq(pairingCode.id, id))
      .returning();
    const row = rows[0];
    if (!row) return null;
    // Belt and braces: the SQL above already clamps, and this is the same
    // clamp the rules module applies, so a database that did it differently
    // cannot produce an `attempts > attemptCap` state for later readers.
    const session = sessionFromRow(row);
    return session.attempts > session.attemptCap ? nextAttempt({ ...session, attempts: session.attemptCap }) : session;
  }

  /**
   * Mark a session consumed, or say why it cannot be.
   *
   * **This is the step that issues** (ADR 0034 D6). The endpoint calls it
   * *before* it signs anything, so the window in which two redemptions could
   * both be signing is closed by the write below rather than by the certificate
   * that follows it. A signature that then fails leaves the session consumed
   * and the operator mints another code: that is the safe direction to fail,
   * where the other one hands two clients a certificate for one code.
   *
   * One statement, and every condition the rules impose is in its `WHERE`. A
   * second redemption arriving in the same millisecond updates nothing, falls
   * through to the re-read below, and is told `already-consumed` — the same
   * answer a replay a week later gets.
   */
  async consume(id: string, now: number): Promise<PairingConsumeOutcome> {
    const at = new Date(now);
    const claimed = await this.db
      .update(pairingCode)
      .set({ consumedAt: at })
      .where(
        and(
          eq(pairingCode.id, id),
          isNull(pairingCode.consumedAt),
          isNull(pairingCode.revokedAt),
          lt(pairingCode.attempts, pairingCode.attemptCap),
          // `toISOString()` and an explicit cast, not a `Date`: a raw `sql`
          // fragment sends its parameters through the driver without drizzle's
          // column mapping, and `postgres` will not bind a `Date` on its own.
          sql`${pairingCode.expiresAt} >= ${at.toISOString()}::timestamp`,
        ),
      )
      .returning();
    if (claimed[0]) return { ok: true, session: sessionFromRow(claimed[0]) };

    // Nothing was claimed. Re-read to say *which* defence refused — for the
    // audit log only; the wire answer is one refusal whatever this says.
    const session = await this.getSession(id);
    if (!session) return { ok: false, reason: "unknown" };
    const gate = canRedeem(session, now);
    return gate.ok ? { ok: false, reason: "already-consumed" } : { ok: false, reason: gate.reason };
  }

  /**
   * Cancel a pending session before anybody redeems it.
   *
   * Returns the cancelled row, the row unchanged when it was already cancelled
   * or already redeemed, or `null` when there is no such session. The stamp is
   * what stops the redemption: `canRedeem` checks `revokedAt` first, so the
   * endpoint's next look at this session refuses it with the same body every
   * other refusal gets.
   */
  async cancelSession(id: string, now: number): Promise<PairingSession | null> {
    const rows = await this.db
      .update(pairingCode)
      .set({ revokedAt: new Date(now) })
      .where(and(eq(pairingCode.id, id), isNull(pairingCode.revokedAt), isNull(pairingCode.consumedAt)))
      .returning();
    if (rows[0]) return sessionFromRow(rows[0]);
    return this.getSession(id);
  }

  /**
   * Record an issued client identity, and bind it to the session it spent.
   *
   * **The serial is normalised on the way in**, and that is the only reason a
   * later request finds this row by the serial its socket reports.
   * `@peculiar/x509` issues `03ab…` and Node reports `3AB…`; stored as issued,
   * the `eq(cert_serial, …)` lookup in {@link findClientByCertificate} would
   * never match and every request would resolve through the fingerprint branch
   * instead — working, and not the thing the code says it does.
   */
  async recordClient(client: PairedClient): Promise<void> {
    await this.db
      .insert(pairedClientTable)
      .values({
        id: client.id,
        label: client.label,
        platform: client.platform,
        certSerial: normaliseCertSerial(client.certSerial),
        certFingerprint: client.certFingerprint,
        certSubject: client.certSubject,
        certNotAfter: new Date(client.certNotAfter),
        sessionId: client.sessionId,
        scope: client.scope,
        kbIds: client.kbIds,
        status: client.revokedAt === null ? "active" : "revoked",
        revokedAt: client.revokedAt === null ? null : new Date(client.revokedAt),
        createdAt: new Date(client.pairedAt),
      })
      .onConflictDoNothing({ target: pairedClientTable.id });
    if (client.sessionId) {
      await this.db
        .update(pairingCode)
        .set({ pairedClientId: client.id })
        .where(eq(pairingCode.id, client.sessionId));
    }
  }

  /** Every paired client, newest first. What `pair ls` reads. */
  async listClients(): Promise<PairedClient[]> {
    const rows = await this.db
      .select()
      .from(pairedClientTable)
      .orderBy(desc(pairedClientTable.createdAt));
    return rows.map(clientFromRow);
  }

  /** One client by id, or `null`. */
  async getClient(id: string): Promise<PairedClient | null> {
    const rows = await this.db
      .select()
      .from(pairedClientTable)
      .where(eq(pairedClientTable.id, id))
      .limit(1);
    return rows[0] ? clientFromRow(rows[0]) : null;
  }

  /**
   * The client that presented this certificate, by serial or by fingerprint.
   *
   * Both, because the two arrive from different places — Node reports a serial
   * off the socket, and an operator or a revocation list has a fingerprint —
   * and a client that could be found by one and not the other would be
   * revocable by one and not the other.
   *
   * The serial is put through {@link normaliseCertSerial} on both sides of the
   * comparison: here, and at {@link recordClient} where the row was written.
   * The serial is the primary answer and the fingerprint is the fallback; a
   * mismatch in spelling would demote the primary to dead code without failing
   * anything.
   */
  async findClientByCertificate(opts: {
    serial?: string | null;
    fingerprint?: string | null;
  }): Promise<PairedClient | null> {
    const raw = (opts.serial ?? "").trim();
    const serial = raw === "" ? "" : normaliseCertSerial(raw);
    const fingerprint = (opts.fingerprint ?? "").trim();
    if (serial === "" && fingerprint === "") return null;
    const clauses = [];
    if (serial !== "") clauses.push(eq(pairedClientTable.certSerial, serial));
    if (fingerprint !== "") clauses.push(eq(pairedClientTable.certFingerprint, fingerprint));
    const rows = await this.db
      .select()
      .from(pairedClientTable)
      .where(clauses.length === 1 ? clauses[0] : or(...clauses))
      .limit(1);
    return rows[0] ? clientFromRow(rows[0]) : null;
  }

  /**
   * Revoke one pairing by client id. Returns the revoked row, or `null` when no
   * such client is paired here.
   *
   * Revoking is a stamp, not a delete: a row that vanished would take the audit
   * trail of the pairing with it, and `pair revoke` has to be able to say what
   * it revoked.
   */
  async revokeClient(id: string, now: number): Promise<PairedClient | null> {
    const rows = await this.db
      .update(pairedClientTable)
      .set({ revokedAt: new Date(now), status: "revoked" })
      .where(and(eq(pairedClientTable.id, id), isNull(pairedClientTable.revokedAt)))
      .returning();
    if (rows[0]) return clientFromRow(rows[0]);
    return this.getClient(id);
  }

  /**
   * Note that this client was seen. Best effort; never on the refusal path.
   *
   * **Throttled to one write a minute per client**, because it is on the hot
   * path: without it, a client polling a query route turns every read into a
   * read and a write, and `last_seen_at` is a field an operator glances at
   * rather than a measurement anyone reasons with. The window is in memory and
   * per process, so several processes each write once a minute — which is
   * still two orders of magnitude fewer writes than one per request, and the
   * column is no less true for it.
   */
  async touchLastSeen(id: string, now: number = Date.now()): Promise<void> {
    const last = this.lastSeenWrites.get(id) ?? 0;
    if (now - last < LAST_SEEN_THROTTLE_MS) return;
    // Recorded before the write, not after: two concurrent requests for one
    // client should produce one write, and the await is where the second one
    // would otherwise slip past the check.
    this.lastSeenWrites.set(id, now);
    if (this.lastSeenWrites.size > MAX_TRACKED_LAST_SEEN) this.lastSeenWrites.clear();
    await this.db
      .update(pairedClientTable)
      .set({ lastSeenAt: new Date(now) })
      .where(eq(pairedClientTable.id, id));
  }

  /**
   * Every revoked certificate serial.
   *
   * The revocation sweep's one read. It **throws** rather than answering with
   * an empty list when the database cannot be reached, and that is the whole
   * contract: "this instance has revoked nobody" and "this instance cannot tell
   * you who it revoked" must never be the same answer (ADR 0034 D10).
   */
  async revokedCertSerials(): Promise<string[]> {
    const rows = await this.db
      .select({ certSerial: pairedClientTable.certSerial })
      .from(pairedClientTable)
      .where(isNotNull(pairedClientTable.revokedAt));
    return rows.map((row) => row.certSerial);
  }

  /**
   * Drop sessions that stopped being interesting a day ago.
   *
   * Expired and consumed sessions are kept for a day rather than deleted on the
   * spot, because they are what an operator reads when asking why a pairing
   * failed an hour ago. The refusal a pruned session produces is byte-identical
   * to the one it produced while it was still there, so pruning cannot change
   * what any client observes.
   */
  async prune(now: number = Date.now()): Promise<void> {
    const cutoff = new Date(now - PAIRING_SESSION_RETENTION_MS);
    await this.db
      .delete(pairingCode)
      .where(
        sql`coalesce(${pairingCode.consumedAt}, ${pairingCode.expiresAt}) < ${cutoff.toISOString()}::timestamp`,
      );
  }
}
