// The HTTPS listener: mutual TLS, one pre-auth route, and an explicit router.
//
// The TLS construction is **copied from actana/control's
// `pty-core-link-server.ts`** (its ADR 0034 D2) — `requestCert: true`, a
// `rejectUnauthorized` decided by a named function rather than a ternary, and
// the per-request re-check that is what makes the relaxation safe. ADR 0008
// records the copy. What is Search's own is everything above the gate: the
// identity resolution, the router, and the three routes that exist today.
//
// **How a request is decided, in order.**
//
//   1. TLS completes. `requestCert` is always true, so a certificate that *is*
//      presented is parsed and verified against the instance's CA;
//      `rejectUnauthorized` is relaxed only because a pre-auth surface is
//      mounted, and only to let an uncertificated client reach that one route.
//   2. `clientCertGate` re-asks the question per request, from
//      `socket.authorized` and the revocation set. A revoked certificate is a
//      *valid* certificate, so revocation is checked before authorisation.
//   3. `pairedClientFromSocket` turns the leaf's serial into a
//      `search.paired_client` row. A certificate this CA signed whose row is
//      missing or revoked is refused here, not later.
//   4. The router matches an exact method and pathname, or a predicate, and
//      checks the route's scope against the client's.
//
// **`SEARCH_DEV_INSECURE=1` is the one way around all of that, and it refuses
// to start under `NODE_ENV=production`.** It serves plain HTTP and reads the
// caller from `x-paired-client: <id>` — a header, which is precisely what ADR
// 0003 says identity is never read from. It exists so TASK-004's fixture suite
// can drive the REST surface without a handshake, and it says so in the log
// every time it starts.

import * as http from "node:http";
import * as https from "node:https";
import type { AddressInfo } from "node:net";
import { createLogger } from "@actana/search-shared/log";
import type { PairedClient } from "@actana/search-shared/pairing/pairing-code-digest";
import type { SearchHealth, SearchPairStatus } from "@actana/search/pairing-wire";
import { SEARCH_PROTOCOL_VERSION } from "@actana/search";
import { SEARCH_FEATURES, type Capabilities } from "@actana/search/contracts";
import { SCHEMA_VERSION } from "../db/schema.ts";
import {
  CLIENT_CERT_REFUSAL_CODE,
  CLIENT_CERT_REFUSAL_MESSAGE,
  CLIENT_CERT_REFUSAL_STATUS,
  clientCertGate,
  rejectUnauthorizedAtHandshake,
  upgradeGate,
} from "../pairing/preauth-gate.ts";
import { sendJson, sendRefusal } from "../pairing/pairing-routes.ts";
import type { PairingRateLimiter } from "../pairing/pairing-rate-limit.ts";
import type { PairingRevocations } from "../pairing/pairing-revocation.ts";
import {
  buildPairingEndpointResolver,
  buildPairingRoutes,
  isOpenPath,
  isPairingPath,
} from "../pairing/pairing-wiring.ts";
import type { SearchPairingStore } from "../pairing/pairing-store.ts";
import type { PersistedMaterial } from "@actana/search-shared/pairing/material-store";
import { clientAllowsKb } from "./routes.ts";
import type { SearchHttpRoutes, SearchRoute, SearchRouter } from "./routes.ts";

const logger = createLogger("api/server");

/** The environment variable that turns the handshake off. Development only. */
export const DEV_INSECURE_VAR = "SEARCH_DEV_INSECURE";

/** The header the insecure mode reads a caller from. Never read over TLS. */
export const DEV_CLIENT_HEADER = "x-paired-client";

/**
 * Is this a process the insecure mode is for?
 *
 * **Allow-list, not a deny-list, and that is the change.** Refusing only under
 * `NODE_ENV=production` made every environment that forgot to set `NODE_ENV` —
 * a bare `node src/index.ts`, a container whose entrypoint drops it, a staging
 * box nobody labelled — a environment where one variable turns the mTLS wall
 * off and makes `x-paired-client` an identity. An unset `NODE_ENV` is the
 * default, so the default has to be the refusal.
 *
 * Two ways in, both of which a test run has and a deployment does not:
 * `NODE_ENV=test`, which every runner sets, and `SEARCH_TEST_DATABASE_URL`,
 * which is what this repository's integration suites gate on.
 */
