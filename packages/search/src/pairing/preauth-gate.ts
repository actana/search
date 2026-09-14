// The one hole in Search's mTLS wall, and the wall around it.
//
// **Copied from actana/control `packages/core/src/core-preauth-gate.ts`** (its
// ADR 0034 D2) — the clause ADR 0034 calls non-negotiable, and therefore the
// one file in this copy that is reproduced verbatim apart from its prose. ADR
// 0007 records the copy.
//
// Every route on a Search instance sits behind the mutual TLS handshake:
// `api/server.ts` builds its `https.Server` with `requestCert: true,
// rejectUnauthorized: true`, so a client with no certificate is refused by TLS
// before a byte of HTTP is parsed. Pairing is the
// one exchange where that cannot hold — the client is posting a CSR precisely
// *because* it has no certificate yet — and this module is how the exception is
// made without becoming a hole.
//
// **Why the TLS flag has to move at all.** There is no per-route TLS. A
// server either demands a verified client certificate to complete a handshake
// or it does not, and the decision is made before the request line exists. So
// an instance that serves a pre-auth route completes the handshake without one
// (`rejectUnauthorized: false`, with `requestCert` still true so a certificate
// that *is* presented is still parsed and verified) and enforces the same rule
// one layer up, per request, from `socket.authorized`.
//
// **What that costs, stated plainly.** Refusal moves from the TLS layer to the
// HTTP layer: an unauthenticated caller now gets a `403` where they used to get
// a handshake failure. What it does not cost is access — the gate below is
// applied to every request and every WebSocket upgrade, and it defaults to
// refusing.
//
// **And an instance with no pairing surface does not pay it.** No pre-auth
// path means the server keeps `rejectUnauthorized: true`, TLS refusal and all.
// The relaxation is scoped to the instances that mount the endpoint, which is
// what "without weakening the mTLS posture of every other route" means here.

/** Does this pathname name the pre-auth surface? See `pairing-wiring.ts`. */
export type PreAuthPathPredicate = (pathname: string) => boolean;

/** What the gate decides. There is no third answer. */
export type ClientCertVerdict = "serve" | "refuse";

/** The status a refused request gets, and the body that explains it. */
export const CLIENT_CERT_REFUSAL_STATUS = 403;
export const CLIENT_CERT_REFUSAL_CODE = "client-certificate-required";
export const CLIENT_CERT_REFUSAL_MESSAGE =
  "this Search instance requires a client certificate on every route but its pairing endpoint";

/**
 * May this request be served on a connection that presented no verified client
 * certificate?
 *
 * The default is `refuse`, and every argument has to line up to get anything
 * else: an authorized connection is served whatever it asked for, and an
 * unauthorized one is served only what the predicate names.
 *
 * `isPreAuthPath` absent means no pre-auth surface is mounted. Such a server
 * keeps `rejectUnauthorized: true` and never reaches this function with
 * `authorized: false` — but it answers `refuse` if it does, because a gate
 * whose safety depends on a flag set somewhere else is not a gate.
 *
 * **`revoked` is checked before anything else, `authorized` included.**
 * A revoked client's certificate is still signed by this instance's CA and
 * still completes the handshake — TLS has no idea an operator took it back — so
 * `authorized: true` is exactly what a revoked client arrives with, and a gate
 * that read it first would serve every one of them. Revocation is also the one
 * refusal with no pre-auth exception: a client here to *redeem a code* has no
 * certificate to have had revoked, so nothing legitimate is turned away.
 */
export function clientCertGate(opts: {
  pathname: string;
  authorized: boolean;
  /** Did this connection present a certificate `pair revoke` took back? */
  revoked?: boolean;
  isPreAuthPath?: PreAuthPathPredicate;
}): ClientCertVerdict {
  if (opts.revoked) return "refuse";
  if (opts.authorized) return "serve";
  if (!opts.isPreAuthPath) return "refuse";
  return opts.isPreAuthPath(opts.pathname) ? "serve" : "refuse";
}

/**
 * May this connection be upgraded to a protocol other than HTTP?
 *
 * Separate from {@link clientCertGate} because the answer is not a function of
 * the path: no pairing exception reaches an upgrade, ever. Search mounts no
 * WebSocket today, and this is why an upgrade that appears later cannot inherit
 * the pre-auth hole by accident — it has to come here and argue for it.
 *
 * `revoked` refuses for the reason spelled out on {@link clientCertGate}: a
 * revoked certificate is a valid certificate, and this is the layer that knows
 * the difference.
 */
export function upgradeGate(authorized: boolean, revoked = false): ClientCertVerdict {
  if (revoked) return "refuse";
  return authorized ? "serve" : "refuse";
}

/**
 * Should the TLS server demand a verified client certificate to complete the
 * handshake at all?
 *
 * Yes unless a pre-auth surface is mounted — see the header. Written as a named
 * function rather than inlined at the `https.createServer` call so that the one
 * line that relaxes this instance's TLS posture is a line with a name, a reason
 * and a test, rather than a ternary inside an options object.
 */
export function rejectUnauthorizedAtHandshake(isPreAuthPath: PreAuthPathPredicate | undefined): boolean {
  return isPreAuthPath === undefined;
}
