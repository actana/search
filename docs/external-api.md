# The `/v1` API

Every route a paired client can reach, the zod schema that validates it, and the
scope it needs. **The schemas are the contract** (ADR 0009) — this page names
them so a reader can go straight to the definition rather than to a
re-description of it. They all live in
[`packages/sdk/src/contracts/`](../packages/sdk/src/contracts) and are exported
as `@actana/search/contracts`.

The supported way to call any of this is the SDK
([`packages/sdk/README.md`](../packages/sdk/README.md)); `client.request(method,
path, …)` is the escape hatch for a route with no method yet.

## How a request is decided

1. **Mutual TLS.** Every route but the two in the open set requires a client
   certificate this instance's CA signed, and the certificate *is* the identity
   (ADR 0003). Nothing in a URL, a body or a header identifies a caller.
   `SEARCH_DEV_INSECURE=1` swaps that for an `x-paired-client` header and
   refuses to start outside a test.
2. **Scope.** Each route declares `read`, `write` or `admin`; `admin` implies
   `write` implies `read`. A caller below it gets `403 scope-forbidden`.
3. **The KB allow-list.** A pairing may name the KB ids it covers. A route whose
   URL carries `:kbId` is checked against that list before its handler runs;
   outside it is `403 kb-forbidden`.
4. **Ownership.** The KB row must belong to this paired client. If it does not —
   or does not exist — the answer is `404 not-found`, never `403` (ADR 0009 D5).
