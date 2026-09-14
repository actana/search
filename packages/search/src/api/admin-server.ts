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
//   GET  /admin/endpoints    → { pairedClientId, endpoints: [...] }
//   POST /admin/endpoints    { pairedClientId?, kind, provider, template?, model,
//                              dimensions?, baseUrl?, label?, config?, apiKey }
//     → { endpoint }
//
// **The code is in the response and nowhere else.** It is hashed before it is
// stored (ADR 0034 D1), so this body is the only time it exists outside the
// operator's head — `pair ls` cannot print it because there is nothing to
// print.
//
// **The two endpoint routes are here for the same reason the pairing ones are,
// and they are temporary** (TASK-005). Registering a *local* model endpoint
// means handing the instance a provider key to seal, and the authenticated way
// to do that is `PUT /v1/endpoints` over mTLS — which lands with the REST
// surface in TASK-004. Until it does, an operator standing up a standalone
// instance has no way to give it an embedding key at all, and "pair with
// yourself first, then register the key you need in order to ingest anything"
// is not a first run. So the mint's own guarantee is reused: the filesystem
// decides who may, and the same 0600 socket carries it. When
// `PUT /v1/endpoints` exists, `actana-search endpoint add` moves to it and
// these two go — they are marked here so the removal is a deletion rather than
// an archaeology exercise.
//
// Neither returns a key. `POST` takes one and seals it under
// `SEARCH_ENCRYPTION_KEY`; the listing reports `hasKey` and never a value
// (ADR 0004, `models/endpoint-registry.ts`).

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

const logger = createLogger("api/admin");

/** The loopback addresses the opt-in TCP listener will bind, and no others. */
const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

/** The most an admin request body may weigh. Nothing here is large. */
const MAX_ADMIN_BODY_BYTES = 16 * 1024;

/** The socket's name inside `SEARCH_STATE_DIR`. */
export const ADMIN_SOCKET_FILENAME = "admin.sock";

/** Where the admin socket lives for a given state directory. */
export function adminSocketPath(stateDir: string): string {
  return path.join(stateDir, ADMIN_SOCKET_FILENAME);
}

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
  /**
   * The endpoint registry the two `/admin/endpoints` routes write through.
   *
   * A port rather than a direct import so this server can be started in a suite
   * that has no database — the pairing e2e does exactly that — and so the
   * routes' removal in TASK-004 is one field and two handlers. Defaults to
   * `models/endpoint-registry.ts`, loaded lazily on the first call.
   */
  endpoints?: AdminEndpointPort;
};

/** What the two `/admin/endpoints` routes need. See `models/endpoint-registry.ts`. */
export type AdminEndpointPort = {
  listEndpoints(clientId: string): Promise<unknown[]>;
  createLocalEndpoint(clientId: string, input: LocalEndpointDraft, apiKey: string): Promise<unknown>;
};

