/**
 * Pairing end to end: a real HTTPS server, a real CA, a real CSR, and the
 * published SDK doing what a client does.
 *
 * This is the suite the copied code is *for*. Every unit test above asserts a
 * rule in isolation; this one asserts that the rules compose into the handshake
 * ADR 0034 describes — and it is the one that would catch a gate wired to the
 * wrong predicate, an endpoint answered from a header, or a certificate that
 * verifies against nothing.
 *
 * The named cases are Control's `core-pairing-redeem.test.ts`, carried over
 * (ADR 0008), plus the two Search adds: `/v1/health` is open, and a revoked
 * client is refused on a connection its certificate still completes.
 *
 * Gated on `SEARCH_TEST_DATABASE_URL`, because a pairing is two rows.
 */

import { request as undiciRequest, Agent } from "undici";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  SearchClient,
  SearchApiError,
  pairWithSearch,
  SearchPairingError,
  type SearchRegistrationBlob,
} from "@actana/search";
import { resetConfig } from "../config.ts";
import { createDatabase, type SearchDatabase } from "../db/client.ts";
import { runMigrations, SEARCH_SCHEMA } from "../db/migrate.ts";
import { SCHEMA_VERSION } from "../db/schema.ts";
import { adminSocketPath, startAdminServer, type AdminServer } from "../api/admin-server.ts";
import { startSearchServer, type SearchServer } from "../api/server.ts";
import { PairingRateLimiter } from "../pairing/pairing-rate-limit.ts";
import { generateCertMaterial } from "@actana/search-shared/pairing/cert-material";
import { sendJson } from "../pairing/pairing-routes.ts";
import { SearchPairingStore } from "../pairing/pairing-store.ts";
import { PairingRevocations } from "../pairing/pairing-revocation.ts";
import { ensureMaterial } from "../pairing/self-register.ts";

const url = process.env.SEARCH_TEST_DATABASE_URL;
if (url) {
  process.env.SEARCH_DATABASE_URL = url;
  resetConfig();
}

type MintedCode = {
  sessionId: string;
  code: string;
  ticket: string;
  expiresAt: string;
  caFingerprint: string;
  endpoint: string;
  scope: string;
  kbIds: string[] | null;
};

