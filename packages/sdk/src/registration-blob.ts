// The registration blob, as a Search client reads it.
//
// **Copied from actana/control `packages/sdk/src/core-registration-blob.ts`**
// (ADR 0008). Two deliberate boundaries survive the copy, and one thing
// changes.
//
// **The SDK takes a blob object, never a file.** Where the blob is kept — a
// file, an environment variable, Studio's `workspace_search` row sealed with
// `encryptSecret` — is the caller's business. Nothing here reads a path or
// base64-decodes a paste.
//
// **The shape is declared here, not imported from `@actana/search-shared`.**
// That package is private, so an SDK importing from it would be a published
// package with a dependency nobody outside this repository can resolve. The two
// declarations are structurally identical and the field names are the wire's
// rather than either side's, so a holder of one passes it to the other with no
// conversion.
//
// **What changes: the scheme.** A Core's endpoint is `wss://` because its
// transport is a WebSocket. Search's is `https://`, because its transport is
// the same mTLS HTTPS server the pairing route answers on. Everything else —
// the six fields, their names, their meanings — is Control's.

/** The PEM material an mTLS dial needs. */
export type SearchTlsMaterial = {
  /** PEM CA certificate to pin the server against. */
  ca: string;
  /** PEM client certificate to present. */
  cert: string;
  /** PEM private key for that certificate. Born on this machine. */
  key: string;
};

/**
 * A decoded registration blob. `endpoint` is the instance's `https://host:port`
 * origin; `label` is the machine's own suggestion for an alias and is not used
 * by anything here.
 */
export type SearchRegistrationBlob = {
  endpoint: string;
  label?: string;
  caCert: string;
  clientCert: string;
  clientKey: string;
  /** Inert in Search — see `pairing-wire.ts`. Carried so the blob is Control's. */
  bearer: string;
};

/**
 * Everything a blob says about how to reach one instance, unpacked into the
 * parts a client dials with.
 *
 * `httpsBaseUrl` is the origin every request is posted to — no path, no
 * trailing slash. It is the endpoint itself for a Search blob, and the
 * conversion below exists anyway so that a caller holding a Control-shaped
 * `wss://` endpoint (an operator pasting the wrong credential, a future Core
 * that fronts a Search) is corrected rather than silently dialled.
 */
export type SearchConnection = {
  /** The `https://` origin of the instance. No path, no trailing slash. */
  httpsBaseUrl: string;
  /** The PEM material for the mTLS handshake, or null for a plain-HTTP dial. */
  tls: SearchTlsMaterial | null;
  /** The bearer the blob carried. Search reads none; kept for the shape. */
  bearer: string;
};

/** Unpack a registration blob into a {@link SearchConnection}. */
export function searchConnectionFromBlob(blob: SearchRegistrationBlob): SearchConnection {
  const base = httpsBaseUrlFor(blob.endpoint.trim());
  return {
    httpsBaseUrl: base,
    tls: base.startsWith("https://")
      ? { ca: blob.caCert, cert: blob.clientCert, key: blob.clientKey }
      : null,
    bearer: blob.bearer,
  };
}

/**
 * `wss://host:port` → `https://host:port`, `ws://…` → `http://…`, and an
 * `https://`/`http://` origin trimmed of its trailing slashes.
 *
 * Anything else is returned unchanged rather than guessed at — a caller that
 * handed this a URL with no recognised scheme knows something about its
 * instance that this function does not.
 */
export function httpsBaseUrlFor(url: string): string {
  if (url.startsWith("wss://")) return `https://${url.slice("wss://".length)}`.replace(/\/+$/, "");
  if (url.startsWith("ws://")) return `http://${url.slice("ws://".length)}`.replace(/\/+$/, "");
  if (url.startsWith("https://") || url.startsWith("http://")) return url.replace(/\/+$/, "");
  return url;
}

/** Encode a registration blob into the single base64 line a store holds. */
export function encodeRegistrationBlob(blob: SearchRegistrationBlob): string {
  return Buffer.from(
    JSON.stringify({
      endpoint: blob.endpoint,
      label: blob.label ?? "",
      caCert: blob.caCert,
      clientCert: blob.clientCert,
      clientKey: blob.clientKey,
      bearer: blob.bearer,
    }),
    "utf8",
  ).toString("base64");
}

/**
 * Decode a stored registration blob, or `null` for anything malformed: bad
 * base64, non-JSON, missing or wrong-typed fields, or an endpoint that is not
 * `https://` — mTLS is mandatory (ADR 0003), and a plain-HTTP endpoint in a
 * blob is a downgrade rather than a configuration.
 */
export function decodeRegistrationBlob(raw: string): SearchRegistrationBlob | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(trimmed, "base64").toString("utf8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const o = parsed as Record<string, unknown>;
  const { endpoint, label, caCert, clientCert, clientKey, bearer } = o;
  if (
    typeof endpoint !== "string" ||
    typeof caCert !== "string" ||
    typeof clientCert !== "string" ||
    typeof clientKey !== "string" ||
    typeof bearer !== "string"
  ) {
    return null;
  }
  if (!endpoint.startsWith("https://")) return null;
  return {
    endpoint,
    label: typeof label === "string" ? label : "",
    caCert,
    clientCert,
    clientKey,
    bearer,
  };
}