export function inATestEnvironment(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === "test" || (env.SEARCH_TEST_DATABASE_URL ?? "") !== "";
}

/** Refuse to serve plain HTTP outside a test, and say what it would have done. */
function assertNotInsecure(): never {
  throw new Error(
    `${DEV_INSECURE_VAR} is set outside a test environment. That mode serves plain HTTP and ` +
      `reads the caller from the ${DEV_CLIENT_HEADER} header, which is not an identity (ADR ` +
      "0003) — so it runs only where NODE_ENV=test or SEARCH_TEST_DATABASE_URL is set.",
  );
}

export type SearchServerOptions = {
  material: PersistedMaterial;
  store: SearchPairingStore;
  revocations: PairingRevocations;
  /** `SEARCH_PORT`. `0` asks the OS for a free one, which the tests do. */
  port: number;
  /** The interface to bind. Defaults to every one. */
  host?: string;
  /** `SEARCH_PUBLIC_HOST`, and whatever else the certificate covers. */
  publicHosts: readonly string[];
  /** Plain HTTP with `x-paired-client`. Refused under `NODE_ENV=production`. */
  devInsecure?: boolean;
  /** TASK-004's hook: every other route on the instance. */
  registerRoutes?: (router: SearchRouter) => void;
  /**
   * The pre-auth endpoint's rate limiter. A default one is made when omitted.
   *
   * Injectable for the suites, which pair a dozen clients in a second and would
   * otherwise spend the global window on themselves — and for no other reason:
   * the defaults are the ones a running instance uses.
   */
  pairingRateLimiter?: PairingRateLimiter;
};

export type SearchServer = {
  /** The port actually bound, which is what a `port: 0` caller needs. */
  port: number;
  /** `https://host:port`, or `http://…` in the insecure mode. */
  origin: string;
  close(): Promise<void>;
};

/**
 * Start the API listener.
 *
 * Resolves once the socket is bound, so a caller — a test, or `index.ts` —
 * knows the port before it hands the address to anybody.
 */
