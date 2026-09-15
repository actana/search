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
| `GET /v1/whoami` | any | — | `WhoamiSchema` |
| `GET /v1/pair/status` | read | — | `SearchPairStatus` (`@actana/search/pairing-wire`) |

**`GET /v1/whoami` is the explicit identity call, and `GET /v1/capabilities`
does not answer it.** Capabilities is about the *instance* — protocol, schema
version, feature list, public host — and carries no client id; the registration
blob a pairing produces carries none either. So it is `whoami` that answers
*which* `search.paired_client` row the certificate on this connection resolves
to, which is the same string `search.knowledge_base.paired_client_id` holds, and
therefore the id a caller writing rows of its own has to know.

It is the only route whose scope is **any** — `scope: null` in the router, which
means any paired client at any scope. A caller too weakly scoped to do anything
else can still ask who it is, and the answer is about the caller, so it
discloses nothing a certificate holder did not already have.

`scopes` is **every** scope the pairing permits, weakest first: a client paired
`admin` reads `["read", "write", "admin"]`. Like `features`, it is a list so a
caller tests membership rather than re-implementing the `admin` ⊃ `write` ⊃
`read` rank the router enforces — it is derived from that same predicate, so the
two cannot disagree. `GET /v1/pair/status` still answers the single stored value
under `scope`.

`serialNumber` is the serial of the certificate presented **on this
connection**, read off the socket rather than copied from the row, and it is
absent on the plain-HTTP development path (`SEARCH_DEV_INSECURE=1`) where there
is no certificate — the same reason `SearchPairStatus.certNotAfter` is null
there. `createdAt` is `paired_client.created_at`, the instant the pairing was
redeemed. `schemaVersion` repeats what capabilities reports, so that *who am I*
and *is this the version I was written against* are one round trip observed at
one instant.

`GET /v1/pair/status` is not superseded: it is the pairing surface's own shape
(`platform`, `kbIds`, `certNotAfter` — the pairing lifecycle), typed in
`@actana/search/pairing-wire` rather than in the zod contracts.

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
| `POST /v1/kbs/:kbId/restore` | write | — | `KnowledgeBaseSchema` |

`DELETE` is a soft delete: the KB becomes archived and is listed by
`?scope=archived`. Creating a KB also provisions its vector partition, sized to
the embedding endpoint's dimension.

`POST …/restore` is the way back: it clears `deletedAt` and un-archives the
documents the delete archived. It is the **one** route whose subject is an
archived row — every other treats `deleted_at IS NULL` as part of a KB's
identity — and it answers with the knowledge base rather than an
acknowledgement because the restore may have had to **rename** it: a KB whose
name was taken while it was archived comes back as `…_restored`, then a
suffixed variant. A KB that is not archived is `409 conflict`; one that is not
this client's, or does not exist, is `404` like every other KB route — and that
holds for a restore that loses a race with a concurrent delete or restore of
the same KB, which is answered by what the row turned out to be rather than by
`409` for both.

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
  `embedding` table. Rows carry their seventeen tag columns and a cosine
  `distance`, ascending. It is **three** engines, and what a request carries
  picks between them — they are the v1 surface's own three shapes:

  | Request | Engine | What it does |
  |---|---|---|
  | `text` **and** `tags` | `handleTagAndVectorSearch` | `tags[]` filters first (two filters on different slots are ANDed), then a vector search over what survives. |
  | `tags`, no `text` | `handleTagOnlySearch` | Filters by tag and answers with what survives. **Embeds nothing** — `usage.embed` is zero and every `distance` is `0`. |
  | `text`, no `tags` | `handleVectorOnlySearch` | A plain vector search over the KB. This is the ordinary v1 search, and what a caller with no tag filter to apply sends. |

`queryKeywords` picks between the two frozen v2 entry points and is not a tuning
knob: **omitted** selects the query's keywords from the KB's vocabulary first,
`[]` blends nothing and collapses to pure semantic similarity, and a list uses
exactly those (ADR 0009 D4a).

