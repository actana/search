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

Namespaces: `kbs`, `documents`, `keywords`, `clusters`, `tags`, `endpoints`,
`webhooks`, plus `events()`, `capabilities()`, `health()`, `pairStatus()` and
`request(method, path, …)` for a route with no method yet. Every route on the
instance is reachable through one of them —
[`docs/external-api.md`](https://github.com/actana/search/blob/main/docs/external-api.md)
is the table.

## Ingest is asynchronous, and the encoding is a choice about behaviour

```ts
// A file. Multipart, and the resumable worker pipeline: parse → chunk → plan
// → embed → finalize → keyword.
const fromFile = await search.kbs.ingest(kb.id, {
  filename: "handbook.md",
  file: await readFile("handbook.md"),          // Buffer, Uint8Array or Blob
  tags: { tag1: "handbook" },
});

// A string. JSON, and `ingestDocument`: chunked and embedded in one pass,
// written only to the KB's partition, and the only path that stores the
// caller's `metadata` on every chunk.
const fromText = await search.kbs.ingest(kb.id, {
  filename: "notes.md",
  text: "…",
  metadata: { category: "handbook" },
});
```

The two produce measurably different corpora from the same bytes, and both are
frozen behaviour — so pick the one whose ranking you want rather than the one
whose encoding is convenient.

Either way what comes back is `{ documentId, processingStatus }` before any of
the work has happened. Wait for it by polling, or by listening:

```ts
for await (const event of search.events()) {
  if (event.event === "document.ingested" && event.documentId === fromFile.documentId) break;
}
```

## One query route, two retrieval paths

```ts
// The hybrid blend: the instance picks the query's keywords out of this KB's
// own vocabulary, then ranks keyword + semantic together.
await search.kbs.query(kb.id, { text: "parental leave", topK: 5 });

// Pure semantic, whatever `keywordWeight` says: an explicitly empty
// `queryKeywords` blends nothing. Omitting it and sending `[]` are different
// requests and return different documents.
await search.kbs.query(kb.id, { text: "parental leave", queryKeywords: [] });

// The v1 path: tag filter first, vector search over what survives. Rows carry
// their tag columns and a cosine `distance` instead of a blended score.
await search.kbs.query(kb.id, {
  mode: "v1-tags",
  text: "parental leave",
  tags: [{ tagSlot: "tag1", fieldType: "text", operator: "eq", value: "handbook" }],
});
```

The response is a discriminated union on `mode`, so narrowing on it gives you
the right `matches`.

## The wire, as schemas

```ts
import { QueryRequestSchema, SearchEventSchema } from "@actana/search/contracts";
```

Every request, response, error and event shape is a zod schema in
`@actana/search/contracts`, and **the instance validates with those exact
objects** — this package is where the protocol is defined, not a client written
against it. Validate a webhook body you received, build a request you are about
to send, or read a schema instead of a prose description.

## Verifying a webhook

```ts
import { createHmac, timingSafeEqual } from "node:crypto";
import { SEARCH_SIGNATURE_PREFIX, SearchEventSchema } from "@actana/search/contracts";

// `raw` is the body as received. Never a re-encoding of the parsed JSON: two
// encoders disagree on key order, and a check over your own re-encoding passes
// on a body you never saw.
function verify(secret: string, raw: Buffer, header: string): boolean {
  const expected = createHmac("sha256", secret).update(raw).digest("hex");
  const offered = Buffer.from(header.slice(SEARCH_SIGNATURE_PREFIX.length), "hex");
  return (
    header.startsWith(SEARCH_SIGNATURE_PREFIX) &&
    offered.length === 32 &&
    timingSafeEqual(offered, Buffer.from(expected, "hex"))
  );
}

const event = SearchEventSchema.parse(JSON.parse(raw.toString("utf8")));
```

`x-search-event-id` is deterministic, so a redelivery after an ambiguous timeout
carries the id you already saw — deduplicate on it.

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
| `@actana/search/contracts` | every request, response, error and event schema — one definition, imported by the server too |
| `@actana/search/contracts/kbs`, `/documents`, `/keywords`, `/clusters`, `/tags`, `/endpoints`, `/webhooks`, `/events`, `/capabilities`, `/common` | one family each, for a caller that wants one |

## Dependencies

`undici` and `zod`, and that is the whole list. The CSR encoder is hand-written
(`pairing-csr.ts`) rather than a dependency, because the alternative is pulling
an X.509 library into every consumer of this package to produce four DER fields
in a fixed order.

## Licence

MIT.
