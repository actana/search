/**
 * The pairing store, against a real Postgres.
 *
 * Gated on `SEARCH_TEST_DATABASE_URL`: without it the suite skips. What it
 * asserts is the half of Control's `pairing-store.test.ts` that changed when
 * the medium did — that a session round-trips through two tables and comes back
 * the shape the pure rules module expects, and that `consume` is decided by the
 * database rather than by whoever wrote last.
 */

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPairingSession,
  PAIRING_ATTEMPT_CAP,
  type PairingSession,
} from "@actana/search-shared/pairing/pairing-session";
import type { PairedClient } from "@actana/search-shared/pairing/pairing-code-digest";
import { resetConfig } from "../config.ts";
import { createDatabase, type SearchDatabase } from "../db/client.ts";
import { runMigrations, SEARCH_SCHEMA } from "../db/migrate.ts";
import { pairedClient as pairedClientTable } from "../db/schema.ts";
import { LAST_SEEN_THROTTLE_MS, SearchPairingStore } from "./pairing-store.ts";

const url = process.env.SEARCH_TEST_DATABASE_URL;
if (url) {
  process.env.SEARCH_DATABASE_URL = url;
  resetConfig();
}

let counter = 0;
const uniq = (prefix: string): string => `${prefix}_${Date.now().toString(36)}_${counter++}`;

/** A unique certificate serial in the shape one actually has: hex. */
const uniqSerial = (): string =>
  `${Date.now().toString(16)}${(counter++).toString(16).padStart(4, "0")}`.toUpperCase();

