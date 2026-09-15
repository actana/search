// The operator's half of pairing: mint a code, list the clients, take one back.
//
// **Why this exists at all, and why it is not what Control does.** On a Core,
// `actana pair new` runs in the CLI, opens the same `pairing.json` the daemon
// reads, and never speaks to the daemon — one file, two processes, no protocol.
// Search cannot copy that: its sessions live in Postgres (`search.pairing_code`
// — one code redeemed against one process has to be spent for all of them), and
// its code digest is keyed by a secret in `SEARCH_STATE_DIR`. A CLI doing what
// Control's does would need the database credentials *and* the state directory,
// which makes every `actana-search pair new` a second thing holding the keys to
// the instance. So the mint happens in the process that already holds both, and
// the CLI asks it.
//
// **A Unix domain socket under `SEARCH_STATE_DIR`, mode 0600.** This surface
// has no authentication of its own — reaching it *is* the credential — so what
// guards it has to be the same thing that guards a Core's `pairing.json`: the
// filesystem. A socket at `$SEARCH_STATE_DIR/admin.sock`, in a directory this
// process already creates 0700, is reachable by the user the service runs as
// and by root, and by nothing else.
//
// **A loopback TCP port was the first shape and it was wrong**, in two ways
// that a review caught and that are worth writing down rather than quietly
// fixing:
//
//   * **Any process on the host could reach it**, not only the operator's —
//     including every container sharing the network namespace, which is the
//     ordinary compose arrangement. "Loopback" is a weaker claim than it
//     sounds.
//   * **A browser tab could drive it.** `readJson` accepted any content type,
//     so a page on any origin could `fetch('http://127.0.0.1:7444/admin/pair/
//     new', {method:'POST', body:'{…}'})` as a simple request, no preflight,
//     and mint a pairing code. The response is unreadable cross-origin — and
//     irrelevant, because the code it needs is echoed nowhere the attacker has
//     to read: they would `POST /admin/pair/revoke` instead and unpair
//     everything.
//
// So TCP is now opt-in (`SEARCH_ADMIN_PORT`, for a platform with no Unix
// sockets), still loopback-only, and hardened against the second case: a strict
// `content-type: application/json` — which is not a CORS-simple type, so a
// cross-origin `fetch` is preflighted and the preflight is never answered — and
// an outright refusal of any request carrying `Origin`, which no CLI sends and
// every browser does.
//
//   POST /admin/pair/new     { label?, scope?, kbIds?, ttlMs? }
//     → { sessionId, code, ticket, expiresAt, caFingerprint, endpoint, scope, kbIds }
//   GET  /admin/pair/clients → { clients: [...] }
//   POST /admin/pair/revoke  { id } → { revoked }
// **The code is in the response and nowhere else.** It is hashed before it is
// stored (ADR 0034 D1), so this body is the only time it exists outside the
// operator's head — `pair ls` cannot print it because there is nothing to
// print.
//
// **Pairing and nothing else.** This surface carried `GET`/`POST
// /admin/endpoints` for exactly as long as there was no authenticated way to
// register a model endpoint: TASK-005 landed the registry before TASK-004
// landed the route, and an operator standing up a standalone instance had to be
// able to give it an embedding key. `PUT /v1/endpoints` over mTLS is that way
// now (ADR 0004, ADR 0009), so the stopgap is gone and `actana-search endpoint`
// is a client-side verb over the SDK like `kb` and `query`. What is left here
// is the one thing that genuinely cannot be authenticated over mTLS, because it
// is what *mints* the credential: the filesystem decides who may, and the 0600
// socket carries it (ADR 0008 D6).

import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import { createLogger } from "@actana/search-shared/log";
import { generatePairingCode } from "@actana/search-shared/pairing/pairing-code";
import { derivePairingCodeKey, hashPairingCode } from "@actana/search-shared/pairing/pairing-code-digest";
import {
  createPairingSession,
  isPairingScope,
  PAIRING_SESSION_TTL_MS,
  type PairingScope,
} from "@actana/search-shared/pairing/pairing-session";
import {
  LOCAL_OPERATOR_PEER,
  pairingAuditor,
  type PairingAuditEvent,
} from "@actana/search-shared/pairing/pairing-audit";
import { generateId } from "@actana/search-shared/short-id";
import type { SearchPairingStore } from "../pairing/pairing-store.ts";
import type { PairingRevocations } from "../pairing/pairing-revocation.ts";
import { sendJson, sendRefusal } from "../pairing/pairing-routes.ts";
import { ADMIN_SOCKET_FILENAME, adminSocketPath, socketPathProblem } from "./admin-socket.ts";

