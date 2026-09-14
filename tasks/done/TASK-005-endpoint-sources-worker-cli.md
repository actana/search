# TASK-005 — Endpoint sources, worker process, CLI

1. `packages/search/src/models/source.ts` per Part 2: `ModelEndpointSource`,
   `LocalEndpointSource` (rows in `model_endpoint`, `key_ciphertext` sealed with
   `SEARCH_ENCRYPTION_KEY`, AES-256-GCM helper copied in shape from Studio's
   `lib/core/security/encryption.ts`), `MirroredEndpointSource` (metadata rows with
   `source='mirrored'`, key fetched from `resolverUrl` with `x-api-key: resolverKey`,
   body `{ workspaceId?: <paired client label/key>, externalId }`, 60 s in-memory TTL,
   never persisted, never logged). Chosen per paired client by what `PUT /endpoints`
   last declared.
2. Worker: `packages/search/src/worker.ts` — BullMQ workers for the lifted job types
   (`ingest.document`, `embed.batch`, `embed.finalize`, `clusters.validate`,
   `keywords.extract`, `document.timeout-sweep`) on queue `search` with prefix `search`;
   `pnpm --filter @actana/search-core dev` runs API + worker in one process, `start:api` /
   `start:worker` split them.
3. CLI `packages/cli` (`actana-search`): `pair new` (mints a code on a running core:
   local admin socket or `SEARCH_ADMIN_TOKEN` over loopback, prints code + CA
   fingerprint), `pair ls`, `pair revoke <id>`, `endpoint add`, `kb ls|create|rm`,
   `ingest <kb> <file>`, `query <kb> "<text>"`, `status`. Uses `@actana/search` only.
   Config in `~/.actana-search/cli.json` (registration blob per profile).
4. Tests for the sources (TTL, never-store), the worker wiring, and the CLI arg parsing.

## Outcome

Landed on `feat/endpoint-sources-worker-cli`, off the `beta/0.1.0` train at
`65a8d9c`. ADR
[0010](../../docs/adr/0010-the-worker-is-searchs-own-and-a-missing-key-fails-a-job-cleanly.md)
records the decisions.

### 1. Endpoint sources

`ModelEndpointSource` is finished and **the choice between its two
implementations is made per endpoint row, not per process** — there is no "wired
mode" flag. `model_endpoint` carries `paired_client_id` and `source`, so an
endpoint id is enough, and one instance serves a standalone client and a wired
one at once (`routing-endpoint-source.ts`, ADR 0010 D8). The engine's call sites
in `kb/provider-context.ts` are untouched, which is what ADR 0004's seam was
for.

- `local-endpoint-source.ts` — unchanged except one correctness fix:
  `providerKey` now narrows to `source = 'local'`. Without it a client with a
  mirrored Mistral endpoint resolved to `''` and the OCR step read that as "not
  configured" rather than "ask the resolver" — a silent change to what a
  document parses into.
- `mirrored-endpoint-source.ts` — new. Resolver call with `x-api-key`, body
  `{ workspaceId, externalId }`; 60-second in-memory cache keyed
  `(clientId, externalId)` with concurrent misses collapsed into one call; never
  persisted, never logged.
- `endpoint-key-errors.ts` — new. `EndpointKeyUnavailableError` with a `reason`
  and a `retryable` derived from it; `redactSecret` / `scrubSecret`.
- `endpoint-registry.ts` — new. The write-through surface TASK-004's
  `PUT /v1/endpoints` calls.
- Migration **0002** adds one column: `search.paired_client.endpoint_source`
  jsonb, holding `{ kind: 'local' }` or
  `{ kind: 'mirrored', resolverUrl, resolverKeyCiphertext, resolverScope? }`.
  NULL reads as local. The resolver credential is sealed, never plain — it is
  the credential that *fetches* provider keys, so `SEARCH_ENCRYPTION_KEY` is
  required in wired mode too (ADR 0010 D7).

`resolverScope` is the field TASK-004 and TASK-008 have to agree on: Search
echoes it to the resolver as `workspaceId` and falls back to the paired client's
id. Search does not learn what it names (CONTEXT rule 5).

### 2. Worker

`packages/search/src/worker.ts` — one BullMQ worker on `search-knowledge` under
`SEARCH_QUEUE_PREFIX` (default `search`, now settable so two Search instances
can share a Redis). Concurrency, lock duration and stall settings are Studio's
knowledge-queue numbers. Routes seven job names, including two that were wrong
or missing before: the flow's parent is `kb.embed.finalize` (the `JobType` union
said `kb.document.finalize`, which nothing enqueued) and `kb.ingest.document`
now has a handler.

Failure handling is the half ADR 0010 is about: a retryable
`EndpointKeyUnavailableError` retries with exponential backoff and is logged at
warn; an exhausted or terminal one marks the document `failed` — one `UPDATE`
narrowed to a non-terminal status, so it is idempotent — and emits
`document.failed`.

`events.ts` is a small in-process emitter defined here because TASK-004's does
not exist yet; it is the file to delete in the rebase.

### 3. CLI

`packages/cli` — `pair new|ls|revoke|redeem`, `status`, `endpoint add|ls`,
`kb ls|create|rm`, `ingest`, `query`. Vanilla arg parsing, `--json` everywhere,
Control's exit-code blocks, profiles in `~/.actana-search/cli.json` at 0600 in a
0700 directory (re-applied every write, atomic rename). `bin/actana-search.mjs`,
and a README.

`endpoint add` needs an authenticated route that does not exist yet, so it goes
through the admin socket as `POST /admin/endpoints` — added to `admin-server.ts`
behind an injectable port and **marked there for removal** when
`PUT /v1/endpoints` lands. `kb`, `ingest` and `query` call SDK namespaces that
throw `not-implemented`; the CLI turns that into a clear sentence and exit 3,
and they start working when the branches merge.

### 4. Deploy

`healthcheck.mjs` now calls `GET /v1/health` pinned against the instance's own
CA from `material.json`, falling back to the bare handshake before there is one.
`docker-compose.yml` documents the `SEARCH_WORKERS=off` + `start:worker` split
and carries the two new variables. `start:api` / `start:worker` scripts added.

### 5. Gates

Against `search_test_b`, with Redis prefix `search-test-b`:

| | |
|---|---|
| `pnpm typecheck` | green, 4 packages |
| `pnpm lint` | green, 225 files strippable |
| `pnpm audit --prod --audit-level high` | green (3 moderate, 2 high ignored per ADR 0007) |
| `pnpm test` | **852 passed**, 6 skipped, 1 todo — shared 358, core 421, sdk 21, cli 52 |
| `node packages/cli/bin/actana-search.mjs --help` | works |

New suites: `models/mirrored-endpoint-source.test.ts` (22),
`models/endpoint-registry.integration.test.ts` (15), `worker.test.ts` (16),
`worker.integration.test.ts` (2 — a real `kb.ingest.document` job end to end,
and a mirrored endpoint whose resolver is not answering),
`api/admin-endpoints.test.ts` (12), and the three CLI suites (52).

### Unfinished, deliberately

- `kb`, `ingest` and `query` wait on TASK-004's REST surface.
- `POST /admin/endpoints` is a stopgap; `PUT /v1/endpoints` replaces it.
- `events.ts` is provisional — TASK-004's emitter supersedes it.
- ADR 0009 is left free for TASK-004.