`topK` goes up to **100** (ADR 0009 D3a), which is what Studio's own public
search routes accept.

**`text` is optional for one shape only: `mode: 'v1-tags'` with a non-empty
`tags`.** That is the tag-only search, the one v1 request that ranks by
nothing. `hybrid` embeds, and so does a tag-less `v1-tags` — which is the
vector-only search in the table above — so both still require `text`, and
`text: ''` is a `400` everywhere.

**`distanceThreshold` (above `0`, up to `2`) is `v1-tags` only.** Present, it
replaces the threshold `getQueryStrategy` would have computed and
`strategy.distanceThreshold` reports the one that ran. It exists because a
caller fanning a single logical search out over several KBs computes one
threshold for the whole call — `0.8` above three KBs, `1.0` otherwise — and a
per-KB route can only ever infer `1.0`. Sent with `hybrid` it is `400
validation-failed`: that path ranks by a blended score, whose floor is
`minScore`, and a threshold silently dropped looks exactly like one that was
applied.

`0` is a `400` as well, and not because a zero-distance threshold is
meaningless (it is: a row is kept for being `< threshold`). The two frozen
vector engines test this with `!distanceThreshold` — "was one given?" — so a
stated `0` reads there as one left out and the guard refuses the call.

**`strategy.distanceThreshold` is absent on the tag-only search.** That shape
embeds nothing and thresholds nothing, so no row was kept or dropped for its
distance and there is no threshold that ran to report — including when the
request stated one. The rest of `strategy` is still what ran.

## Documents

| Route | Scope | Request | Response |
|---|---|---|---|
| `POST /v1/kbs/:kbId/documents` | write | `IngestJsonRequestSchema` **or** multipart (`IngestMultipartFieldsSchema` + a `file` part) | `IngestResponseSchema` (202) |
| `POST /v1/kbs/:kbId/documents/upsert` | write | `UpsertDocumentRequestSchema` | `UpsertDocumentResponseSchema` (202) |
| `POST /v1/kbs/:kbId/documents/bulk` | write | `BulkDocumentsRequestSchema` | `BulkDocumentsResponseSchema` |
| `GET /v1/kbs/:kbId/documents` | read | `ListDocumentsQuerySchema` (query) | `ListDocumentsResponseSchema` |
| `GET /v1/kbs/:kbId/documents/:docId` | read | — | `DocumentSchema` |
| `PATCH /v1/kbs/:kbId/documents/:docId` | write | `UpdateDocumentRequestSchema` | `DocumentSchema` |
| `DELETE /v1/kbs/:kbId/documents/:docId` | write | — | `DeleteDocumentResponseSchema` |
| `POST /v1/kbs/:kbId/documents/:docId/include` | write | `IncludeDocumentRequestSchema` | `IncludeDocumentResponseSchema` |
| `PUT /v1/kbs/:kbId/documents/:docId/blob` | write | multipart (`AttachBlobMultipartFieldsSchema` + a `file` part) | `DocumentSchema` |

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

**`chunkCount` on the ingest answer is present only when the row already
carries one** — the idempotent re-ingest of a `documentId`, or an ingest whose
work had landed before the answer did. It is absent, never `0`, while a
document is still being processed: the `202` does not wait for a chunker, and
"not known yet" and "no chunks" are different claims. The count for a document
in flight arrives on `document.ingested` or from `GET …/documents/:docId`.

**A tag-filtered listing is one JSON-encoded query parameter**:
`?tagFilters=[{"tagSlot":"tag1","fieldType":"text","operator":"eq","value":"handbook"}]`.
`TagFilterConditionSchema` is the lifted `getDocuments`' own condition — slot,
field type, operator, `value` as a string whatever the column's type is, and
`valueTo` for `between` — and it is encoded rather than flattened to `tag1=…`
because a flat parameter cannot carry an operator, a second bound, or two
conditions on one slot. Conditions on different slots are ANDed.

