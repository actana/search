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