/**
 * Re-exported from `admin-socket.ts`, which `config.ts` also reads.
 *
 * They lived here until `SEARCH_STATE_DIR` needed validating before anything
 * was opened; `config.ts` cannot import this module (it is imported by half the
 * tree, this one starts an HTTP server), so the two constants moved down to a
 * leaf and the old spelling stayed.
 */
export { ADMIN_SOCKET_FILENAME, adminSocketPath };

const logger = createLogger("api/admin");

/** The loopback addresses the opt-in TCP listener will bind, and no others. */
const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

/** The most an admin request body may weigh. Nothing here is large. */
const MAX_ADMIN_BODY_BYTES = 16 * 1024;

export type AdminServerOptions = {
  store: SearchPairingStore;
  revocations: PairingRevocations;
  /**
   * The Unix domain socket to listen on — normally
   * {@link adminSocketPath}(`SEARCH_STATE_DIR`). `null` turns it off, which
   * only a platform with no Unix sockets should do.
   */
  socketPath?: string | null;
  /** The instance's HMAC secret — the root of the code digest key. */
  bearerSecret: string;
  /** Read out beside the code. Colon-separated upper-case SHA-256 of the CA. */
  caFingerprint: string;
  /** The address a redeemed code will hand back. Printed beside the code. */
  endpoint: string;
  /**
   * `SEARCH_ADMIN_PORT` — the opt-in loopback TCP listener, for a platform with
   * no Unix sockets. Absent is off, which is the default and the right answer
   * everywhere else. `0` asks the OS for a free port (the suites).
   */
  port?: number | null;
  /** Loopback only. Anything else is refused rather than bound. */
  host?: string;
  /** Where mints and revocations are recorded. Defaults to the instance log. */
  audit?: (event: PairingAuditEvent) => void;
};

export type AdminServer = {
  /** The Unix socket it is listening on, or `null`. */
  socketPath: string | null;
  /** The TCP port it is listening on, or `null` when TCP is off. */
  port: number | null;
  close(): Promise<void>;
};