5. **The body.** Validated against the route's schema. A mismatch is `400
   validation-failed` with zod's issue list in `detail`.

## Open set

| Route | Purpose |
|---|---|
| `POST /v1/pair/redeem` | The only route that grants anything without a certificate. Single-use code, five-minute expiry, capped attempts (ADR 0008). |
| `GET /v1/health` | Liveness. `{ ok: true }`, plus `schemaVersion` to a caller that presented a certificate. |

## Instance

| Route | Scope | Request | Response |
|---|---|---|---|
| `GET /v1/capabilities` | read | — | `CapabilitiesSchema` |
| `GET /v1/pair/status` | read | — | `SearchPairStatus` (`@actana/search/pairing-wire`) |

`features` is the closed `SEARCH_FEATURES` list — `hybrid`, `v1-tags`,
`clusters`, `keywords`, `webhooks`, `sse`, `mirrored-endpoints`. Test membership
in it; do not infer capability from `protocol`.

## Knowledge bases

| Route | Scope | Request | Response |
|---|---|---|---|
| `GET /v1/kbs` | read | `ListKbsQuerySchema` (query) | `ListKbsResponseSchema` |
| `POST /v1/kbs` | write | `CreateKbRequestSchema` | `KnowledgeBaseSchema` (201) |
| `GET /v1/kbs/:kbId` | read | — | `KnowledgeBaseSchema` |
| `PATCH /v1/kbs/:kbId` | write | `UpdateKbRequestSchema` | `KnowledgeBaseSchema` |
| `DELETE /v1/kbs/:kbId` | write | — | `DeleteKbResponseSchema` |

`DELETE` is a soft delete: the KB becomes archived and is listed by
`?scope=archived`. Creating a KB also provisions its vector partition, sized to
the embedding endpoint's dimension.

`embeddingEndpointId` and `inferenceEndpointId` must name **this client's own**
endpoints (`GET /v1/endpoints` is the list). An id that is not is `404
not-found` on both the create and the patch — not `403`, because an endpoint id
that is not yours is an id you must not be able to confirm exists (ADR 0009 D5).
Binding a KB to somebody else's endpoint would be spending their provider key.

## Query

| Route | Scope | Request | Response |
|---|---|---|---|
| `POST /v1/kbs/:kbId/query` | read | `QueryRequestSchema` | `QueryResponseSchema` |

One route, two engines, discriminated by `mode` on the way in and on the way out
(ADR 0009 D4):

- **`hybrid`** (default) — `HybridQueryResponseSchema`. `matches[]` carries
  `{ id, documentId, chunkIndex, content, metadata, score, semanticScore,
  keywordScore }`, plus `usage` and, with `includeDiagnostics`, `diagnostics`.
- **`v1-tags`** — `V1TagQueryResponseSchema`. The pre-v2 path over the shared
  `embedding` table: `tags[]` filters first (two filters on different slots are
  ANDed), then a vector search over what survives. Rows carry their seventeen
  tag columns and a cosine `distance`, ascending.

`queryKeywords` picks between the two frozen v2 entry points and is not a tuning
knob: **omitted** selects the query's keywords from the KB's vocabulary first,
`[]` blends nothing and collapses to pure semantic similarity, and a list uses
exactly those (ADR 0009 D4a).

## Documents

| Route | Scope | Request | Response |
|---|---|---|---|
| `POST /v1/kbs/:kbId/documents` | write | `IngestJsonRequestSchema` **or** multipart (`IngestMultipartFieldsSchema` + a `file` part) | `IngestResponseSchema` (202) |
| `POST /v1/kbs/:kbId/documents/upsert` | write | `UpsertDocumentRequestSchema` | `UpsertDocumentResponseSchema` (202) |
| `GET /v1/kbs/:kbId/documents` | read | `ListDocumentsQuerySchema` (query) | `ListDocumentsResponseSchema` |
| `GET /v1/kbs/:kbId/documents/:docId` | read | — | `DocumentSchema` |
| `PATCH /v1/kbs/:kbId/documents/:docId` | write | `UpdateDocumentRequestSchema` | `DocumentSchema` |
| `DELETE /v1/kbs/:kbId/documents/:docId` | write | — | `DeleteDocumentResponseSchema` |
| `POST /v1/kbs/:kbId/documents/:docId/include` | write | `IncludeDocumentRequestSchema` | `IncludeDocumentResponseSchema` |

**Ingest is asynchronous and the two encodings are two pipelines.** A file (or a
`url` the instance fetches) goes through parse → chunk → plan → embed → finalize
→ keyword, the resumable worker flow. `text` goes through `ingestDocument`,
which chunks and embeds in one pass and writes only the partition. They produce
different corpora from the same bytes and the fixture suite freezes both; pick
the one whose behaviour you want rather than the one whose encoding is
convenient.

Poll `GET …/documents/:docId` for `processingStatus`, or listen on
`GET /v1/events`. A file part over 50 MB is `413`; the multipart envelope is
capped at 64 MB and a JSON body at 4 MB. A body over either cap is answered
`413 payload-too-large` with `Connection: close` — the answer arrives, and then
the socket goes.

**The multipart encoding carries the same fields as the JSON one**, as string
parts beside `file`:

| Part | Meaning |
|---|---|
| `filename`, `mimeType` | Override what the file part declared. |
| `includedInKb` | `1\|true\|yes\|on` or `0\|false\|no\|off`; anything else is a `400`. `false` stores the bytes and the row and does **not** chunk the document — no pipeline runs, the document has no chunks and cannot be matched by a query, and `POST …/documents/:docId/include` is the way in afterwards. |
| `metadata` | A JSON-encoded object, validated against `MetadataSchema` — a malformed value is a `400` rather than a part quietly dropped. **Accepted and not written on a file ingest**: only the `text` path (`ingestDocument`) carries metadata onto the chunk rows, and that is frozen engine code (ADR 0005). The JSON encoding's `url` branch is the same pipeline and does the same thing. |
| `documentId` | The caller's own id for the document. |

**`documentId` lets the caller keep its own id** (both encodings). Omitted,
Search generates one. Supplied, it is the id the row gets and the id the
response echoes — which is what lets a caller whose rows already have ids wire
them through Search without the ids changing. It is scoped by the knowledge
base:

- the id is **free** → the document is created with it;
- the id is **already used in this KB** → the idempotent re-ingest the engine
  already supports: the answer is that document's current `processingStatus`, no
  second row is written and no new work is enqueued;
- the id is **used in another KB** (this client's or anybody's) → `409
  conflict`, never an overwrite. `document.id` is the primary key across every
  KB on the instance, and the refusal says nothing about whose the other row
  is.

`upsert` identifies an existing document by `(connectorId, externalId)` when
both are given and by `filename` otherwise, and answers
`outcome: created | replaced | skipped` — `skipped` when `contentHash` is
unchanged.

## Chunks

| Route | Scope | Request | Response |
|---|---|---|---|
| `GET …/documents/:docId/chunks` | read | `ListChunksQuerySchema` (query) | `ListChunksResponseSchema` |
| `PATCH …/chunks/:chunkId` | write | `UpdateChunkRequestSchema` | `ChunkSchema` |
| `DELETE …/chunks/:chunkId` | write | — | `DeleteChunkResponseSchema` |
| `PUT …/chunks/:chunkId/keywords` | write | `AttachChunkKeywordRequestSchema` | `ChunkKeywordResponseSchema` |
| `DELETE …/chunks/:chunkId/keywords/:keywordId` | write | — | `{ id, deleted: true }` |

Editing a chunk's `content` re-embeds it through the KB's embedding endpoint.
That is not optional: a chunk whose text and vector disagree ranks for the wrong
query.

## Keywords

| Route | Scope | Request | Response |
|---|---|---|---|
| `GET /v1/kbs/:kbId/keywords` | read | `ListKeywordsQuerySchema` (query) | `ListKeywordsResponseSchema` |
| `PUT /v1/kbs/:kbId/keywords` | write | `PutKeywordRequestSchema` | `KeywordSchema` |
| `DELETE /v1/kbs/:kbId/keywords/:keywordId` | write | — | `DeleteKeywordResponseSchema` |
| `POST /v1/kbs/:kbId/extract-keywords` | write | `ExtractKeywordsRequestSchema` | `ExtractKeywordsResponseSchema` (202) |

`PUT` is create-or-return: dedup is on the canonical (lowercased, trimmed) form,
so two callers asking for `Parental Leave` and `parental-leave` get the same row.
`extract-keywords` enqueues one job per document; it does not extract inline.
With `scope: "document"` the `documentId` must be a document **in that KB** —
otherwise `404 not-found`, because the job it enqueues is also what announces
that document's events and those go to the document's owner.

## Clusters

| Route | Scope | Request | Response |
|---|---|---|---|
| `GET /v1/kbs/:kbId/clusters` | read | `ListClustersQuerySchema` (query) | `ListClustersResponseSchema` |
| `GET /v1/kbs/:kbId/clustering-status` | read | — | `ClusteringStatusSchema` |
| `POST /v1/kbs/:kbId/recluster` | write | — | `ReclusterResponseSchema` (202) |

Centroids are omitted unless `?includeCentroids=true`. Below
`coldStartMinChunks` (50) no fit happens at all, and below 50 000 chunks the
read path never prunes to clusters — so `neighborClusters` on a small KB is
accepted and changes nothing.

## Tags

| Route | Scope | Request | Response |
|---|---|---|---|
| `GET /v1/kbs/:kbId/tag-definitions` | read | — | `ListTagDefinitionsResponseSchema` |
| `PUT /v1/kbs/:kbId/tag-definitions` | write | `PutTagDefinitionsRequestSchema` | `PutTagDefinitionsResponseSchema` |
| `DELETE /v1/kbs/:kbId/tag-definitions/:tagId` | write | — | `DeleteTagDefinitionResponseSchema` |
| `GET /v1/kbs/:kbId/tag-usage` | read | — | `TagUsageResponseSchema` |
| `GET /v1/kbs/:kbId/next-available-slot` | read | `NextAvailableSlotQuerySchema` (query) | `NextAvailableSlotResponseSchema` |

Seventeen slots: seven text, five number, two date, three boolean, and no
eighteenth — `next-available-slot` answers `null` when a type is full. A
definition carrying `originalDisplayName` is a rename, and a rename rewrites the
value on every document and chunk that carried it.

## Model endpoints

| Route | Scope | Request | Response |
|---|---|---|---|
| `GET /v1/endpoints` | read | — | `GetEndpointsResponseSchema` |
| `PUT /v1/endpoints` | admin | `PutEndpointsRequestSchema` | `PutEndpointsResponseSchema` |

`PUT` upserts by the declaring client's own `externalId` — for a `local`
declaration as well as a `mirrored` one — so a push is idempotent (ADR 0004).
An endpoint left out of a later push is removed unless a KB is bound to it, and
a row with no `externalId` (registered before this route existed) is neither
upserted onto nor reaped.

**No provider key is ever in a response**: a `local` declaration may carry
`apiKey` and it comes back only as `hasKey: true`; a `mirrored` one carries none
at all: `resolverUrl` is asked for one per job with `resolverKey` as the bearer,
and `resolverScope` — an opaque string Search never parses — is echoed back
verbatim as that request's `workspaceId`.

**`apiKey` omitted from a `local` declaration means "said nothing about it"**
and the sealed key already on the row stays. That is what makes a client's
metadata-only re-push safe, and it is what the CLI's `endpoint add` relies on:
`PUT` is declarative, so that verb reads the current set, appends to it, and
pushes the whole thing back with everybody else's keys unmentioned. An empty
string is a `400` rather than a blanked key.

`GET`'s `source` is the **declaration**, as an object rather than an enum:
`{ kind: 'local' }`, or `{ kind: 'mirrored', resolverUrl, resolverScope }`
(`EndpointSourceSummarySchema`). `resolverScope` is there because it is the
field Search, the client and the resolver all have to agree on, and a client
that has just pushed needs to be able to read back which scope its keys will be
asked for under. The credential is not in it, sealed or otherwise. The
declaration is *not* derived from the rows: a client that has declared a
resolver and pushed nothing yet reads as `mirrored`.

**Every URL in the body goes through the SSRF guard** before anything is
written: `resolverUrl` and each endpoint's `baseUrl`, which is the address
embedding and inference requests are actually posted to. `https://` (or
loopback `http://` where `SEARCH_ALLOW_LOCAL_FETCH` is set), no private or
reserved address, no blocked port — anything else is `400 bad-request` and the
push writes nothing at all.

