// The pairing route's wire contract, and nothing else.
//
// **Copied from actana/control `packages/sdk/src/core-pairing-wire.ts`** (its
// ADR 0034 D12), field for field. The type names carry `Search` where
// Control's carry `Core`; **the JSON does not change**, and that is the point
// of the copy: a Studio sidecar that already posts a `CorePairingRedeemRequest`
// at a Core posts the same bytes at a Search instance, and TASK-015 can lift
// one implementation into a package both repositories consume without a wire
// change. ADR 0008 records what has to stay identical.
//
// This file exists so that the redeem request and response have **one**
// definition rather than two structurally identical ones: the SDK declares
// them and `packages/search/src/pairing/pairing-routes.ts` imports them, so
// renaming or retyping a field stops the server compiling instead of producing
// two processes that disagree at runtime.
//
// It is a separate module from `pairing.ts` because of what the server may
// import: **no I/O, no transport and no imports of its own.** `pairing.ts`
// dials, hashes and reads certificates, so a server importing it would be a
// server dialling itself. This file has no imports, and that is a property to
// preserve rather than a coincidence.

/** The one route a client with no certificate may reach on a Search instance. */
export const SEARCH_PAIRING_REDEEM_PATH = "/v1/pair/redeem";

/** Everything the pairing family answers lives under here. */
export const SEARCH_PAIRING_ROUTE_PREFIX = "/v1/pair/";

/**
 * What the client says about itself.
 *
 * The server keeps the label and the platform and ignores the rest. "Ignores"
 * is the honest word and is checked by the route's parser: an optional field a
 * server drops is a client courtesy, not a promise the server has broken.
 *
 * Control stores only the label; Search stores the platform too, because
 * `search.paired_client` has a column for it and an operator listing their
 * clients wants to know which machine is which. Nothing is *decided* by it.
 */
export type SearchPairingClientInfo = {
  /** The machine's own name for itself, e.g. a hostname. */
  label?: string;
  /** `process.platform`, sent by the CLI and by Studio's sidecar. */
  platform?: string;
};

/**
 * The redemption request body.
 *
 * `sessionId` names the pairing session the code belongs to and is not
 * optional: the server hashes a candidate code together with the session id and
 * refuses to search for a session a code might fit, which is what stops a code
 * lifted from one session being replayed against another (ADR 0034 D11). An
 * operator carries one token, `<sessionId>:<XXXX-XXXX>`, and `pairWithSearch`
 * splits it.
 */
export type SearchPairingRedeemRequest = {
  sessionId: string;
  code: string;
  client: SearchPairingClientInfo;
  /** PEM `CERTIFICATE REQUEST`. The private half is not in this object. */
  csr: string;
};

/**
 * The 200 body.
 *
 * Four fields, and the absence of a fifth is the point: there is no key here,
 * because the server never had one. `pairWithSearch` supplies the fifth from
 * the key it generated locally, which is what makes the result a registration
 * blob.
 *
 * `bearer` is Control's fourth field and is carried unchanged so the body is
 * byte-compatible. **Search never reads one back** — the certificate is the
 * identity (ADR 0003) — and `packages/shared/src/pairing/bearer.ts` says so at
 * the code that mints it.
 */
export type SearchPairingRedeemResponse = {
  /** The `https://host:port` this client posts to from now on. */
  endpoint: string;
  /** PEM CA certificate — the trust anchor for every later dial. */
  caCert: string;
  /** PEM client certificate, signed from the CSR just posted. */
  clientCert: string;
  /** The signed bearer. Inert in Search; present because Control's body has it. */
  bearer: string;
};

/** A refusal body, as every non-200 answer from the pairing route is shaped. */
export type SearchPairingRefusalBody = {
  /** The machine-readable reason, e.g. `pairing-refused`. */
  code?: string;
  /** The human-readable one. */
  error?: string;
};

/**
 * What `GET /v1/pair/status` answers an authenticated client with.
 *
 * Search's own, with no counterpart in Control: it is the "who am I" a paired
 * client needs to find out what its certificate was granted without guessing
 * from what a route refuses.
 */
export type SearchPairStatus = {
  /** The paired client's row id. */
  id: string;
  label: string;
  platform: string | null;
  /** `read`, `write` or `admin` (ADR 0003). */
  scope: "read" | "write" | "admin";
  /** The KB ids this client may touch, or `null` for all of its own. */
  kbIds: string[] | null;
  /** Hex serial of the certificate presented on this connection. */
  certSerial: string;
  /** ISO-8601, or `null` on the plain-HTTP development path. */
  certNotAfter: string | null;
  pairedAt: string;
};

/**
 * What `GET /v1/health` answers.
 *
 * `ok` always; `schemaVersion` only to a caller whose certificate resolved. An
 * unauthenticated stranger is told the instance is up and nothing about the
 * build it is running — the caller that needs the version is an SDK deciding
 * whether it is newer than the instance, and by then it has a certificate and
 * can read `GET /v1/capabilities`.
 */
export type SearchHealth = {
  ok: boolean;
  /** The migration count the instance has applied. Authenticated callers only. */
  schemaVersion?: number;
};