/** Start the admin listener: a Unix socket, and optionally a loopback port. */
export async function startAdminServer(opts: AdminServerOptions): Promise<AdminServer> {
  const host = opts.host ?? "127.0.0.1";
  const wantsTcp = opts.port !== undefined && opts.port !== null;
  if (wantsTcp && !LOOPBACK.has(host)) {
    throw new Error(
      `the admin listener binds loopback only — "${host}" would expose code minting and ` +
        "revocation to the network, and it has no authentication of its own.",
    );
  }
  const socketPath = opts.socketPath === undefined ? null : opts.socketPath;
  /**
   * The path length, before the bind rather than after it.
   *
   * `config.ts` already refuses a `SEARCH_STATE_DIR` whose socket path is too
   * long, so this catches the other caller: a `socketPath` passed straight in.
   * `listen EINVAL … /admin.sock` is what the kernel says instead, and it took
   * a proof run to work out what it meant.
   */
  if (socketPath) {
    const problem = socketPathProblem(socketPath);
    if (problem) throw new Error(`the admin listener cannot bind: ${problem}`);
  }
  if (!socketPath && !wantsTcp) {
    throw new Error(
      "the admin listener was given neither a socket path nor a port, so no operator could " +
        "mint a pairing code on this instance.",
    );
  }
  const audit = opts.audit ?? pairingAuditor();
  const codeKey = derivePairingCodeKey(opts.bearerSecret);

  const server = http.createServer((req, res) => {
    void route(req, res).catch((err: unknown) => {
      logger.error("admin.unhandled", { error: err instanceof Error ? err.message : String(err) });
      if (!res.headersSent) {
        sendRefusal(res, { status: 500, code: "core-error", message: "the admin route failed" });
      } else {
        res.destroy();
      }
    });
  });

  async function route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";

    // **Nothing a browser sends gets past here.** `Origin` is attached by every
    // browser to a cross-origin request and by no CLI, so its presence is a
    // reliable statement that this came from a page. Refused outright rather
    // than compared against a list: there is no origin this surface serves.
    if (req.headers.origin !== undefined) {
      return sendRefusal(res, {
        status: 403,
        code: "forbidden",
        message:
          "the admin surface does not answer a request carrying an Origin — it is for the " +
          "operator's shell, not for a page",
      });
    }
    // The other half of the same defence: `application/json` is not a
    // CORS-simple content type, so a cross-origin `fetch` that sets it is
    // preflighted — and this server answers no `OPTIONS`, so the preflight
    // fails and the request is never sent. Checked on every method, including
    // the GET, so the rule has one spelling.
    const refusal = wrongContentType(req);
    if (refusal) return sendRefusal(res, refusal);

    if (method === "POST" && url.pathname === "/admin/pair/new") return newCode(req, res);
    if (method === "GET" && url.pathname === "/admin/pair/clients") return listClients(res);
    if (method === "POST" && url.pathname === "/admin/pair/revoke") return revoke(req, res);
    if (method === "GET" && url.pathname === "/admin/pair/codes") return listCodes(res);
    sendRefusal(res, {
      status: 404,
      code: "not-found",
      message: `no admin route for ${method} ${url.pathname}`,
    });
  }

  async function newCode(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await readJson(req);
    if (!body.ok) {
      return sendRefusal(res, { status: 400, code: "bad-request", message: body.message });
    }
    const input = body.value as Record<string, unknown>;
    const scope = input.scope === undefined ? "admin" : input.scope;
    if (!isPairingScope(scope)) {
      return sendRefusal(res, {
        status: 400,
        code: "bad-request",
        message: "`scope` must be one of read, write, admin",
      });
    }
    const kbIds = readKbIds(input.kbIds);
    if (kbIds === false) {
      return sendRefusal(res, {
        status: 400,
        code: "bad-request",
        message: "`kbIds` must be a list of strings",
      });
    }
    const label = typeof input.label === "string" ? input.label.slice(0, 64) : "";
    const ttlMs =
      typeof input.ttlMs === "number" && Number.isFinite(input.ttlMs) && input.ttlMs > 0
        ? Math.min(input.ttlMs, 24 * 60 * 60 * 1000)
        : PAIRING_SESSION_TTL_MS;

    const now = Date.now();
    const sessionId = generateId();
    // The plaintext exists here and in the response. What is stored is the
    // digest, bound to this session id (ADR 0034 D1, D11).
    const code = generatePairingCode();
    const session = createPairingSession({
      id: sessionId,
      label,
      codeHash: hashPairingCode({ key: codeKey, sessionId, code }),
      now,
      ttlMs,
      scope: scope as PairingScope,
      kbIds,
    });
    await opts.store.createSession(session, now);

    audit({
      outcome: "minted",
      sessionId,
      label,
      reason: scope,
      peer: LOCAL_OPERATOR_PEER,
      at: now,
    });

    sendJson(res, 200, {
      sessionId,
      code,
      /** What an operator reads out as one token. `pairWithSearch` splits it. */
      ticket: `${sessionId}:${code}`,
      expiresAt: new Date(session.expiresAt).toISOString(),
      caFingerprint: opts.caFingerprint,
      endpoint: opts.endpoint,
      scope,
      kbIds,
    });
  }

  async function listClients(res: http.ServerResponse): Promise<void> {
    const clients = await opts.store.listClients();
    sendJson(res, 200, {
      clients: clients.map((client) => ({
        id: client.id,
        label: client.label,
        platform: client.platform,
        scope: client.scope,
        kbIds: client.kbIds,
        certSerial: client.certSerial,
        certFingerprint: client.certFingerprint,
        certNotAfter: client.certNotAfter ? new Date(client.certNotAfter).toISOString() : null,
        pairedAt: new Date(client.pairedAt).toISOString(),
        revokedAt: client.revokedAt === null ? null : new Date(client.revokedAt).toISOString(),
      })),
    });
  }

  async function listCodes(res: http.ServerResponse): Promise<void> {
    const sessions = await opts.store.listSessions();
    // No `code` field, and there cannot be one: only the digest was stored.
    sendJson(res, 200, {
      codes: sessions.map((session) => ({
        sessionId: session.id,
        label: session.label,
        scope: session.scope,
        kbIds: session.kbIds ?? null,
        expiresAt: new Date(session.expiresAt).toISOString(),
        attempts: session.attempts,
        attemptCap: session.attemptCap,
        consumedAt: session.consumedAt === null ? null : new Date(session.consumedAt).toISOString(),
        revokedAt: session.revokedAt ? new Date(session.revokedAt).toISOString() : null,
      })),
    });
  }

  async function revoke(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await readJson(req);
    if (!body.ok) {
      return sendRefusal(res, { status: 400, code: "bad-request", message: body.message });
    }
    const id = (body.value as Record<string, unknown>).id;
    if (typeof id !== "string" || id.length === 0) {
      return sendRefusal(res, { status: 400, code: "bad-request", message: "`id` is required" });
    }
    const now = Date.now();
    // A pending code and a paired client are both revocable, and the operator
    // has one id in hand. Try the client first — that is the one with a
    // certificate in the world.
    const client = await opts.store.revokeClient(id, now);
    if (client) {
      // Refresh before answering, so a revocation made here is enforced by the
      // time the caller is told it happened rather than within a sweep.
      await opts.revocations.refresh();
      audit({
        outcome: "revoked",
        sessionId: client.sessionId,
        label: client.label,
        peer: LOCAL_OPERATOR_PEER,
        certSerial: client.certSerial,
        at: now,
      });
      return sendJson(res, 200, {
        revoked: {
          kind: "client",
          id: client.id,
          certSerial: client.certSerial,
          revokedAt: new Date(client.revokedAt ?? now).toISOString(),
        },
      });
    }
    const session = await opts.store.cancelSession(id, now);
    if (session) {
      audit({
        outcome: "revoked",
        reason: "session-cancelled",
        sessionId: session.id,
        label: session.label,
        peer: LOCAL_OPERATOR_PEER,
        at: now,
      });
      return sendJson(res, 200, {
        revoked: {
          kind: "code",
          id: session.id,
          revokedAt: session.revokedAt ? new Date(session.revokedAt).toISOString() : null,
        },
      });
    }
    sendRefusal(res, {
      status: 404,
      code: "not-found",
      message: `nothing paired or pending is named "${id}"`,
    });
  }

  // One `http.Server`, listening on one or both. Two listeners would be two
  // routers, and the second one is the one that would drift.
  const listen = (target: () => void): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => reject(err);
      server.once("error", onError);
      server.once("listening", () => {
        server.removeListener("error", onError);
        resolve();
      });
      target();
    });

  /**
   * Close the listener and take the socket file with it.
   *
   * The caller's `close()` is this, and so is the failure path below: a boot
   * that bound the socket and then could not bind its port used to throw with
   * the socket still bound and the file still there, which is the same
   * half-open state `openInOrder` exists to prevent, one level down.
   */
  const closeServer = (): Promise<void> =>
    new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      server.close(() => {
        if (socketPath) {
          try {
            fs.rmSync(socketPath, { force: true });
          } catch {
            /* best effort — a stale socket is removed on the next start */
          }
        }
        resolve();
      });
    });

  let port: number | null = null;
  try {
    if (socketPath) {
      // A socket left behind by a process that was killed rather than stopped
      // would make `listen` fail with `EADDRINUSE` on a path nothing is
      // serving. Removing it is safe: a live one belongs to a process that is
      // already answering, and starting a second instance against one state
      // directory is an operator error the database would catch anyway.
      try {
        fs.rmSync(socketPath, { force: true });
      } catch {
        /* a path we cannot remove is one `listen` will report properly */
      }
      fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
      await listen(() => server.listen(socketPath));
      // 0600 after the bind rather than a umask around it: a umask is process
      // state that every other file in this boot would also be written under.
      // There is a window between the two, and it is bounded by the 0700
      // directory the socket sits in.
      fs.chmodSync(socketPath, 0o600);
      logger.info("Admin listening (unix socket, 0600)", { socketPath });
    }

    if (wantsTcp) {
      await listen(() => server.listen(opts.port ?? 0, host));
      port = (server.address() as AddressInfo).port;
      logger.warn(
        "Admin also listening on loopback TCP. Any process on this host can reach it, including " +
          "every container sharing the network namespace. Prefer the unix socket.",
        { host, port },
      );
    }
  } catch (err) {
    await closeServer();
    throw err;
  }

  return { socketPath, port, close: closeServer };
}