## Events

| Route | Scope | Request | Response |
|---|---|---|---|
| `GET /v1/webhooks` | read | — | `GetWebhookResponseSchema` |
| `PUT /v1/webhooks` | admin | `PutWebhookRequestSchema` | `{ webhook }` |
| `DELETE /v1/webhooks` | admin | — | `DeleteWebhookResponseSchema` |
| `GET /v1/events` | read | — | `text/event-stream` of `SearchEventSchema` |

One payload, two transports (ADR 0009 D8). The events are
`document.ingested`, `document.failed` and `clusters.retrained`
(`SEARCH_EVENT_NAMES`).

`document.failed` may carry `reason` beside `error`: `error` is the operator's
sentence and must not be parsed, `reason` is the worker's own classification of
what went wrong — `unknown-endpoint`, `decrypt-failed`, `model-mismatch`,
`resolver-error`, … (ADR 0010 D3). It is an open string rather than an enum
because the reasons are Search's vocabulary and a client must not break when one
is added, and it is absent when there was no typed failure behind the error.

**A `document.failed` is only sent once the job is out of attempts.** The engine
marks a document `failed` as soon as an attempt gives up, which for a wired
client mid-deploy is a resolver that will answer in a second; the announcement
is held back until the attempt that really is the last one (ADR 0010 D4). So a
`document.failed` means the document will not ingest, not that something went
wrong once.

