# TASK-004 — REST API and zod contracts

`packages/sdk/src/contracts/*.ts` holds the zod schemas (request, response, error
shapes, event payloads) — **one definition**; `packages/search/src/api/` validates with
them and `packages/sdk` types are inferred from them.

Server: Node `https` with mTLS (client certificate required except on the pre-auth
route; TASK-006 provides the gate — until then a `SEARCH_DEV_INSECURE=1` plain-HTTP
mode with `x-paired-client: <id>` for tests), explicit router like Control's Core,
JSON bodies capped, multipart streaming for ingest, SSE for `/v1/events`.

Routes (all under `/v1`, scoped by the paired client from the certificate):
- `GET /health` (open), `GET /capabilities` → `{ protocol, schemaVersion, features:
  ['hybrid', 'v1-tags', 'clusters', 'keywords', 'webhooks', 'sse'] }`
- `GET|POST /kbs`, `GET|PATCH|DELETE /kbs/:id` (chunking config, endpoint bindings,
  `kmeans_k`, the Studio `knowledge_base` fields)
- `POST /kbs/:id/documents` (multipart file **or** JSON `{ filename, text | url,
  mimeType?, tags?, metadata? }`) → `{ documentId, processingStatus }`, async
- `GET /kbs/:id/documents`, `GET|PATCH|DELETE /kbs/:id/documents/:docId`,
  `GET /kbs/:id/documents/:docId/chunks`, `PATCH|DELETE .../chunks/:chunkId`,
  `POST .../include`, `POST /kbs/:id/documents/upsert` (the Studio upsert semantics)
- `POST /kbs/:id/query` `{ text, topK, keywordWeight, neighborClusters, filter,
  minScore, includeContent, mode?: 'hybrid' | 'v1-tags', tags? }` → `{ matches, usage,
  diagnostics? }` — same shapes `queryKb` returns today
- `GET|PUT /kbs/:id/keywords`, `…/:keywordId`, chunk keywords, `POST /kbs/:id/extract-keywords`
- `GET /kbs/:id/clusters`, `GET /kbs/:id/clustering-status`, `POST /kbs/:id/recluster`
- `GET|PUT /kbs/:id/tag-definitions`, `…/:tagId`, `GET /kbs/:id/tag-usage`,
  `GET /kbs/:id/next-available-slot` (v1 path)
- `GET|PUT /endpoints` (`PUT` body `{ source: { kind: 'local' } | { kind: 'mirrored',
  resolverUrl, resolverKey }, endpoints: [...] }` → `{ endpoints: [{ id, externalId }] }`)
- `GET|PUT /webhooks` (`{ url, secret, events }`), `GET /events` (SSE)
- `POST /pair/redeem` (TASK-006), `GET /pair/status`
- Errors: `{ code, message, detail? }` with a fixed code enum in the contracts.

Fixture suite over REST: `packages/search/src/__tests__/fixture-suite.rest.test.ts`
boots the server in insecure dev mode against `SEARCH_TEST_DATABASE_URL`, ingests the
fixture KB through `POST /kbs/:id/documents`, waits for processing, runs the ten queries,
asserts expected top-5. Webhook events (`document.ingested`, `document.failed`,
`clusters.retrained`) HMAC-SHA256 signed in `x-search-signature: sha256=<hex>` with
`x-search-event-id`; retried with backoff; delivery ledger.

## Outcome

Landed. 36 routes under `/v1`, every request and response a zod schema in
`packages/sdk/src/contracts/` (`@actana/search/contracts`) that the core
validates with and the SDK infers its types from — ADR 0009 records that and the
four decisions that came with it (SDK owns the schemas; one query route with a
`mode`; 404 not 403 for a foreign KB; webhooks *and* SSE). The SDK's namespaces
are filled in, multipart included; `events()` is an async iterator.

Two things the brief did not anticipate:

- **`undici.request` does not accept a `FormData` body.** Only `fetch` does, and
  `fetch` has no typed per-request dispatcher, which is the whole reason this
  client uses `undici.request`. Passing one anyway sends a request with no body
  and the far side eventually answers `408`. The SDK now encodes the multipart
  envelope itself (`encodeMultipart`, 40 lines, own boundary).
- **`mode` was not enough to name the frozen engines.** The fixture's `q06`,
  `q07` and `q14` call `queryKb` directly, which does *no* query-keyword
  selection and therefore ranks differently from `handleKbQuery` on the same
  corpus. The wire needed `queryKeywords`: omitted selects from the KB's
  vocabulary, `[]` blends nothing. Two of the fifteen queries failed until it
  existed.

`SEARCH_INLINE_JOBS=1` (`queue/inline.ts`) is the stand-in for TASK-005's
worker: a FIFO drained by one consumer, swapped in at `getJobQueue()` /
`getFlowProducer()` and nowhere else, refusing to run outside a test.
`jobs/run.ts` is the job-name → handler table both it and that worker use, and
the place terminal events are announced from — reading the row the frozen engine
just wrote, rather than threading a publish through five lifted files.

Three small edits outside the new code, each marked in place: `ingest.ts` gained
`stageIngestedDocument` (a verbatim extraction of its own insert, made
idempotent) so a route can answer with a document id before the job runs;
`document-processor.ts` gained a branch for an internal blob URL, which Studio
never needed because its `file_url` was absolute; the router's scope refusal is
now `scope-forbidden` rather than `forbidden`.

`fixture-suite.rest.test.ts` passes 15/15 frozen queries across the 4 KBs
through the SDK — including the `v1-tags` one — plus per-document chunk counts,
the column-default chunking, a signed `document.ingested` delivery, and
hybrid/bullmq ranking parity. Gates: `pnpm typecheck`, `pnpm lint` (240 files
strippable), `pnpm test` (816 passed), `pnpm audit --prod --audit-level high`,
`migrate-cli`, `rehearse-npm-pack` (11 entry points).

Coordinated with TASK-005 mid-flight: `resolverScope` is in the mirrored source
contract, the endpoint registry helpers carry that branch's names and argument
order, and the emitter's listener is `onSearchEvent`.

Left for later, deliberately: the rate limiter covers `POST /kbs/:id/query` and
not the rest of the surface; SSE is in-process, so a second instance's events do
not appear on a stream (the webhook is the durable path); `metadata` on a
*file* ingest is accepted and unused, because only `ingestDocument` writes it.

## Review fix round (2026-09-15)

Ten findings from the branch review, each with the fix and the test that holds
it. Two were process-ending or key-spending and are marked as such.

**1 — BLOCKER: one malformed URL ended the process.** `matchPath` called
`decodeURIComponent` on a path parameter and `URIError`'d on
`/v1/kbs/%E0/query`; the router's `routes.find` walks route predicates outside
every try, and `server.on("request")` could only `void serve(...)`, so the
throw was an `unhandledRejection`. *Fix:* `matchPath` answers `null` on a
malformed escape — that path is not one this router has — **and** the request
listener is wrapped (`serveGuarded`), so anything thrown or rejected anywhere in
`serve` is logged with an error id and answered `500 core-error` instead of
reaching the process. *Tests:* `api/http.test.ts` (three malformed escapes are
`null`); `api/server.errors.test.ts` — `/v1/kbs/%E0/query` is a `404` and the
next request is still answered, plus a route whose *predicate* throws, which is
the general case rather than a re-run of the specific one.

**2 — BLOCKER: `SEARCH_INLINE_JOBS` did not refuse anything.** The README, the
ADR and these notes all said it "refuses to run outside a test"; nothing
checked. *Fix:* the variable is in the configuration schema, and `config()`
throws unless `inATestEnvironment()` — the same allow-list
`SEARCH_DEV_INSECURE` uses, moved to `config.ts` so there is one copy of the
answer — and `inlineJobsEnabled()` throws as well, so no code path reaches the
in-process backend by asking the question instead of reading the configuration.
The wording in `README.md`, `queue/inline.ts` and `config.ts` now says where
each refusal is. *Test:* `queue/inline.test.ts` (8 cases: both refusals, both
ways in, the default, and `inATestEnvironment` itself).