/**
 * The refusal for a body this surface will not read, or `null`.
 *
 * Strict: `application/json`, with or without a charset, and nothing else. A
 * `GET` with no body is allowed to say nothing. Everything a browser can send
 * without a preflight — `text/plain`, `application/x-www-form-urlencoded`,
 * `multipart/form-data` — is refused by name rather than by omission.
 */
function wrongContentType(req: http.IncomingMessage): Refusal | null {
  const declared = String(req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
  if (declared === "application/json") return null;
  if (declared === "" && (req.method ?? "GET") === "GET") return null;
  return {
    status: 415,
    code: "unsupported-media-type",
    message: "the admin surface reads `application/json` and nothing else",
  };
}

/** The refusal shape `sendRefusal` takes. Mirrors the pairing route's. */
type Refusal = { status: number; code: string; message: string; headers?: Record<string, string> };

type JsonResult = { ok: true; value: unknown } | { ok: false; message: string };

function readJson(req: http.IncomingMessage): Promise<JsonResult> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const settle = (result: JsonResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_ADMIN_BODY_BYTES) {
        settle({ ok: false, message: "the body is too large" });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (raw === "") return settle({ ok: true, value: {} });
      try {
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          return settle({ ok: false, message: "the body must be a JSON object" });
        }
        settle({ ok: true, value: parsed });
      } catch {
        settle({ ok: false, message: "the body was not JSON" });
      }
    });
    req.on("error", () => settle({ ok: false, message: "the body could not be read" }));
  });
}

/** A KB allow-list, `null` for absent, or `false` for "that is not a list". */
function readKbIds(value: unknown): string[] | null | false {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) return false;
  if (!value.every((id) => typeof id === "string" && id.length > 0)) return false;
  return value.length > 0 ? (value as string[]) : null;
}