**Every field of a condition is closed**, because the engine answers a
condition it cannot build with nothing and a missing condition answers a
*filtered* listing with the *unfiltered* one — which a caller cannot tell from
the rows. So all four of these are `400 validation-failed` naming the field,
rather than a listing that quietly ignored the filter:

| Rule | Why |
|---|---|
| `tagSlot` is one of the seventeen | A slot the engine does not recognise is dropped. |
| `operator` is `eq`, `neq`, `contains`, `not_contains`, `starts_with`, `ends_with`, `gt`, `gte`, `lt`, `lte` or `between` | Exactly what the engine implements. There is no `in`, no `is_null` and no `regex`. |
| `fieldType` is the one the slot's prefix names — `tag*` text, `number*` number, `date*` date, `boolean*` boolean — and it implements the `operator` | A mismatch is worse than dropped: `number1` read as text reaches Postgres as a text comparison against an integer column, which is a `500`. And each type has its own operators: text has the `LIKE` forms and no ordering, `boolean` has only `eq`/`neq`, `number` and `date` have the comparisons and `between`. |
| `between` carries `valueTo` | It is an inclusive range, and the engine drops one with no upper bound. |

`pagination.total` is a number, like the rest of `PaginationSchema`. The lifted
`getDocuments` hands `COUNT(*)` back as the string Postgres sent it and the
route casts it, on every listing filtered or not.

**Bulk** takes `{ operation: 'enable' | 'disable' | 'delete' }` with exactly one
of `documentIds` (at most 500, and **every** one must be a document this call
would act on — in this KB, not archived, not user-excluded and not deleted,
which is the frozen service's own predicate — or the call is `404` and writes
nothing; the message names none of them) or `enabledFilter`
(`all | enabled | disabled`, uncapped). The answer is `{ affected }`. Those two
forms and no others because the frozen service has exactly two
(`bulkDocumentOperation`, `bulkDocumentOperationByFilter`) and the by-filter one
reads `enabled` and no other column: filter by tag with
`GET …/documents?tagFilters=…` and pass the ids. `delete` is the same soft
delete the single-document route performs.

**The multipart encoding carries the same fields as the JSON one**, as string
parts beside `file`:

| Part | Meaning |
|---|---|
| `filename`, `mimeType` | Override what the file part declared. |
| `includedInKb` | `1\|true\|yes\|on` or `0\|false\|no\|off`; anything else is a `400`. `false` stores the bytes and the row and does **not** chunk the document — no pipeline runs, the document has no chunks and cannot be matched by a query, and `POST …/documents/:docId/include` is the way in afterwards. |
| `metadata` | A JSON-encoded object, validated against `MetadataSchema` — a malformed value is a `400` rather than a part quietly dropped. **Accepted and not written on a file ingest**: only the `text` path (`ingestDocument`) carries metadata onto the chunk rows, and that is frozen engine code (ADR 0005). The JSON encoding's `url` branch is the same pipeline and does the same thing. |
| `documentId` | The caller's own id for the document. |
| `tag1`…`tag7`, `number1`…`number5`, `date1`, `date2`, `boolean1`…`boolean3` | The JSON encoding's nested `tags` object, flattened — a form has no nesting. Same meanings, same parsers, strings throughout (`TagWritesSchema`), and they land on the staged row exactly as `tags` does. A part that is not one of the seventeen slots is dropped, not refused: a form can only carry strings, so there is nothing to refuse it for. |

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

### `PUT …/documents/:docId/blob` — bytes without an ingest

**Every other route here creates a document and runs a pipeline over its bytes;
this one hands bytes to a document that already exists and runs nothing.** The
file part is stored in this instance's bucket under ingest's own key scheme
(`kb/<timestamp>-<random>-<sanitised>`) and the row is repointed at it: exactly
`file_url`, `mime_type` and `file_size` change. `processingStatus`,
`chunkCount`, the chunk rows, their vectors and the keyword overlay are what
they were — nothing is re-parsed, re-chunked, re-embedded or re-keyworded, and
nothing is enqueued.