A **webhook** delivery is a POST carrying:

- `x-search-event-id: <event.id>` — deterministic, so a redelivery after an
  ambiguous timeout is recognisably the same event.
- `x-search-signature: sha256=<hex>` — HMAC-SHA256 over the **raw body**, keyed
  by the registered secret. Verify over the bytes you received, not over a
  re-encoding. `verifyWebhookSignature` in the core does it in constant time;
  the algorithm is two lines if you would rather not import it.

Five attempts on a retryable answer (5xx, 408, 429, a dead socket), no retry on
any other 4xx, exponential backoff from 500 ms. Every delivery has a
`webhook_delivery` row whose state says how it went, and a `(webhook, event)`
unique index means one POST per event per hook.

**SSE** frames are `event: <name>` then `data: <json>`, with a `: heartbeat`
comment every fifteen seconds. The stream is per paired client and strictly
in-process: a second Search instance's events do not appear on it. If the
delivery has to survive a disconnect, use the webhook.

## Errors

`{ code, message, detail? }`. Switch on `code`; do not parse `message`. The
enum is closed (`SEARCH_ERROR_CODES`).

| Status | `code` | When |
|---|---|---|
| 400 | `bad-request` | The body was unreadable — not JSON, not an object. |
| 400 | `validation-failed` | It parsed and did not match the schema. `detail.issues` is zod's list. |
| 403 | `client-certificate-required` | No certificate, or one that was revoked. |
| 403 | `scope-forbidden` | The pairing's scope is below the route's. |
| 403 | `kb-forbidden` | The pairing named KB ids and this is not one. |
| 404 | `not-found` | No such route, or no such row **for this client**. |
| 409 | `conflict` | A duplicate KB name; an include with no stored bytes; a `documentId` already used in another KB. |
| 413 | `payload-too-large` | Over the body or upload cap. |
| 415 | `unsupported-media-type` | A content type the route does not read. |
| 429 | `rate-limited` | Too many requests in the window. |
| 500 | `core-error` | This instance failed. `detail.errorId` is what to grep the log for; there is no stack. |

`error` appears beside `message` with the same string, for the pairing surface's
older spelling. New code reads `message`. **Every** refusal carries all three
keys — `code`, `message` and `error` — the router's own (a scope, a KB
allow-list, an unknown route, a missing certificate, a `core-error`) included,
so `ErrorBodySchema` validates any of them.

## Rate limiting

The pre-auth redemption route is rate limited per caller and globally (ADR
0008). On the authenticated surface, **`POST /kbs/:kbId/query` is limited per
paired client**: 600 a minute from one client and 6 000 across the instance,
fixed windows, per process. A refusal is `429 rate-limited` with `Retry-After`
in seconds and `detail.retryAfterMs` for a client that would rather back off
exactly.

The query route and not the others because it is the one a caller can issue in a
loop at no cost to itself and real cost here — an embedding call, an ANN scan, a
re-rank. The writes are bounded by the work they enqueue.