**3 — `413` was an `ECONNRESET`.** `readBody` called `req.destroy()`
synchronously after rejecting, so the socket was gone before `sendError` wrote a
byte; the existing unit test used a socket-less `PassThrough` and so passed
falsely. *Fix:* the read is paused and the buffer dropped, the refusal carries
`connection: close`, and Node ends the socket after the response is flushed.
*Test:* `api/http.test.ts` now boots a real `http.Server` with small injected
caps and asserts `413 payload-too-large` for a JSON body and for a multipart
envelope (both go through the same `readBody`); reverting the fix turns both
into `socket hang up` / `ECONNRESET`.

**4 — router refusals were not the contract's error body.** `sendRefusal` wrote
`{ code, error }`, and `ErrorBodySchema` requires `message` (ADR 0009 D6 says
`error` is written *beside* it). The router refuses through that function, so
every scope, KB, route and certificate refusal was undescribed. *Fix:* all three
keys, always, plus `detail` where there is one (the `500`'s error id). *Test:*
`api/server.errors.test.ts` — `ErrorBodySchema.safeParse` succeeds and
`error === message` for `scope-forbidden`, `kb-forbidden`, `not-found` (unknown
route and a thrown refusal), `client-certificate-required` and `core-error`.

**5 — the "404, not 403" test asserted neither.** Its `403` came from a client
id with no `paired_client` row, which is the certificate gate. *Fix:* the fixture
suite now seeds a **second real paired client** (`admin`, no KB allow-list, its
own endpoint and its own KB) and asserts `404 not-found` for client A's KB on
client B's `GET`, `PATCH`, query, documents list, keywords, clusters,
tag-definitions, `extract-keywords` and `DELETE` — with A's KB unchanged
afterwards and B's own KB answering on the same routes. The old test keeps its
`403` assertion under a title that says what it is.

**6 — a KB could be bound to another client's sealed key.** `POST /v1/kbs` and
`PATCH /v1/kbs/:id` passed `embeddingEndpointId` / `inferenceEndpointId` to the
frozen service, which looks the embedding one up with no `paired_client_id`
predicate and never looks the inference one up at all. *Fix:* one route-level
helper, `requireOwnedEndpoints`, over the endpoint registry's per-client listing
as it exists on this branch (`api/routes/endpoints.ts`'s `listEndpoints`, which
is TASK-005's name and signature already, so the rebase swaps one import) →
`404 not-found`, which does not confirm the id exists. *Test:* client B is
refused A's embedding id on create, A's inference id on create and on patch, and
its own KB is left unbound.

**7 — `baseUrl` was an SSRF hole.** `resolverUrl` went through
`validateExternalUrl` and a local declaration's `baseUrl` did not, while
`models/embedding.ts` posts to it. *Fix:* every declared `baseUrl` through the
same guard at `PUT /v1/endpoints`, before anything is written. *Test:*
`169.254.169.254`, a private address and a plain `http://` host are each `400`,
and the failed pushes leave the client's declared endpoint exactly as it was.

**8 — multipart ingest ignored `includedInKb` and `metadata`.** Both are on the
contract and the SDK sends both; the route hard-coded `includedInKb: true`.
*Fix:* `includedInKb` is honoured (and a value that is neither true nor false is
a `400`) — `false` stores the row and the bytes and runs no pipeline, which is
what `ingestDocument` does with the flag on the text path — and `metadata` is
parsed and validated with the JSON encoding's own `MetadataSchema`. `metadata`
on a *file* ingest stays accepted-and-unwritten, because only `ingestDocument`
carries it onto chunk rows and that is frozen (ADR 0005); the JSON `url` branch
is the same pipeline and behaves the same, and `docs/external-api.md` now says
so in a table rather than leaving it to be discovered. *Tests:* a multipart
ingest with `includedInKb: false` has no chunks and cannot be matched by a query
for a phrase unique to it; a malformed `metadata` and a nonsense `includedInKb`
are each `400`.

**9 — `extract-keywords` trusted a `documentId`, and so did the announcement.**
The route never checked that the document was in `kbId`, and `runSearchJob`'s
`finally → announce()` read the document row by id and published to *that row's*
owner — so client B could raise a real `document.ingested` on client A's stream.
*Fix:* `requireDocument(kbId, documentId)` in the route (`404`), and `announce`
cross-checks the row's `knowledge_base_id` against the KB the payload named
(under either spelling, `knowledgeBaseId` or `kbId`) and skips with a warning on
a mismatch. *Tests:* the route refuses the foreign pair for B and for A, and
accepts the honest one; the announcement test calibrates on the honest payload
(one event on the emitter, which is the observation point because the webhook
ledger de-duplicates a re-announce) and then asserts nothing at all for the same
document named under the other client's KB.

**10 — NIT: `GET /v1/kbs` read every row on the instance.** `languagesFor`
selected every `knowledge_base` row and filtered in memory. *Fix:* restricted to
the ids asked for and to the calling client. Covered by the existing listing
tests.

### Asked for in the same round: the caller's own `documentId`

Studio has to keep its own document ids when it ingests through Search — the
same ids before and after wiring. `documentId` (1–128 chars) is on **both**
ingest contracts (`IngestJsonRequestSchema`, and a plain string part on
`IngestMultipartFieldsSchema`), threaded through `kbs.ingest` /
`ingestFormData`, and passed to the staged row so `stageIngestedDocument`
inserts with it. It is scoped by the KB, in one helper for both encodings
(`documentForSuppliedId`): free → created with that id; taken **in this KB** →
the idempotent re-ingest the engine already supports, answered with the existing
document's status, no second row and no new work; taken **in another KB or by
another client** → `409 conflict`, never an overwrite (`document.id` is the
primary key across every KB, and the refusal says nothing about whose the other
row is). The response echoes the supplied id. `kbs.create` is untouched — Search
still generates KB ids. *Tests:* both encodings keep the id and reach
`completed`; the same id twice in one KB is one row and the second answer is its
status; the conflict is asserted for JSON, for multipart, and across the two
clients. Documented in `docs/external-api.md`.

### Deliberately left, and recorded rather than fixed

The reviewer marked these and asked for them to stay: the multipart parser's
leniencies (#11), the SDK's error codes (#12), archived-KB reachability (#14),
`stageIngestedDocument`'s tag spread (#15 — frozen engine), upload buffering
(#16) and webhook delivery timing (#10 of the review). The rate limiter still
covers only `POST /kbs/:kbId/query`, and SSE is still in-process.

### TASK-005 preparation (no 005 code)

`jobs/run.ts`'s dispatch table is now the **only** place a job name is spelled:
`FINALIZE_JOB_NAMES` is gone and `JOB_HANDLERS` carries both wire spellings of
the finalize job (`kb.document.finalize`, `kb.embed.finalize`) beside the other
five, with `SEARCH_JOB_NAMES` exported off it. The file's header states that the
BullMQ worker must call `runSearchJob` rather than a handler, so both transports
run the same code including the announcement. `jobs/types.ts` gains
`KbIngestDocumentPayload`, which names the `kb.ingest.document` fields the frozen
`ingestDocument` actually destructures (`kbId`, not `knowledgeBaseId`) and
records that the 005 worker's different shape is what the rebase aligns.

### Gates

`pnpm typecheck`, `pnpm lint` (242 files strippable), `node
scripts/check-strip-types.mjs`, `pnpm audit --prod --audit-level high`, then
`SEARCH_TEST_DATABASE_URL=… pnpm test` — 845 passed (358 shared + 451 core + 36
SDK), the REST fixture suite 33 tests with the fifteen frozen queries still
15/15 — and `rehearse-npm-pack`.
