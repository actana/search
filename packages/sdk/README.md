# `@actana/search`

The typed client for an [actana/search](https://github.com/actana/search)
instance, and the wire it speaks. **This package is the only supported way into
a Search instance** — nothing above the service reads its tables.

```bash
npm install @actana/search
```

Node 22 or newer.

## Pairing, then querying

A Search instance speaks mutual TLS and the client certificate is the identity
(ADR 0003). There is exactly one route reachable without one —
`POST /v1/pair/redeem` — and it turns a short-lived pairing code into the
credential every other route requires.

An operator runs `pair new` on the instance and reads out two things: a ticket
(`<sessionId>:<XXXX-XXXX>`) and the SHA-256 fingerprint of that instance's CA.

```ts
import { SearchClient } from "@actana/search/client";
import { pairWithSearch } from "@actana/search/pairing";

// One redemption, once. The key pair is generated here and the private half
// never crosses the wire — what goes out is a CSR.
const blob = await pairWithSearch({
  address: "search.internal:7443",
  code: "ps_7c1f:QK4M-9TRW",
  expectedCaFingerprint: "3B:AF:…:C1",
  client: { label: "actanastudio", platform: process.platform },
});
// Seal `blob` and keep it: it is this machine's credential.

const search = SearchClient.fromRegistrationBlob(blob);

const kb = await search.kbs.create({ name: "Handbook", embeddingEndpointId });
const doc = await search.kbs.ingest(kb.id, { filename: "handbook.md", text });
const result = await search.kbs.query(kb.id, {
  text: "parental leave policy",
  topK: 5,
});
```

The `kbs`, `documents`, `keywords`, `clusters`, `tags`, `endpoints`, `webhooks`
and `events()` namespaces land with the REST surface in TASK-004 and throw
`SearchApiError { code: "not-implemented" }` until then — so the snippet above
is what the client will look like, not what it does yet. `health()`,
`capabilities()`, `pairStatus()` and `request(method, path, …)` work today.

## The fingerprint is not optional

`pairWithSearch` dials once with nothing trusted, compares the CA it is
presented against `expectedCaFingerprint` **before it sends the code**, and then
redeems on a second connection pinned to that exact certificate. Passing no
fingerprint is not "skip the check": it fails with `fingerprint-unconfirmed`,
reports the fingerprint it saw, and the code stays unsent.

```ts
import { fetchSearchPairingIdentity } from "@actana/search/pairing";

// First contact, with no code to leak: show the operator both fingerprints.
const { fingerprint, caCert } = await fetchSearchPairingIdentity({
  address: "search.internal:7443",
});
```

## Errors

Pairing throws `SearchPairingError` with a `failure` from a fixed list —
`bad-address`, `bad-code`, `bad-fingerprint`, `unreachable`,
`fingerprint-unconfirmed`, `fingerprint-mismatch`, `hostname-mismatch`,
`certificate-invalid`, `refused`, `rate-limited`, `rejected`, `not-pairable`,
`core-error`, `malformed-response`. Switch on `failure`; do not read the
message.

`refused` covers a wrong code, an expired session, one already redeemed and one
out of attempts, because the instance answers all four identically on purpose:
telling them apart would tell an unauthenticated caller whether a session exists
and whether their last guess was closer. The distinction is in the instance's
audit log.

Everything else throws `SearchApiError { code, status, detail }`, where `code`
is the instance's own machine-readable reason.

## Layout

| Entry point | What is in it |
|---|---|
| `@actana/search` | everything below, re-exported |
| `@actana/search/client` | `SearchClient` |
| `@actana/search/pairing` | `pairWithSearch`, `fetchSearchPairingIdentity`, `SearchPairingError` |
| `@actana/search/pairing-wire` | the redeem request and response types — one definition, imported by the server too |
| `@actana/search/pairing-csr` | the key pair and CSR, generated locally |
| `@actana/search/registration-blob` | the credential's storage codec |
| `@actana/search/errors` | `SearchApiError` |

`@actana/search/contracts` — the zod request, response and event schemas — lands
with the REST surface in TASK-004. It is not in this release and importing it
fails; the table above is what resolves today.

## Dependencies

`undici` and `zod`, and that is the whole list. The CSR encoder is hand-written
(`pairing-csr.ts`) rather than a dependency, because the alternative is pulling
an X.509 library into every consumer of this package to produce four DER fields
in a fixed order.

## Licence

MIT.