export async function startSearchServer(opts: SearchServerOptions): Promise<SearchServer> {
  const insecure = opts.devInsecure ?? false;
  if (insecure && !inATestEnvironment()) assertNotInsecure();

  const routes: SearchRoute[] = [];
  const router: SearchRouter = { add: (route) => routes.push(route) };
  registerBuiltinRoutes(router, opts);
  opts.registerRoutes?.(router);

  // The port is not known until the socket is bound — `port: 0` asks the OS
  // for one — and the endpoint a redemption hands back has to name the port
  // this instance is actually answering on, not the one it asked for.
  let boundPort = opts.port;
  const endpointFor = (session: Parameters<ReturnType<typeof buildPairingEndpointResolver>>[0]) =>
    buildPairingEndpointResolver({ publicHosts: opts.publicHosts, port: boundPort })(session);

  const pairing: SearchHttpRoutes = buildPairingRoutes({
    material: {
      caCert: opts.material.caCert,
      caKey: opts.material.caKey,
      bearerSecret: opts.material.bearerSecret,
      instanceId: opts.material.instanceId,
      instanceUuid: opts.material.instanceUuid,
    },
    sessions: opts.store,
    endpointFor,
    ...(opts.pairingRateLimiter ? { rateLimiter: opts.pairingRateLimiter } : {}),
  });

  const server = insecure
    ? http.createServer()
    : https.createServer({
        cert: opts.material.serverCert,
        key: opts.material.serverKey,
        ca: opts.material.caCert,
        requestCert: true,
        // True unless a pre-auth surface is mounted, in which case the
        // handshake has to complete for a client that has no certificate *yet*
        // — it is here to be issued one — and the same rule is enforced per
        // request below instead. `preauth-gate.ts` is where that trade is
        // written out; nothing about it is decided in this file.
        rejectUnauthorized: rejectUnauthorizedAtHandshake(isPairingPath),
      });

  // No protocol upgrade is served. The listener is here rather than absent so
  // that a `Connection: Upgrade` on an authenticated socket is refused
  // explicitly instead of hanging, and so the gate that would govern one is
  // already written when a later ticket wants an upgrade.
  server.on("upgrade", (req, socket) => {
    const allowed =
      upgradeGate(clientCertVerified(req), isRevokedPeer(req, opts.revocations)) === "serve";
    socket.write(
      allowed
        ? "HTTP/1.1 501 Not Implemented\r\nconnection: close\r\ncontent-length: 0\r\n\r\n"
        : `HTTP/1.1 ${CLIENT_CERT_REFUSAL_STATUS} Forbidden\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`,
    );
    socket.destroy();
  });

  server.on("request", (req, res) => {
    void serve(req, res, { routes, pairing, opts, insecure });
  });
  server.on("checkContinue", (req, res) => {
    if (!mayServe(req, opts.revocations)) return respondClientCertRequired(res);
    if (pairing.handleContinue(req, res)) return;
    // Everything else gets the continue and then the ordinary path.
    res.writeContinue();
    void serve(req, res, { routes, pairing, opts, insecure });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const port = (server.address() as AddressInfo).port;
  boundPort = port;
  const scheme = insecure ? "http" : "https";
  const origin = `${scheme}://${opts.publicHosts[0] ?? "localhost"}:${port}`;
  if (insecure) {
    logger.warn(
      `${DEV_INSECURE_VAR} is on: plain HTTP, and the caller is read from the ` +
        `${DEV_CLIENT_HEADER} header. Never run this outside a test.`,
      { port },
    );
  } else {
    logger.info("API listening (mTLS)", { port, origin });
  }

  return {
    port,
    origin,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

// ─── The gate and the identity ───────────────────────────────────────────────

type ServeContext = {
  routes: SearchRoute[];
  pairing: SearchHttpRoutes;
  opts: SearchServerOptions;
  insecure: boolean;
};

async function serve(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: ServeContext,
): Promise<void> {
  const url = new URL(req.url ?? "/", "https://search.invalid");

  // Step 2 — the gate, before a route is looked at, and before a body is read.
  if (!ctx.insecure && !mayServe(req, ctx.opts.revocations)) {
    return respondClientCertRequired(res);
  }

  // Step 1 of the router: the pre-auth family claims its one path.
  if (ctx.pairing.handle(req, res)) return;

  // Step 3 — who is asking.
  let client: PairedClient | null;
  try {
    client = ctx.insecure
      ? await devClientFromHeader(req, ctx.opts.store)
      : await pairedClientFromSocket(req, ctx.opts.store);
  } catch (err) {
    logger.error("Identity lookup failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return sendRefusal(res, {
      status: 503,
      code: "core-error",
      message: "this instance could not resolve the caller",
    });
  }

  // Step 4 — the router.
  const route = ctx.routes.find(
    (candidate) =>
      candidate.method === (req.method ?? "GET") &&
      (typeof candidate.path === "string"
        ? candidate.path === url.pathname
        : candidate.path(url.pathname)),
  );
  if (!route) {
    return sendRefusal(res, {
      status: 404,
      code: "not-found",
      message: `no route for ${req.method ?? "GET"} ${url.pathname}`,
    });
  }
  // `scope` absent is an open route — there are two, and both are named in
  // `registerBuiltinRoutes`. `scope: null` is "any paired client". A named
  // scope is checked against what the certificate's row was granted.
  if (route.scope !== undefined) {
    if (!client) return respondClientCertRequired(res);
    if (route.scope !== null && !scopeAllows(client.scope, route.scope)) {
      return sendRefusal(res, {
        status: 403,
        code: "scope-forbidden",
        message: `this client is scoped \`${client.scope}\` and this route needs \`${route.scope}\``,
      });
    }
  }

  // The KB half of the grant (ADR 0003), before the handler rather than inside
  // it: a route that declares `kbIdFrom` is enforced by having been registered.
  if (route.kbIdFrom) {
    const kbId = route.kbIdFrom(url);
    if (kbId !== null && !clientAllowsKb(client, kbId)) {
      return sendRefusal(res, {
        status: 403,
        code: "kb-forbidden",
        message: "this client's pairing does not cover that knowledge base",
      });
    }
  }

  try {
    await route.handle({ req, res, url, client, allowsKb: (kbId) => clientAllowsKb(client, kbId) });
  } catch (err) {
    logger.error("Route threw", {
      path: url.pathname,
      error: err instanceof Error ? err.message : String(err),
    });
    if (!res.headersSent) {
      sendRefusal(res, { status: 500, code: "core-error", message: "this instance failed" });
    } else {
      res.destroy();
    }
  }
}

/**
 * Is `held` at least `needed`?
 *
 * `admin` implies `write` implies `read`. Coarse on purpose (ADR 0003) — the
 * richer ACL is a conversation that belongs with Studio's, and leaving a coarse
 * slot on the wire means it does not have to change the wire.
 */
export function scopeAllows(held: string, needed: "read" | "write" | "admin"): boolean {
  const rank: Record<string, number> = { read: 1, write: 2, admin: 3 };
  return (rank[held] ?? 0) >= rank[needed];
}

/**
 * The paired client the certificate on this connection names, or `null`.
 *
 * By serial, then by fingerprint: Node reports the serial off the socket, and
 * the fingerprint is the fallback for a row written by something that recorded
 * one. A revoked row resolves to `null` — a certificate this CA signed whose
 * pairing was taken back is not an identity, and `clientCertGate` has already
 * refused it on the revocation set; this is the second answer to the same
 * question, from the row rather than from the cached set, so a revocation made
 * between two sweeps is not served.
 */
export async function pairedClientFromSocket(
  req: http.IncomingMessage,
  store: SearchPairingStore,
): Promise<PairedClient | null> {
  const socket = req.socket as unknown as {
    getPeerCertificate?: (detailed?: boolean) => { serialNumber?: string; fingerprint256?: string } | undefined;
  };
  if (typeof socket.getPeerCertificate !== "function") return null;
  let cert: { serialNumber?: string; fingerprint256?: string } | undefined;
  try {
    cert = socket.getPeerCertificate();
  } catch {
    return null;
  }
  if (!cert?.serialNumber && !cert?.fingerprint256) return null;
  const client = await store.findClientByCertificate({
    serial: cert.serialNumber ?? null,
    fingerprint: cert.fingerprint256 ?? null,
  });
  if (!client || client.revokedAt !== null) return null;
  void store.touchLastSeen(client.id).catch(() => {});
  return client;
}

/** The insecure mode's identity: a header, and only ever a header. */
async function devClientFromHeader(
  req: http.IncomingMessage,
  store: SearchPairingStore,
): Promise<PairedClient | null> {
  const id = String(req.headers[DEV_CLIENT_HEADER] ?? "").trim();
  if (id === "") return null;
  const client = await store.getClient(id);
  return client && client.revokedAt === null ? client : null;
}

/** Is this request allowed on the connection it arrived on? */
function mayServe(req: http.IncomingMessage, revocations: PairingRevocations): boolean {
  const pathname = new URL(req.url ?? "/", "https://search.invalid").pathname;
  return (
    clientCertGate({
      pathname,
      authorized: clientCertVerified(req),
      revoked: isRevokedPeer(req, revocations),
      isPreAuthPath: isOpenPath,
    }) === "serve"
  );
}

/** The serial of the client certificate on this request's socket, or null. */
function peerCertSerial(req: http.IncomingMessage): string | null {
  const socket = req.socket as unknown as {
    getPeerCertificate?: () => { serialNumber?: string } | undefined;
  };
  if (typeof socket.getPeerCertificate !== "function") return null;
  try {
    return socket.getPeerCertificate()?.serialNumber ?? null;
  } catch {
    return null;
  }
}

/** Did this request arrive on a certificate `pair revoke` took back? */
function isRevokedPeer(req: http.IncomingMessage, revocations: PairingRevocations): boolean {
  return revocations.isRevoked(peerCertSerial(req));
}

/**
 * Did this connection present a client certificate this instance's CA vouches
 * for?
 *
 * `authorized` is Node's own verdict from the handshake, and it is `undefined`
 * on a plain TCP socket. `!== false` rather than `=== true` says exactly that:
 * only a TLS socket that was *checked and failed* is unauthorized here.
 */
function clientCertVerified(req: http.IncomingMessage): boolean {
  const socket = req.socket as unknown as { authorized?: boolean };
  return socket.authorized !== false;
}

function respondClientCertRequired(res: http.ServerResponse): void {
  sendRefusal(res, {
    status: CLIENT_CERT_REFUSAL_STATUS,
    code: CLIENT_CERT_REFUSAL_CODE,
    message: CLIENT_CERT_REFUSAL_MESSAGE,
  });
}

// ─── The routes that exist today ─────────────────────────────────────────────

function registerBuiltinRoutes(router: SearchRouter, opts: SearchServerOptions): void {
  /**
   * Open, and the only open route besides the pre-auth one — it answers on a
   * connection with no certificate because a health check that needed a
   * credential would be a health check nobody could run. It says nothing a
   * caller could not learn by dialling the port. `isOpenPath` is where that is
   * decided; this handler only answers.
   */
  router.add({
    method: "GET",
    path: "/v1/health",
    handle: ({ res, client }) => {
      // `{ ok }` and nothing else to a caller with no certificate. The schema
      // version is a fact about this deployment's build, and the caller that
      // needs it — an SDK deciding whether it is newer than the instance — has
      // a certificate by then, so it can read it off `/v1/capabilities`. A
      // health check does not need it and an unauthenticated stranger has no
      // business being told it.
      const body: SearchHealth = client
        ? { ok: true, schemaVersion: SCHEMA_VERSION }
        : { ok: true };
      sendJson(res, 200, body);
    },
  });

  /** Who am I, and what was I granted. Any paired client may ask. */
  router.add({
    method: "GET",
    path: "/v1/pair/status",
    scope: "read",
    handle: ({ res, client }) => {
      if (!client) return respondClientCertRequired(res);
      const body: SearchPairStatus = {
        id: client.id,
        label: client.label,
        platform: client.platform,
        scope: client.scope,
        kbIds: client.kbIds,
        certSerial: client.certSerial,
        certNotAfter: client.certNotAfter ? new Date(client.certNotAfter).toISOString() : null,
        pairedAt: new Date(client.pairedAt).toISOString(),
      };
      sendJson(res, 200, body);
    },
  });

  /**
   * What this instance can do.
   *
   * The feature list is `SEARCH_FEATURES` in the contracts — the whole closed
   * enum, because this build serves all of it. It is a list rather than a
   * version number so that a caller tests membership (`features.includes
   * ("v1-tags")`) instead of inferring capability from an ordering nobody
   * agreed on.
   */
  router.add({
    method: "GET",
    path: "/v1/capabilities",
    scope: "read",
    handle: ({ res }) => {
      const body: Capabilities = {
        protocol: SEARCH_PROTOCOL_VERSION,
        schemaVersion: SCHEMA_VERSION,
        features: [...SEARCH_FEATURES],
        publicHost: opts.publicHosts[0] ?? "localhost",
      };
      sendJson(res, 200, body);
    },
  });
}
