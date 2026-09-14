// How the server mounts the pairing endpoint, and what the mTLS gate is told
// about it.
//
// **Copied from actana/control `packages/core/src/core-pairing-wiring.ts`**
// (ADR 0008). Its three decisions are kept, and the second one is *narrowed*.
//
//   1. **Order.** The pairing family is consulted before everything else, so a
//      later family that claims a prefix cannot end up answering the pre-auth
//      route with a 403 a client with no certificate cannot act on.
//   2. **Exactly one path is pre-auth — and here that is one *path*, not one
//      prefix.** Control's predicate names `/v1/pair/` because every route
//      under it is the redeem route. Search adds `GET /v1/pair/status`, which
//      is authenticated, so the predicate below names
//      `POST /v1/pair/redeem`'s pathname and nothing else. Reading it as a
//      prefix would have made `status` reachable without a certificate — a
//      second pre-auth route acquired by accident, which is exactly what ADR
//      0034 D2 says must be a decision instead. `preauth-gate.test.ts` holds
//      this as a named case.
//   3. **An instance without pairing material mounts nothing**, and through the
//      gate, does not relax its TLS handshake either.
//   4. **Which address a redemption hands back is decided here**, from the
//      configured hosts and from nothing on the request.

import type { SearchHttpRoutes } from "../api/routes.ts";
import type { PairingSession } from "@actana/search-shared/pairing/pairing-session";
import {
  SEARCH_PAIRING_REDEEM_PATH,
  createPairingRequestHandler,
  type SearchPairingRoutesOptions,
} from "./pairing-routes.ts";

/**
 * Is this pathname the pre-auth surface? The whole of it, and only it.
 *
 * An exact match, deliberately — see decision 2 in the header.
 */
export function isPairingPath(pathname: string): boolean {
  return pathname === SEARCH_PAIRING_REDEEM_PATH;
}

/** The one route besides the pre-auth one that answers without a certificate. */
export const SEARCH_HEALTH_PATH = "/v1/health";

/**
 * May this path be served on a connection that presented no certificate?
 *
 * Two paths, and the second one is a deliberate addition to Control's set that
 * ADR 0008 records rather than smuggles.
 *
 *   * `POST /v1/pair/redeem` — the pre-auth surface. It **grants** something:
 *     a certificate this instance's CA vouches for. Every defence ADR 0034
 *     names is on it.
 *   * `GET /v1/health` — it grants nothing, mutates nothing, reads no client
 *     and answers `{ ok, schemaVersion }`, which is what a caller learns by
 *     dialling the port and reading the certificate anyway. A health check that
 *     needed a credential is a health check the thing that restarts this
 *     process cannot run.
 *
 * The distinction is kept in the *names*: `isPairingPath` is the pre-auth
 * surface and stays one route wide, and this is the wider question the gate
 * asks. A third entry here is a change to ADR 0003 and ADR 0008, not a routine
 * addition — and `preauth-gate.test.ts` enumerates the set so that adding one
 * has to edit a test that says so.
 */
export function isOpenPath(pathname: string): boolean {
  return isPairingPath(pathname) || pathname === SEARCH_HEALTH_PATH;
}

/** Build the pairing route family. */
export function buildPairingRoutes(opts: SearchPairingRoutesOptions): SearchHttpRoutes {
  return createPairingRequestHandler(opts);
}

/**
 * Compose several route families into the one surface the server mounts.
 *
 * First to claim a request answers it; a family that returns `false` has said
 * the path is none of its business. Everything nobody claims falls through to
 * the server's own 404.
 *
 * **Order is the argument order**, and decision 1 is why that matters.
 */
export function composeHttpRoutes(...families: SearchHttpRoutes[]): SearchHttpRoutes {
  return {
    handle: (req, res) => families.some((family) => family.handle(req, res)),
    handleContinue: (req, res) => families.some((family) => family.handleContinue(req, res)),
  };
}

/** What a redemption's endpoint is built out of: this instance's own address. */
export type PairingEndpointOptions = {
  /** Every address the server certificate covers, in the operator's order. */
  publicHosts: readonly string[];
  /** The port the API listens on — the same one for every address. */
  port: number;
};

/**
 * Build the `endpointFor` the redeem route answers with.
 *
 * **The instance decides, not the request.** No header, no body field and no
 * socket address reaches this function, which is what keeps the property the
 * route has always had: a client pins the address this instance chose for it,
 * never one a caller supplied. A `Host` header is chosen by the caller, and a
 * client that pinned it would have pinned whatever an attacker wrote there.
 *
 * The session is the only input, and today it names no host of its own — that
 * is Control's per-session endpoint (its ADR 0038), which Search has not taken:
 * one instance, one primary address. The parameter is here rather than absent
 * so that taking it later is a change to this function and not to the route.
 */
export function buildPairingEndpointResolver(
  opts: PairingEndpointOptions,
): (session: PairingSession) => string {
  const primary = primaryPublicHost(opts.publicHosts);
  return (_session) => `https://${authority(primary)}:${opts.port}`;
}

/** The first configured host, or loopback when nothing was configured. */
export function primaryPublicHost(hosts: readonly string[]): string {
  const named = hosts.map((host) => host.trim()).filter((host) => host.length > 0);
  return named[0] ?? "localhost";
}

/** An IPv6 literal needs brackets before it can be a URL authority. */
function authority(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}