/** The subset of `LocalEndpointInput` this surface accepts. */
export type LocalEndpointDraft = {
  kind: "embedding" | "inference";
  provider: string;
  template: string;
  model?: string | null;
  dimensions?: number | null;
  baseUrl?: string | null;
  label?: string | null;
  config?: Record<string, unknown> | null;
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
    if (method === "GET" && url.pathname === "/admin/endpoints") return listEndpoints(url, res);
    if (method === "POST" && url.pathname === "/admin/endpoints") return addEndpoint(req, res);
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

  /** The registry, loaded on first use so a suite with no database can start. */
  async function endpointPort(): Promise<AdminEndpointPort> {
    if (opts.endpoints) return opts.endpoints;
    const registry = await import("../models/endpoint-registry.ts");
    return {
      listEndpoints: (clientId) => registry.listEndpoints(clientId),
      createLocalEndpoint: (clientId, input, apiKey) =>
        registry.createLocalEndpoint(clientId, input, apiKey),
    };
  }

  /**
   * Which paired client an endpoint verb acts for.
   *
   * Named explicitly, or — when there is exactly one active client — that one.
   * The convenience is worth having and it is deliberately narrow: an instance
   * with two clients makes an operator say which, because registering a
   * provider key against the wrong one is not a mistake the next command would
   * reveal.
   */
  async function resolveClientId(named: string | null): Promise<
    { id: string } | { refusal: Refusal }
  > {
    const clients = (await opts.store.listClients()).filter((c) => c.revokedAt === null);
    if (named) {
      if (!clients.some((c) => c.id === named)) {
        return {
          refusal: {
            status: 404,
            code: "not-found",
            message: `no active paired client is named "${named}"`,
          },
        };
      }
      return { id: named };
    }
    if (clients.length === 1) return { id: clients[0]!.id };
    if (clients.length === 0) {
      return {
        refusal: {
          status: 409,
          code: "no-client",
          message:
            "nothing is paired with this instance yet — an endpoint belongs to a paired client, " +
            "so run `actana-search pair new` and redeem it first",
        },
      };
    }
    return {
      refusal: {
        status: 400,
        code: "ambiguous-client",
        message:
          `this instance has ${clients.length} paired clients, so say which one this endpoint ` +
          "is for: --client <id>. `actana-search pair ls` lists them.",
      },
    };
  }

  async function listEndpoints(url: URL, res: http.ServerResponse): Promise<void> {
    const resolved = await resolveClientId(url.searchParams.get("client"));
    if ("refusal" in resolved) return sendRefusal(res, resolved.refusal);
    const registry = await endpointPort();
    sendJson(res, 200, {
      pairedClientId: resolved.id,
      endpoints: await registry.listEndpoints(resolved.id),
    });
  }

  async function addEndpoint(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await readJson(req);
    if (!body.ok) {
      return sendRefusal(res, { status: 400, code: "bad-request", message: body.message });
    }
    const input = body.value as Record<string, unknown>;

    const kind = input.kind;
    if (kind !== "embedding" && kind !== "inference") {
      return sendRefusal(res, {
        status: 400,
        code: "bad-request",
        message: "`kind` must be embedding or inference",
      });
    }
    const provider = typeof input.provider === "string" ? input.provider.trim() : "";
    if (!provider) {
      return sendRefusal(res, { status: 400, code: "bad-request", message: "`provider` is required" });
    }
    const apiKey = typeof input.apiKey === "string" ? input.apiKey : "";
    if (!apiKey) {
      return sendRefusal(res, {
        status: 400,
        code: "bad-request",
        message: "`apiKey` is required — a local endpoint is one whose key this instance seals",
      });
    }
    const dimensions =
      typeof input.dimensions === "number" && Number.isInteger(input.dimensions)
        ? input.dimensions
        : null;
    if (kind === "embedding" && (dimensions === null || dimensions <= 0)) {
      return sendRefusal(res, {
        status: 400,
        code: "bad-request",
        message:
          "an embedding endpoint needs `dimensions` — a KB's partition is sized from it and " +
          "cannot be created without one",
      });
    }

    const resolved = await resolveClientId(
      typeof input.pairedClientId === "string" && input.pairedClientId
        ? input.pairedClientId
        : null,
    );
    if ("refusal" in resolved) return sendRefusal(res, resolved.refusal);

    const registry = await endpointPort();
    let endpoint: unknown;
    try {
      endpoint = await registry.createLocalEndpoint(
        resolved.id,
        {
          kind,
          provider,
          // The template defaults to the provider's own name, which is right for
          // every first-party one in the catalog and wrong only where a provider
          // speaks more than one shape — in which case it is named.
          template: typeof input.template === "string" && input.template ? input.template : provider,
          model: typeof input.model === "string" && input.model ? input.model : null,
          dimensions,
          baseUrl: typeof input.baseUrl === "string" && input.baseUrl ? input.baseUrl : null,
          label: typeof input.label === "string" && input.label ? input.label : null,
          config:
            input.config && typeof input.config === "object" && !Array.isArray(input.config)
              ? (input.config as Record<string, unknown>)
              : null,
        },
        apiKey,
      );
    } catch (err) {
      // The message, never the input: `input` holds the plaintext key.
      const message = err instanceof Error ? err.message : "the endpoint could not be registered";
      logger.error("admin.endpoints.create failed", { pairedClientId: resolved.id });
      return sendRefusal(res, { status: 400, code: "bad-request", message });
    }

    // What comes back is `EndpointSummary`, which carries `hasKey` and no key.
    sendJson(res, 200, { endpoint });
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

  if (socketPath) {
    // A socket left behind by a process that was killed rather than stopped
    // would make `listen` fail with `EADDRINUSE` on a path nothing is serving.
    // Removing it is safe: a live one belongs to a process that is already
    // answering, and starting a second instance against one state directory is
    // an operator error the database would catch anyway.
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

  let port: number | null = null;
  if (wantsTcp) {
    await listen(() => server.listen(opts.port ?? 0, host));
    port = (server.address() as AddressInfo).port;
    logger.warn(
      "Admin also listening on loopback TCP. Any process on this host can reach it, including " +
        "every container sharing the network namespace. Prefer the unix socket.",
      { host, port },
    );
  }

  return {
    socketPath,
    port,
    close: () =>
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
      }),
  };
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