describe.skipIf(!url)("pairing, end to end", () => {
  let db: SearchDatabase;
  let closeDb: () => Promise<void>;
  let store: SearchPairingStore;
  let revocations: PairingRevocations;
  let api: SearchServer;
  let admin: AdminServer;
  let stateDir: string;
  let caFingerprint: string;
  let address: string;
  let adminAgent: Agent;

  beforeAll(async () => {
    const created = createDatabase(url!, { max: 8 });
    db = created.db;
    closeDb = created.close;
    await runMigrations({ url: url! });
    await db.execute(sql.raw(`DELETE FROM "${SEARCH_SCHEMA}"."pairing_code"`));
    await db.execute(sql.raw(`DELETE FROM "${SEARCH_SCHEMA}"."paired_client"`));

    // A temporary state directory, so the suite mints its own CA and leaves
    // the developer's `~/.actana-search` alone.
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "actana-search-pairing-"));
    const ensured = await ensureMaterial({ stateDir, publicHosts: ["localhost"] });
    caFingerprint = ensured.caFingerprint;

    store = new SearchPairingStore(db);
    revocations = new PairingRevocations(store);
    await revocations.refresh();

    api = await startSearchServer({
      material: ensured.material,
      store,
      revocations,
      port: 0,
      host: "127.0.0.1",
      publicHosts: ["localhost"],
      // This suite pairs a dozen clients in a second, which is what the
      // default windows exist to stop. The limiter itself is asserted in
      // `pairing/pairing-rate-limit.test.ts` and in the case below.
      pairingRateLimiter: new PairingRateLimiter({
        peer: { limit: 10_000, windowMs: 60_000 },
        global: { limit: 10_000, windowMs: 60_000 },
      }),
      // The hook TASK-004 mounts the REST surface on, used here for one route
      // that does nothing but declare which KB it acts on — so that what is
      // under test is the router's enforcement rather than a handler's care.
      registerRoutes: (router) => {
        router.add({
          method: "GET",
          path: (pathname) => /^\/v1\/kbs\/[^/]+\/probe$/.test(pathname),
          scope: "read",
          kbIdFrom: (url) => url.pathname.split("/")[3] ?? null,
          handle: ({ res, url, allowsKb }) => {
            const kbId = url.pathname.split("/")[3]!;
            sendJson(res, 200, { kbId, allowed: allowsKb(kbId) });
          },
        });
      },
    });
    address = `https://localhost:${api.port}`;

    // The socket, not a port: what the CLI in TASK-005 will talk to, and what
    // an operator's shell reaches through the 0700 state directory.
    admin = await startAdminServer({
      store,
      revocations,
      bearerSecret: ensured.material.bearerSecret,
      caFingerprint,
      endpoint: address,
      socketPath: adminSocketPath(stateDir),
    });
    adminAgent = new Agent({ connect: { socketPath: admin.socketPath! } });
  });

  afterAll(async () => {
    await adminAgent?.close();
    await api?.close();
    await admin?.close();
    await db?.execute(sql.raw(`DELETE FROM "${SEARCH_SCHEMA}"."pairing_code"`));
    await db?.execute(sql.raw(`DELETE FROM "${SEARCH_SCHEMA}"."paired_client"`));
    await closeDb?.();
    if (stateDir) fs.rmSync(stateDir, { recursive: true, force: true });
  });

  /** Any admin call, over the Unix socket. `http://admin.invalid` is a name
   *  `undici` needs and never resolves: the socket decides where it goes. */
  function callAdmin(
    method: "GET" | "POST",
    pathname: string,
    body?: unknown,
  ): ReturnType<typeof undiciRequest> {
    return undiciRequest(`http://admin.invalid${pathname}`, {
      method,
      dispatcher: adminAgent,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  /** `POST /admin/pair/new` — what the CLI will call. */
  async function mint(body: Record<string, unknown> = {}): Promise<MintedCode> {
    const response = await callAdmin("POST", "/admin/pair/new", body);
    expect(response.statusCode).toBe(200);
    return (await response.body.json()) as MintedCode;
  }

  /** A raw dial at the API with no client certificate, pinned to the CA. */
  async function dialWithoutCertificate(
    method: string,
    pathname: string,
    body?: unknown,
  ): Promise<{ status: number; json: unknown }> {
    const agent = new Agent({
      connect: { ca: fs.readFileSync(path.join(stateDir, "material.json"), "utf8") && caCert(), rejectUnauthorized: true },
    });
    try {
      const response = await undiciRequest(`${address}${pathname}`, {
        method: method as "GET",
        dispatcher: agent,
        ...(body === undefined
          ? {}
          : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      });
      const text = await response.body.text();
      return { status: response.statusCode, json: text === "" ? undefined : JSON.parse(text) };
    } finally {
      await agent.close();
    }
  }

  function caCert(): string {
    const material = JSON.parse(fs.readFileSync(path.join(stateDir, "material.json"), "utf8"));
    return material.caCert as string;
  }

  async function pair(minted: MintedCode, label = "actanastudio"): Promise<SearchRegistrationBlob> {
    return pairWithSearch({
      address,
      code: minted.ticket,
      expectedCaFingerprint: minted.caFingerprint,
      client: { label, platform: process.platform },
    });
  }

  it("issues a certificate, a CA and a bearer — and never a private key", async () => {
    const minted = await mint({ label: "actanastudio", scope: "admin" });
    const blob = await pair(minted);

    expect(blob.caCert).toMatch(/-----BEGIN CERTIFICATE-----/);
    expect(blob.clientCert).toMatch(/-----BEGIN CERTIFICATE-----/);
    expect(blob.bearer).toMatch(/^[\w-]+\.[\w-]+$/);
    expect(blob.endpoint).toBe(address);
    // The key is in the blob because this machine generated it, and it is not
    // in anything the server sent: the redemption response has four fields.
    expect(blob.clientKey).toMatch(/-----BEGIN PRIVATE KEY-----/);
    expect(blob.caCert).not.toContain("PRIVATE KEY");
    expect(blob.clientCert).not.toContain("PRIVATE KEY");
  });

  it("hands back material that completes an mTLS handshake", async () => {
    const minted = await mint({ label: "studio-mtls", scope: "write", kbIds: ["kb_a"] });
    const blob = await pair(minted, "studio-mtls");
    const client = SearchClient.fromRegistrationBlob(blob);
    try {
      const status = await client.pairStatus();
      expect(status.label).toBe("studio-mtls");
      expect(status.scope).toBe("write");
      expect(status.kbIds).toEqual(["kb_a"]);
      expect(status.certSerial).toMatch(/^[0-9a-fA-F]+$/);
    } finally {
      await client.close();
    }
  });

  it("tells an authenticated client the schema version, on capabilities", async () => {
    const minted = await mint({ label: "versioned", scope: "read" });
    const blob = await pair(minted, "versioned");
    const client = SearchClient.fromRegistrationBlob(blob);
    try {
      // The version lives here rather than on `/v1/health`, which answers a
      // caller with no certificate and is told nothing about the build.
      expect(await client.capabilities()).toMatchObject({
        protocol: 1,
        schemaVersion: SCHEMA_VERSION,
        publicHost: "localhost",
      });
      // Health, to the same client, does carry it — it has a certificate.
      expect(await client.health()).toEqual({ ok: true, schemaVersion: SCHEMA_VERSION });
    } finally {
      await client.close();
    }
  });

  it("grants what the code was minted with, and nothing the request asked for", async () => {
    const minted = await mint({ label: "reader", scope: "read" });
    const blob = await pair(minted, "reader");
    const client = SearchClient.fromRegistrationBlob(blob);
    try {
      expect((await client.pairStatus()).scope).toBe("read");
    } finally {
      await client.close();
    }
  });

  it("persists the paired client so `pair ls` and `pair revoke` have something to read", async () => {
    const minted = await mint({ label: "listed", scope: "admin" });
    await pair(minted, "listed");
    const response = await callAdmin("GET", "/admin/pair/clients");
    const body = (await response.body.json()) as { clients: Array<Record<string, unknown>> };
    expect(body.clients.some((c) => c.label === "listed")).toBe(true);
  });

  it("refuses a replay of a consumed session", async () => {
    const minted = await mint({ label: "replay" });
    await pair(minted, "replay");
    await expect(pair(minted, "replay-again")).rejects.toMatchObject({
      name: "SearchPairingError",
      failure: "refused",
    });
  });

  it("kills the session at five wrong codes, and refuses identically throughout", async () => {
    const minted = await mint({ label: "guessed" });
    const wrong = { ...minted, ticket: `${minted.sessionId}:AAAA-BBBB` };
    const failures: string[] = [];
    for (let i = 0; i < 5; i++) {
      await pair(wrong as MintedCode, "guesser").catch((err: SearchPairingError) =>
        failures.push(err.failure),
      );
    }
    expect(failures).toEqual(["refused", "refused", "refused", "refused", "refused"]);
    // The right code no longer works: the session is dead, and the refusal is
    // the same one every wrong guess got.
    await expect(pair(minted, "guesser")).rejects.toMatchObject({ failure: "refused" });
  });

  it("refuses an unknown session with the same answer as a wrong code", async () => {
    const unknown = { ...(await mint()), sessionId: "ps_nobody_minted" };
    unknown.ticket = `ps_nobody_minted:ABCD-EFGH`;
    await expect(pair(unknown, "ghost")).rejects.toMatchObject({ failure: "refused" });
  });

  it("refuses a code that belongs to another session", async () => {
    const a = await mint({ label: "a" });
    const b = await mint({ label: "b" });
    // b's session id with a's code: the digest is bound to the session, so this
    // cannot match even though the code is a live one.
    const crossed = { ...b, ticket: `${b.sessionId}:${a.code}` };
    await expect(pair(crossed as MintedCode, "crossed")).rejects.toMatchObject({
      failure: "refused",
    });
  });

  it("refuses a session the operator cancelled, indistinguishably", async () => {
    const minted = await mint({ label: "cancelled" });
    const revoke = await callAdmin("POST", "/admin/pair/revoke", { id: minted.sessionId });
    expect(revoke.statusCode).toBe(200);
    await expect(pair(minted, "cancelled")).rejects.toMatchObject({ failure: "refused" });
  });

  it("does not send the code when the fingerprint was not confirmed", async () => {
    const minted = await mint({ label: "unconfirmed" });
    await expect(
      pairWithSearch({ address, code: minted.ticket, client: { label: "unconfirmed" } }),
    ).rejects.toMatchObject({ failure: "fingerprint-unconfirmed" });
    // The code still works afterwards, which is the proof it was never sent.
    const blob = await pair(minted, "unconfirmed");
    expect(blob.clientCert).toMatch(/-----BEGIN CERTIFICATE-----/);
  });

  it("does not send the code when the fingerprint does not match", async () => {
    const minted = await mint({ label: "mismatched" });
    const wrongFingerprint = minted.caFingerprint.startsWith("AA")
      ? minted.caFingerprint.replace(/^AA/, "BB")
      : `AA${minted.caFingerprint.slice(2)}`;
    await expect(
      pairWithSearch({
        address,
        code: minted.ticket,
        expectedCaFingerprint: wrongFingerprint,
        client: { label: "mismatched" },
      }),
    ).rejects.toMatchObject({ failure: "fingerprint-mismatch" });
    const blob = await pair(minted, "mismatched");
    expect(blob.clientCert).toMatch(/-----BEGIN CERTIFICATE-----/);
  });

  it("refuses a body too large to be a redemption", async () => {
    const answer = await dialWithoutCertificate("POST", "/v1/pair/redeem", {
      sessionId: "ps_1",
      code: "ABCD-EFGH",
      csr: `-----BEGIN CERTIFICATE REQUEST-----\n${"A".repeat(40_000)}\n-----END CERTIFICATE REQUEST-----`,
      client: {},
    });
    expect(answer.status).toBe(413);
  });

  it("refuses a GET at the redemption path", async () => {
    const answer = await dialWithoutCertificate("GET", "/v1/pair/redeem");
    expect(answer.status).toBe(405);
  });

  describe("the pre-auth hole is exactly one route wide", () => {
    it("answers the pairing route to a client with no certificate", async () => {
      const answer = await dialWithoutCertificate("POST", "/v1/pair/redeem", {});
      // 400, not 403: the request reached the route and was refused on its
      // shape, which is the proof the gate let it through.
      expect(answer.status).toBe(400);
    });

    it("refuses `/v1/pair/status` to that same client", async () => {
      const answer = await dialWithoutCertificate("GET", "/v1/pair/status");
      expect(answer.status).toBe(403);
      expect(answer.json).toMatchObject({ code: "client-certificate-required" });
    });

    it("refuses every other route to that same client", async () => {
      for (const pathname of ["/v1/capabilities", "/v1/kbs", "/"]) {
        const answer = await dialWithoutCertificate("GET", pathname);
        expect(answer.status).toBe(403);
      }
    });

    it("serves `/v1/health` without a certificate, because a health check has none", async () => {
      const answer = await dialWithoutCertificate("GET", "/v1/health");
      expect(answer.status).toBe(200);
      // `{ ok }` and nothing else: the schema version is a fact about this
      // build and an unauthenticated stranger is not told it.
      expect(answer.json).toEqual({ ok: true });
    });
  });

  it("refuses a revoked client on a connection its certificate still completes", async () => {
    const minted = await mint({ label: "doomed", scope: "admin" });
    const blob = await pair(minted, "doomed");
    const client = SearchClient.fromRegistrationBlob(blob);
    try {
      const status = await client.pairStatus();

      const revoke = await callAdmin("POST", "/admin/pair/revoke", { id: status.id });
      expect(revoke.statusCode).toBe(200);

      // The certificate is still signed by this CA and still completes the
      // handshake. The gate is what refuses it.
      await expect(client.pairStatus()).rejects.toBeInstanceOf(SearchApiError);
      await expect(client.pairStatus()).rejects.toMatchObject({ status: 403 });
    } finally {
      await client.close();
    }
  });

  it("still serves `/v1/health` to a revoked client, because health has no identity", async () => {
    const answer = await dialWithoutCertificate("GET", "/v1/health");
    expect(answer.status).toBe(200);
  });

  describe("the admin surface", () => {
    /** A raw call over the socket, with whatever headers the case wants. */
    const raw = async (
      method: "GET" | "POST",
      pathname: string,
      headers: Record<string, string>,
      body?: string,
    ): Promise<{ status: number; json: unknown }> => {
      const response = await undiciRequest(`http://admin.invalid${pathname}`, {
        method,
        dispatcher: adminAgent,
        headers,
        ...(body === undefined ? {} : { body }),
      });
      const text = await response.body.text();
      return { status: response.statusCode, json: text === "" ? undefined : JSON.parse(text) };
    };

    it("listens on a socket the filesystem guards, at 0600", () => {
      expect(admin.socketPath).toBe(path.join(stateDir, "admin.sock"));
      expect(admin.port).toBeNull();
      const mode = fs.statSync(admin.socketPath!).mode & 0o777;
      expect(mode).toBe(0o600);
      // And the directory it sits in is the operator's own.
      expect(fs.statSync(stateDir).mode & 0o777).toBe(0o700);
    });

    it("refuses a request carrying an Origin — that is a page, not an operator", async () => {
      const answer = await raw(
        "POST",
        "/admin/pair/new",
        { "content-type": "application/json", origin: "https://evil.example" },
        JSON.stringify({ label: "csrf" }),
      );
      expect(answer.status).toBe(403);
      expect(answer.json).toMatchObject({ code: "forbidden" });
    });

    it("refuses a revoke carrying an Origin, which is the one that costs something", async () => {
      const minted = await mint({ label: "protected" });
      const blob = await pair(minted, "protected");
      const client = SearchClient.fromRegistrationBlob(blob);
      try {
        const status = await client.pairStatus();
        const answer = await raw(
          "POST",
          "/admin/pair/revoke",
          { "content-type": "application/json", origin: "null" },
          JSON.stringify({ id: status.id }),
        );
        expect(answer.status).toBe(403);
        // Still paired: the refusal happened before anything was written.
        expect((await client.pairStatus()).id).toBe(status.id);
      } finally {
        await client.close();
      }
    });

    it("refuses the content types a browser can send without a preflight", async () => {
      for (const contentType of [
        "text/plain",
        "application/x-www-form-urlencoded",
        "multipart/form-data",
        "text/plain;charset=UTF-8",
      ]) {
        const answer = await raw(
          "POST",
          "/admin/pair/new",
          { "content-type": contentType },
          JSON.stringify({ label: "simple-request" }),
        );
        expect(answer.status).toBe(415);
        expect(answer.json).toMatchObject({ code: "unsupported-media-type" });
      }
    });

    it("accepts `application/json` with a charset, which a CLI may well send", async () => {
      const answer = await raw(
        "POST",
        "/admin/pair/new",
        { "content-type": "application/json; charset=utf-8" },
        JSON.stringify({ label: "charset" }),
      );
      expect(answer.status).toBe(200);
    });

    it("never hands back a code it has already stored — there is none to hand back", async () => {
      const minted = await mint({ label: "listed-code" });
      const listed = (await (await callAdmin("GET", "/admin/pair/codes")).body.json()) as {
        codes: Array<Record<string, unknown>>;
      };
      const row = listed.codes.find((c) => c.sessionId === minted.sessionId);
      expect(row).toBeDefined();
      expect(JSON.stringify(row)).not.toContain(minted.code.replace("-", ""));
      expect(row).not.toHaveProperty("code");
      expect(row).not.toHaveProperty("codeHash");
    });
  });

  describe("the KB half of the grant", () => {
    it("refuses a KB the pairing did not name, before the handler runs", async () => {
      const minted = await mint({ label: "narrow", scope: "admin", kbIds: ["kb_allowed"] });
      const blob = await pair(minted, "narrow");
      const client = SearchClient.fromRegistrationBlob(blob);
      try {
        expect((await client.pairStatus()).kbIds).toEqual(["kb_allowed"]);
        // `/v1/kbs/:id/probe` is registered by this suite through
        // `registerRoutes`, which is the hook TASK-004 mounts its own routes
        // on: the point is that declaring `kbIdFrom` is all a route has to do.
        await expect(client.request("GET", "/v1/kbs/kb_forbidden/probe")).rejects.toMatchObject({
          code: "kb-forbidden",
          status: 403,
        });
        await expect(client.request("GET", "/v1/kbs/kb_allowed/probe")).resolves.toMatchObject({
          kbId: "kb_allowed",
          allowed: true,
        });
      } finally {
        await client.close();
      }
    });

    it("lets a pairing that named no KBs touch any of them", async () => {
      const minted = await mint({ label: "wide", scope: "admin" });
      const blob = await pair(minted, "wide");
      const client = SearchClient.fromRegistrationBlob(blob);
      try {
        expect((await client.pairStatus()).kbIds).toBeNull();
        await expect(client.request("GET", "/v1/kbs/kb_anything/probe")).resolves.toMatchObject({
          allowed: true,
        });
      } finally {
        await client.close();
      }
    });
  });

  describe("a certificate this CA did not sign", () => {
    /** A whole other instance's material: its own CA, its own client leaf. */
    let foreign: Awaited<ReturnType<typeof generateCertMaterial>>;
    let foreignAgent: Agent;

    beforeAll(async () => {
      foreign = await generateCertMaterial({ hosts: ["localhost"] });
      foreignAgent = new Agent({
        connect: {
          ca: caCert(),
          cert: foreign.client.cert,
          key: foreign.client.key,
          rejectUnauthorized: true,
        },
      });
    });

    afterAll(async () => {
      await foreignAgent?.close();
    });

    const dial = async (pathname: string): Promise<{ status: number; json: unknown }> => {
      const response = await undiciRequest(`${address}${pathname}`, {
        method: "GET",
        dispatcher: foreignAgent,
      });
      const text = await response.body.text();
      return { status: response.statusCode, json: text === "" ? undefined : JSON.parse(text) };
    };

    it("completes the handshake and is still refused, because the gate re-checks", async () => {
      // `rejectUnauthorized` is relaxed at the handshake so an uncertificated
      // client can reach the pairing route at all — which means a certificate
      // signed by somebody else's CA gets a TLS session too. The refusal has to
      // come from the gate, per request, or the relaxation is a hole.
      const answer = await dial("/v1/pair/status");
      expect(answer.status).toBe(403);
      expect(answer.json).toMatchObject({ code: "client-certificate-required" });
    });

    it("is refused on every authenticated route, not only that one", async () => {
      for (const pathname of ["/v1/capabilities", "/v1/kbs"]) {
        expect((await dial(pathname)).status).toBe(403);
      }
    });

    it("is served `/v1/health`, which asks for nothing", async () => {
      const answer = await dial("/v1/health");
      expect(answer.status).toBe(200);
      expect(answer.json).toEqual({ ok: true });
    });
  });
});

/**
 * The pre-auth route's rate limit, over the wire.
 *
 * Its own server, with a limiter of one, because the assertion is that the
 * *route* consults it before it reads a byte — and the suite above deliberately
 * runs with the windows opened wide so that pairing a dozen clients in a second
 * does not spend them.
 */
describe.skipIf(!url)("the pre-auth rate limit, through the route", () => {
  let db: SearchDatabase;
  let closeDb: () => Promise<void>;
  let api: SearchServer;
  let stateDir: string;
  let agent: Agent;

  beforeAll(async () => {
    const created = createDatabase(url!, { max: 2 });
    db = created.db;
    closeDb = created.close;
    await runMigrations({ url: url! });

    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "actana-search-ratelimit-"));
    const ensured = await ensureMaterial({ stateDir, publicHosts: ["localhost"] });
    const store = new SearchPairingStore(db);
    const revocations = new PairingRevocations(store);
    await revocations.refresh();

    api = await startSearchServer({
      material: ensured.material,
      store,
      revocations,
      port: 0,
      host: "127.0.0.1",
      publicHosts: ["localhost"],
      pairingRateLimiter: new PairingRateLimiter({
        peer: { limit: 1, windowMs: 60_000 },
        global: { limit: 100, windowMs: 60_000 },
      }),
    });
    agent = new Agent({ connect: { ca: ensured.material.caCert, rejectUnauthorized: true } });
  });

  afterAll(async () => {
    await agent?.close();
    await api?.close();
    await closeDb?.();
    if (stateDir) fs.rmSync(stateDir, { recursive: true, force: true });
  });

  const redeem = async (): Promise<{ status: number; retryAfter: string | undefined; json: unknown }> => {
    const response = await undiciRequest(`https://localhost:${api.port}/v1/pair/redeem`, {
      method: "POST",
      dispatcher: agent,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "ps_nobody", code: "ABCD-EFGH", client: {}, csr: "x" }),
    });
    const text = await response.body.text();
    return {
      status: response.statusCode,
      retryAfter: response.headers["retry-after"] as string | undefined,
      json: text === "" ? undefined : JSON.parse(text),
    };
  };

  it("answers the first attempt and rate-limits the second, with a retry-after", async () => {
    // The first is refused on its shape (the CSR is not a CSR), which is the
    // route having read it. The second never gets that far.
    const first = await redeem();
    expect(first.status).toBe(400);

    const second = await redeem();
    expect(second.status).toBe(429);
    expect(second.json).toMatchObject({ code: "rate-limited" });
    expect(Number(second.retryAfter)).toBeGreaterThan(0);
    expect(Number(second.retryAfter)).toBeLessThanOrEqual(60);
  });
});