It exists for the migration out of Studio (Studio's TASK-013). Those rows move
into `search.*` by SQL, carrying the chunk ids and embeddings they already had,
and the objects they name are in *Studio's* bucket. A re-ingest would rewrite
every one of those ids and vectors, which is not a move — and Studio must not
write into Search's bucket directly (ADR 0006). So the rows go by SQL and the
bytes stream through this route.

`filename` and `mimeType` mean what they mean on the ingest form, with one
difference worth stating: **`filename` names the object, not the document.** It
is what the storage key is built from; `document.filename` is left alone,
because a rename is `PATCH …/documents/:docId`. The file-part cap is ingest's
50 MB (`413`) inside the same 64 MB multipart envelope.

**It is idempotent in the row and not in the bucket.** Attaching the same bytes
twice is fine and is the normal case for a retried stream: the second attach
writes a second object and points the row at it, so the row ends in the same
state and the document still says the same things about itself. The superseded
object is **left in place** — a job holding the old `fileUrl` in its payload may
still be reading it, and a migration re-run after a partial failure should not
find its source deleted.

`404` for a document that is not this client's or does not exist, as on every
other document route (ADR 0009 D5). `409 conflict` while a run is reading the
current bytes — `processing`, `chunking`, `embedding`, `clustering` or
`keywording`: swapping the object underneath a worker would leave the chunks
describing one object and the row naming another. `pending` is **not** refused,
because a document uploaded with `includedInKb: false` rests there with no job
enqueued and attaching its bytes is the obvious next thing to do; `completed`
and `failed` are settled. Poll `GET …/documents/:docId` until the status leaves
that set.

## Chunks

| Route | Scope | Request | Response |
|---|---|---|---|
| `GET …/documents/:docId/chunks` | read | `ListChunksQuerySchema` (query) | `ListChunksResponseSchema` |
| `POST …/documents/:docId/chunks` | write | `CreateChunkRequestSchema` | `ChunkSchema` (201) |
| `PATCH …/chunks/:chunkId` | write | `UpdateChunkRequestSchema` | `ChunkSchema` |
| `DELETE …/chunks/:chunkId` | write | — | `DeleteChunkResponseSchema` |
| `PUT …/chunks/:chunkId/keywords` | write | `AttachChunkKeywordRequestSchema` | `ChunkKeywordResponseSchema` |
| `DELETE …/chunks/:chunkId/keywords/:keywordId` | write | — | `{ id, deleted: true }` |
| `GET /v1/kbs/:kbId/chunks/:chunkId` | read | — | `ChunkSchema` |
| `PUT\|POST /v1/kbs/:kbId/chunks/:chunkId/keywords` | write | `AttachChunkKeywordRequestSchema` | `ChunkKeywordResponseSchema` |
| `DELETE /v1/kbs/:kbId/chunks/:chunkId/keywords/:keywordId` | write | — | `{ id, deleted: true }` |
| `GET /v1/kbs/:kbId/chunks/:chunkId/keywords` | read | — | `ListChunkKeywordsResponseSchema` |

Editing a chunk's `content` re-embeds it through the KB's embedding endpoint.
That is not optional: a chunk whose text and vector disagree ranks for the wrong
query. So a KB with no embedding endpoint answers **both** routes that embed —
the `PATCH` and the `POST` below — with `400 bad-request` naming the two calls
that fix it (`PUT /v1/endpoints`, then set it on the knowledge base). `POST …/documents/:docId/chunks` writes one by hand on the same terms: the
content is embedded before it is stored, the chunk lands at the next
`chunkIndex`, it inherits every tag value from its document, and the document's
`chunkCount`, `tokenCount` and `characterCount` go up by what it added.

**A chunk is addressable twice: through its document, and by its own id**
(ADR 0009 D10). The last four rows are the second: a chunk id is unique across
the instance, the `:kbId` is the ownership anchor, and a caller that holds only
a chunk id — Studio's chunk editor, its `kb_admin` tool — can say what it means
without a document id it does not have. One handler each, so the two addressings
cannot come to mean different things; the document-addressed form additionally
asserts the chunk is in *that* document. The attach takes `PUT` **and** `POST`
because it is idempotent (create-or-return on the pair) and both verbs are
unambiguous.

`GET …/chunks/:chunkId/keywords` is the **read** of that overlay, and it answers
the links rather than the vocabulary: each row is the `KeywordSchema` fields plus
the join's own two — `source` (`llm` for a link the extractor made, `manual` for
one a person made) and `attachedAt` — ordered by the canonical form. Those two
differ between two chunks carrying the same keyword, which is why
`GET /v1/kbs/:kbId/keywords` cannot answer this: its `usageCount` is a count
across the whole KB, and it is carried here for the same reason (it is on the row
the join already reads), not as a count of anything about this chunk. A chunk
outside this KB is a `404`, exactly as it is on `GET /v1/kbs/:kbId/chunks/:chunkId`.

