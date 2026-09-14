# The paired client is the identity

Search speaks to its clients over mutual TLS, and the client certificate is the
identity. There is exactly one route reachable without a certificate —
`POST /v1/pair/redeem`, which turns a short-lived pairing code into a
registration blob — and every other route resolves its caller from the
certificate presented on the connection. No route reads a client id, a tenant
id or a workspace id from a URL, a body or a header, because there is nothing
to read: the row that says who is asking is found by certificate serial, not by
a parameter the caller chose.

The mechanism is **Actana Control's, copied as it is**: the same CA, the same
pre-auth gate, the same short-code pairing session, the same per-client
certificate issuance and revocation. It is proven, it is already understood by
everyone who works on Control, and a second implementation of a pairing
handshake is a second place for it to be wrong.

The record is `search.paired_client`, and it is deliberately **not** called a
tenant. Search does not know what a workspace is (ADR 0002). It knows that a
certificate belongs to a client, that the client has scopes — `read`, `write`,
`admin` — and optionally a list of KB ids it may touch.

## Considered Options

- **Bearer tokens or API keys (rejected).** Simpler to issue and simpler to
  leak: a key travels in a header through every proxy, log and crash report on
  the path, and revoking one is a database write that a cached client may not
  notice. A certificate is bound to the connection, and the revocation story is
  a CRL rather than a hope.
- **Reuse Studio's session and ACL layer (rejected).** It would make Search's
  authorisation depend on Studio's user model, which is exactly the coupling the
  split exists to remove, and it would leave Search unable to serve a client
  that is not Studio.
- **Write a fresh pairing implementation shaped for Search (rejected).** Search
  is the *second* user of Control's pairing, and two users is what turns code
  into a library. Copying it first and extracting it afterwards (a Control-side
  task) is cheaper and leaves one implementation, not three.
- **Fine-grained permissions from the start (deferred).** The scope vocabulary
  is deliberately coarse. A richer ACL is a real conversation and it belongs
  with Studio's own ACL and agent-token discussion; leaving a coarse slot on the
  wire means that conversation does not have to change the wire.

## Consequences

- `POST /v1/pair/redeem` is the only pre-auth route and is treated as a
  security boundary: single-use codes, short expiry, attempt counting.
- Studio's ACL does not move. `checkKnowledgeBaseAccess` and the workspace
  assertions stay in Studio and run *before* the SDK call. Search's own check is
  the paired client's scope, applied in the API layer — which is why the lifted
  engine modules had their ACL branches cut rather than ported.
- Crew agent tokens stay in Studio too: minted there, validated there, and the
  query route behind them calls Search like any other caller.
- Bun cannot be the client: `getPeerCertificate(true)` returns only the leaf, so
  Studio talks to Search from a small Node sidecar, exactly as it does for
  Control's Cores.
- Once this is proven here, the pairing and certificate code is lifted out of
  Control into its own package and both repos consume it.
