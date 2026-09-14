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