describe.skipIf(!url)("the pairing store, through Postgres", () => {
  let db: SearchDatabase;
  let close: () => Promise<void>;
  let store: SearchPairingStore;

  beforeAll(async () => {
    const created = createDatabase(url!, { max: 4 });
    db = created.db;
    close = created.close;
    await runMigrations({ url: url! });
    store = new SearchPairingStore(db);
  });

  afterAll(async () => {
    await db.execute(sql.raw(`DELETE FROM "${SEARCH_SCHEMA}"."pairing_code"`));
    await db.execute(sql.raw(`DELETE FROM "${SEARCH_SCHEMA}"."paired_client"`));
    await close();
  });

  const mint = (overrides: Partial<PairingSession> = {}): PairingSession => ({
    ...createPairingSession({
      id: uniq("ps"),
      label: "actanastudio",
      codeHash: "deadbeef",
      now: Date.now(),
      scope: "write",
      kbIds: ["kb_1", "kb_2"],
    }),
    ...overrides,
  });

  it("round-trips a session, grant and all", async () => {
    const session = mint();
    await store.createSession(session);
    const read = await store.getSession(session.id);
    expect(read).toEqual(session);
  });

  it("does not store the code — only a digest bound to the session", async () => {
    const session = mint({ codeHash: "a-digest-not-a-code" });
    await store.createSession(session);
    const columns = (await db.execute(
      sql`SELECT column_name FROM information_schema.columns WHERE table_schema = ${SEARCH_SCHEMA} AND table_name = 'pairing_code'`,
    )) as unknown as Array<{ column_name: string }>;
    const names = (Array.isArray(columns) ? columns : []).map((c) => c.column_name);
    expect(names).toContain("code_hash");
    expect(names).not.toContain("code");
  });

  it("counts wrong attempts and stops at the cap", async () => {
    const session = mint();
    await store.createSession(session);
    for (let i = 1; i <= PAIRING_ATTEMPT_CAP + 2; i++) {
      const after = await store.recordWrongAttempt(session.id);
      expect(after?.attempts).toBe(Math.min(i, PAIRING_ATTEMPT_CAP));
    }
  });

  it("answers `null` for a wrong attempt against a session that is not there", async () => {
    expect(await store.recordWrongAttempt("ps_nobody_minted")).toBeNull();
  });

  it("lets only one of two simultaneous consumes win — the database decides", async () => {
    const session = mint();
    await store.createSession(session);
    const now = Date.now();
    const [a, b] = await Promise.all([store.consume(session.id, now), store.consume(session.id, now)]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    const loser = a.ok ? b : a;
    expect(loser).toEqual({ ok: false, reason: "already-consumed" });
  });

  it("refuses to consume an expired session, and says which defence refused", async () => {
    const session = mint({ expiresAt: Date.now() - 1000 });
    await store.createSession(session);
    expect(await store.consume(session.id, Date.now())).toEqual({ ok: false, reason: "expired" });
  });

  it("refuses to consume a session the operator cancelled", async () => {
    const session = mint();
    await store.createSession(session);
    await store.cancelSession(session.id, Date.now());
    expect(await store.consume(session.id, Date.now())).toEqual({ ok: false, reason: "revoked" });
  });

  it("refuses to consume a session at its attempt cap", async () => {
    const session = mint({ attempts: PAIRING_ATTEMPT_CAP });
    await store.createSession(session);
    expect(await store.consume(session.id, Date.now())).toEqual({
      ok: false,
      reason: "attempts-exhausted",
    });
  });

  it("answers `unknown` for a session id nobody minted, as a refusal does", async () => {
    expect(await store.consume("ps_nobody_minted", Date.now())).toEqual({
      ok: false,
      reason: "unknown",
    });
  });

  it("finds the row by the serial a socket reports, with no fingerprint to fall back on", async () => {
    // The bug this is here for: `@peculiar/x509` issues `03ab…` and Node's
    // `getPeerCertificate().serialNumber` reports `3AB…`, so a row stored as
    // issued is never found by the serial the connection actually carries. It
    // did not *fail* — every request quietly resolved through the fingerprint
    // branch — which is why the fingerprint is passed as `null` here.
    const client: PairedClient = {
      id: uniq("pc"),
      // As `signClientCsr` hands it over: lower case, leading zero kept.
      certSerial: "03ab9f00112233445566778899aabbcc",
      certFingerprint: "11:22:33",
      certSubject: "CN=studio",
      label: "studio",
      platform: null,
      sessionId: "",
      pairedAt: Date.now(),
      certNotAfter: Date.now() + 86_400_000,
      revokedAt: null,
      scope: "read",
      kbIds: null,
      created_by: null,
      tenant_id: null,
      auth_method: null,
    };
    await store.recordClient(client);

    // As Node reports it off the socket: upper case, leading zero dropped.
    const found = await store.findClientByCertificate({
      serial: "3AB9F00112233445566778899AABBCC",
      fingerprint: null,
    });
    expect(found?.id).toBe(client.id);
    // And the stored spelling is the canonical one, so the revocation sweep and
    // the socket agree without either of them normalising again.
    expect(found?.certSerial).toBe("3AB9F00112233445566778899AABBCC");
    expect(await store.revokedCertSerials()).not.toContain("03ab9f00112233445566778899aabbcc");
  });

  it("writes `last_seen_at` once a minute, not once a request", async () => {
    const client: PairedClient = {
      id: uniq("pc"),
      certSerial: uniqSerial(),
      certFingerprint: "99:88:77",
      certSubject: "CN=chatty",
      label: "chatty",
      platform: null,
      sessionId: "",
      pairedAt: Date.now(),
      certNotAfter: Date.now() + 86_400_000,
      revokedAt: null,
      scope: "read",
      kbIds: null,
      created_by: null,
      tenant_id: null,
      auth_method: null,
    };
    await store.recordClient(client);

    // Read the column rather than the mapped row: the stamps are compared with
    // each other, never with a wall-clock number, because `last_seen_at` is a
    // `timestamp without time zone` and the driver hands it back through the
    // local offset. What is under test is whether a write happened, not when.
    const stamp = async (): Promise<number | null> => {
      const rows = await db.execute(
        sql`SELECT last_seen_at FROM ${pairedClientTable} WHERE id = ${client.id}`,
      );
      const row = (Array.isArray(rows) ? rows[0] : undefined) as { last_seen_at?: Date | null } | undefined;
      return row?.last_seen_at ? new Date(row.last_seen_at).getTime() : null;
    };

    const at = Date.now();
    await store.touchLastSeen(client.id, at);
    const first = await stamp();
    expect(first).not.toBeNull();

    // A second touch inside the window writes nothing at all.
    await store.touchLastSeen(client.id, at + 1_000);
    expect(await stamp()).toBe(first);

    // Past the window it writes again, and the stamp moves by the elapsed time.
    await store.touchLastSeen(client.id, at + LAST_SEEN_THROTTLE_MS + 1);
    expect(await stamp()).toBe(first! + LAST_SEEN_THROTTLE_MS + 1);
  });

  it("records a client, binds it to its session, and finds it by either spelling", async () => {
    const session = mint();
    await store.createSession(session);
    const client: PairedClient = {
      id: uniq("pc"),
      certSerial: "0A1B2C",
      certFingerprint: "AA:BB:CC",
      certSubject: "CN=actanastudio",
      label: "actanastudio",
      platform: "linux",
      sessionId: session.id,
      pairedAt: Date.now(),
      certNotAfter: Date.now() + 86_400_000,
      revokedAt: null,
      scope: "write",
      kbIds: ["kb_1"],
      created_by: null,
      tenant_id: null,
      auth_method: null,
    };
    await store.recordClient(client);

    expect((await store.findClientByCertificate({ serial: "0A1B2C" }))?.id).toBe(client.id);
    expect((await store.findClientByCertificate({ fingerprint: "AA:BB:CC" }))?.id).toBe(client.id);
    expect((await store.findClientByCertificate({ serial: null, fingerprint: null }))).toBeNull();

    const read = await store.getClient(client.id);
    expect(read?.scope).toBe("write");
    expect(read?.kbIds).toEqual(["kb_1"]);
    expect(read?.sessionId).toBe(session.id);
  });

  it("revokes by stamp rather than by delete, and reports the serial", async () => {
    const client: PairedClient = {
      id: uniq("pc"),
      certSerial: uniqSerial(),
      certFingerprint: "DD:EE:FF",
      certSubject: "CN=laptop",
      label: "laptop",
      platform: null,
      sessionId: "",
      pairedAt: Date.now(),
      certNotAfter: Date.now() + 86_400_000,
      revokedAt: null,
      scope: "read",
      kbIds: null,
      created_by: null,
      tenant_id: null,
      auth_method: null,
    };
    await store.recordClient(client);
    const revoked = await store.revokeClient(client.id, Date.now());
    expect(revoked?.revokedAt).not.toBeNull();
    expect(await store.revokedCertSerials()).toContain(client.certSerial);
    // The row is still there — a delete would take the audit trail with it.
    expect(await store.getClient(client.id)).not.toBeNull();
    // Revoking twice is idempotent and keeps the first stamp.
    const again = await store.revokeClient(client.id, Date.now() + 5000);
    expect(again?.revokedAt).toBe(revoked?.revokedAt);
  });

  it("prunes sessions that settled a day ago, and keeps the ones that did not", async () => {
    const old = mint({ expiresAt: Date.now() - 48 * 60 * 60 * 1000 });
    const fresh = mint();
    await store.createSession(old);
    await store.createSession(fresh);
    await store.prune(Date.now());
    expect(await store.getSession(old.id)).toBeNull();
    expect(await store.getSession(fresh.id)).not.toBeNull();
  });
});
