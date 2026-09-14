// Registration blob — the credential a paired client holds, as a client keeps
// it at rest.
//
// **Copied from actana/control `packages/shared/src/registration-blob.ts`**
// (its ADR 0034 D8), with one deliberate difference named below. ADR 0008
// records the copy.
//
// **This is a storage format, not an artifact anybody carries.** The key inside
// it never crossed a wire: the client generated it, sent a CSR, and assembled
// this shape from the 200 body plus the key it kept. Nothing prints one and
// nothing reads one out of a terminal.
//
// The encoding is `base64(JSON({endpoint, label, caCert, clientCert, clientKey,
// bearer}))` — Control's fields, in Control's spelling, so a client that
// already holds a `CoreRegistrationBlob` holds this one.
//
// **The one difference: `endpoint` is `https://`, not `wss://`.** Control's
// decoder refuses anything but `wss://` because a Core's transport is a
// WebSocket and a `ws://` entry in a blob is a downgrade. Search has no
// WebSocket — its endpoint is the HTTPS origin the SDK posts to — so the same
// refusal is spelled `https://` here. It is the only field whose *value* shape
// differs from Control's; the field list does not.

/** The decoded shape of a registration blob. */
export type SearchRegistrationBlob = {
  /** `https://<host>:<port>` — the instance's API origin. */
  endpoint: string;
  /** Human-friendly alias (optional in the blob; "" if absent). */
  label?: string;
  /** PEM-encoded self-signed CA cert that signed the server cert. */
  caCert: string;
  /** PEM-encoded client cert presented in the mTLS handshake. */
  clientCert: string;
  /** PEM-encoded private key for {@link SearchRegistrationBlob.clientCert}. */
  clientKey: string;
  /** The signed bearer. Inert in Search — see `bearer.ts`. */
  bearer: string;
};

/** Encode a registration blob into the single base64 line a store holds. */
export function encodeRegistrationBlob(blob: SearchRegistrationBlob): string {
  const json = JSON.stringify({
    endpoint: blob.endpoint,
    label: blob.label ?? "",
    caCert: blob.caCert,
    clientCert: blob.clientCert,
    clientKey: blob.clientKey,
    bearer: blob.bearer,
  });
  return Buffer.from(json, "utf8").toString("base64");
}

/**
 * Decode a stored registration blob. Returns `null` for any malformed input:
 * bad base64, non-JSON, missing required fields, wrong-typed fields, or an
 * endpoint that is not `https://` (mTLS is mandatory — ADR 0003).
 *
 * Surrounding whitespace (a trailing newline on a file) is tolerated.
 */
export function decodeRegistrationBlob(raw: string): SearchRegistrationBlob | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let json: string;
  try {
    json = Buffer.from(trimmed, "base64").toString("utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
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
  // A plain-HTTP endpoint in a blob is a downgrade attack or a misconfigured
  // instance — reject it rather than letting a credential through that would
  // present no certificate and pin nothing.
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