Every chunk response carries **`documentId`**, required: the column is `NOT NULL`
and each of the four routes that answer with a chunk already knows the document
without a second query — three of them are addressed through it, and the
chunk-by-id read gets the whole `embedding` row. A caller that addressed a chunk
by id alone can therefore check which document it landed in rather than assume.

`POST …/documents/:docId/chunks`, the chunk reads and the keyword attach all work
over the **shared `embedding` table** — v1 code, frozen (ADR 0005) — which the
file pipeline writes and the `text` pipeline does not. So a document ingested as
`text` has no chunks on these routes, and a chunk added by hand is found by
`mode: 'v1-tags'` and not by `hybrid`, which reads the KB's own partition. That
is Studio's behaviour unchanged, and it is the reason its chunk editor works over
uploaded files.

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

**`config.apiKeyEndpointId` shares one endpoint's key with another, and it may
name the other endpoint by either spelling** — Search's `id` for it, as `GET
/v1/endpoints` answers, or that endpoint's own `externalId`, which is the id a
client holding only its own catalog has. Three targets are legal and nothing
else is:

| The link names | Accepted as |
|---|---|
| an endpoint this client already has | its `id`, or its `externalId` |
| an endpoint declared elsewhere in the same body | that declaration's `externalId` |
| anything else — another client's endpoint, or an unknown string | **`400`**, naming the value |

An `externalId` is **stored translated**: the row comes back from `GET` with
`config.apiKeyEndpointId` set to Search's `id` for the endpoint it names, which
is the only form the key resolution follows. So a client that reads its
endpoints back and pushes them again is pushing ids, and a re-push of an
already-translated body changes nothing. Where one string is somehow both an
`id` and an `externalId`, the `id` wins. A link that leads to an endpoint
holding a sealed key makes the borrower `hasKey: true`; one that leads to an
endpoint with no key of its own does not.

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

**A `document.failed` means the document will not ingest, not that something
went wrong once.** The engine marks a document `failed` as soon as an attempt
gives up, which for a wired client mid-deploy is a resolver that will answer in
a second — so the announcement is held back while the attempt that wrote it
*threw* and the queue still has attempts for it. It is **not** held back when the
job finished: a handler that returned having marked the document failed has
decided, whatever the attempt counter says. Two other paths reach the same
event: a failure the engine never recorded (a key that could not be resolved at
all) is announced by the worker with a `reason`, and a document stranded by a
worker that was killed is announced by the timeout sweep with `reason:
"timeout"` (ADR 0010 D4).

A **webhook** delivery is a POST carrying:

- `x-search-event-id: <event.id>` — deterministic over *what happened*: the
  document, its terminal state, and which processing run reached it. A
  redelivery after an ambiguous timeout is recognisably the same event, and so
  are the retries of one job; a document you **include again** is a new run and
  therefore a new event id.
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
