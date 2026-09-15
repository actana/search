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

## Review fix round (2026-09-15)

Nine of the review's findings, each with a test. Kept local on purpose: this
branch rebases onto TASK-004, so `api/routes/endpoints.ts`, `queue/index.ts`,
`src/events.ts`, the `kb.ingest.document` payload shape and `worker.ts`'s
structure are untouched.

### 1 — BLOCKER: the resolver call was an unguarded `fetch` (SSRF)

`sealDeclaration` accepted any `http(s)` URL — including
`http://169.254.169.254/latest/…` and `http://10.0.0.5/`, the instance's own
metadata service and the operator's internal network — and
`mirrored-endpoint-source.ts` then dialled it with a bare `fetch`, whose default
`redirect: 'follow'` makes Node re-send both the `x-api-key` header and the POST
body to whatever host a `307` names. The answer was `await response.json()` with
no size cap (finding 2).

**Fix.** `validateExternalUrl` at declaration (`endpoint-registry.ts`) *and*
before each call, so a bad URL is a `400` to the client that asked and a
terminal `refused` to a job rather than five attempts. The call itself goes
through `secureFetch` — validated protocol/port/address, the connection pinned
to the address that was validated, `maxRedirects: 0` (a resolver that redirects
is refused, never followed), a timeout, and `maxResponseBytes: 8 KB`.
`SEARCH_ALLOW_LOCAL_FETCH=1` is the guard's own switch and re-admits loopback
for a single-machine deployment; it is set in `worker.integration.test.ts`,
which declares loopback resolvers, and deliberately not set anywhere else.
New reason `refused`, terminal.

**Tests.** `mirrored-endpoint-source.test.ts`: six refused URL shapes (loopback
by name and by address, link-local, two private ranges, plain http to a public
host, a blocked port), each asserting the injected fetch was never called; the
same loopback URL admitted once the switch is set; and a `describe` that runs
the *production* path against two real loopback listeners — a key resolved
through `secureFetch`, a `307` to a second origin refused with that origin
recording zero requests, and a 4 KB answer refused against a 256-byte cap.
`endpoint-registry.integration.test.ts`: seven URL shapes refused at
declaration, the switch admitting loopback, and the column unchanged after a
refusal.

### 3 — a terminal failure burned every BullMQ attempt

`handleJobFailure` knew a `404 unknown-endpoint` would say the same on the fifth
attempt and marked the document `failed` on the first — and BullMQ, which has
never heard of `retryable`, re-queued the job anyway. Every attempt ran a whole
ingest against a stale mirror to arrive at the same 404.

**Fix.** `processSearchJob` classifies before it re-throws
(`isTerminalJobFailure`) and a terminal failure leaves as BullMQ's
`UnrecoverableError`, carrying the original as its `cause` so the typed `reason`
still reaches the log line and `document.failed`. A job name this build does not
know, and a payload with no knowledge base, are `NotRunnableJobError` — the same
decision under another name. `handleJobFailure` reads the reason through the
`cause` as well as the error.

**Tests.** `worker.test.ts`: the wrapper preserves message and cause; each of
the four new terminal reasons is terminal; a transient key failure and an
ordinary error are re-thrown untouched; an unknown job name and a bad payload
are unrecoverable; the wrapped failure still fails the document once with its
reason. `worker.integration.test.ts` adds a third case — a *live* loopback
resolver answering 404 for a second paired client — and asserts
`attemptsMade === 1`, one resolver round trip, and exactly one document row in
`failed`.

### 5 — `SEARCH_ENCRYPTION_KEY` was not a boot failure

Neither `index.ts` nor `bootWorker` validated it; `encryption.ts` threw at the
first *use*, with a generic error, hours after the mistake.

**Fix.** `assertEncryptionKeyConfigured()` called first in both, and the check
is hex-shaped rather than merely 64 characters long — `Buffer.from(key, 'hex')`
stops at the first non-hex character and hands back a short key without
complaining. A decrypt failure in `openResolver` is now
`EndpointKeyUnavailableError` with reason `decrypt-failed`, terminal, so #3
classifies it. `config.ts`'s "In wired mode nothing is sealed here" comment is
corrected to match ADR 0010 D7. ADR 0010 D7 now records that the `iv:ct:tag`
envelope carries **no key version**, so rotation is a re-sealing migration and
not a variable change — the deliberate cost of being byte-compatible with
Studio's format for the phase-4 data move.

**Tests.** `encryption.test.ts`: the boot check passes on 64 hex characters and
fails on absent, wrong-length and 64-non-hex.
`endpoint-registry.integration.test.ts`: a ciphertext this key did not seal is
`decrypt-failed`, `retryable: false`.

### 6 — the resolver silently overrode `model` / `provider` / `baseUrl`

`resolved.model ?? row.model` read as a freshness rule and was a silent
corruption: a KB's partition has a vector column sized to the dimension the
client declared when it pushed the row, so a resolver answering with another
model embeds the next chunks into a different space in the same table, at a
width that may well fit and that nothing downstream can detect.

**Fix.** Only `apiKey` is taken. For an **embedding** endpoint a disagreement
about the model or the provider is refused — new reason `model-mismatch`,
terminal — because that is the case where dimensions would differ. A `baseUrl`
disagreement warns and uses the row's value (moving a deployment behind a new
URL is legitimate and does not move the embedding space); an inference endpoint
has no partition to corrupt and only warns.

**Tests.** `mirrored-endpoint-source.test.ts`: the old "prefers the resolver's
baseUrl and model" test is replaced by five — key-only when everything agrees,
model mismatch refused, provider mismatch refused, `baseUrl` ignored in favour
of the row, and an inference model mismatch warned rather than refused.

### 7 — scaled worker containers were permanently unhealthy

The documented split snippet inherits the image's single `HEALTHCHECK`, which
probes `/v1/health` on 7443 — and a worker container serves nothing. In compose
that means `--wait` never returns, `depends_on: service_healthy` never fires,
and an orchestrator restarts a healthy worker in a loop.

**Fix.** Chose role detection over `healthcheck: { disable: true }`, because the
latter buys a container with no liveness signal at all. `SEARCH_ROLE=worker`
switches `deploy/healthcheck.mjs` to `PING` the Redis the worker dials — hand
rolled RESP over a socket, so the probe depends on nothing a `--prod` install
could leave out, with `rediss://` and `AUTH` handled. Queue *depth* is
deliberately not part of it. Documented in the `docker-compose.yml` snippet (now
carrying `SEARCH_ROLE: "worker"` and a note saying it is not optional), in
`deploy/README.md`, and as ADR 0010 D10.

### 8 — the resolved-key cache was never invalidated and only swept lazily

**Fix.** `invalidateResolvedKeysFor(clientId)` drops a client's entries —
in-flight resolutions included — and is called from `setEndpointSource`,
`upsertMirroredEndpoints` and `deleteEndpoint`. Separately,
`sweepResolvedKeyCache` runs on insert (the only moment the map grows), drops
what has expired and enforces `RESOLVED_KEY_CACHE_MAX`: the lazy TTL check only
fires on a read, so a churned `externalId` was a live provider key held for the
life of a process that runs for weeks.

**Tests.** `mirrored-endpoint-source.test.ts`: one client's entries dropped and
another's left, then a re-resolve; five expired entries swept on the insert of a
sixth. `endpoint-registry.integration.test.ts`: the cache emptied by a
re-declaration, by a re-push, and by a delete.

### 9 — an endpoint row was selected by `id` alone

**Fix.** `EndpointBinding` gains an optional `pairedClientId`, and
`assertEndpointOwner` refuses a row belonging to anyone else with a terminal
`client-mismatch` — in `routing-endpoint-source.ts` for local and mirrored rows
alike, and again in `MirroredEndpointSource.row`. Optional because the engine's
lifted call sites have an endpoint id and no client, which is what ADR 0004's
seam is for; the route-level check is the primary one and lands on the 004
branch.

**Tests.** `mirrored-endpoint-source.test.ts`: refused for another client
without asking the resolver, resolved for the owner.
`endpoint-registry.integration.test.ts`: two real paired clients and one
endpoint id — the owner gets it, the other is refused terminally.

### 10 — the combined process never closed its listeners

`installShutdownHandlers` drained the worker and called `process.exit(0)`, so in
`index.ts` an in-flight request was cut mid-response and `admin.sock` survived
for the next boot; with `SEARCH_WORKERS=off` there were no handlers at all.

**Fix.** It now takes optional closers and `drainAndClose` runs them in order —
worker first (a job in flight still needs the database and the queue), then the
API, then the admin listener, which unlinks its own socket. Every close is
best-effort and independent. `index.ts` installs them whether or not the worker
is in this process.

**Tests.** `worker.test.ts`: the ordering against fakes, the no-worker case, and
a worker and a listener that both refuse to stop without preventing the next
close.

### 11 — NITs

`-v` is documented beside `-V` in `HELP` (it was always accepted), and
`endpoint ls` now shows `--client <id>` at the top level as it already did in
its own help. Tested in `cli-args.test.ts`.

### Deferred to the rebase, deliberately

- **Finding 4** (a document row per attempt) — fixed at rebase: TASK-004's
  `kb.ingest.document` payload carries `documentId`, so the ingest resumes one
  row instead of inserting another. Narrowed meanwhile by #3, which stops a
  terminal failure at one attempt.
- **Finding 12** (`fileUrl`, the dead path) — dropped at rebase with the
  payload shape.
- **`POST /admin/endpoints`** — the stopgap goes when `PUT /v1/endpoints` lands.
- **`events.ts`** — superseded by `events/{emitter,publish}.ts`; ADR 0010's last
  paragraph about it is left for that commit.

### Gates

Against `search_test_b`, Redis prefix `search-test-b`:

| | |
|---|---|
| `pnpm typecheck` | green, 4 packages |
| `pnpm lint` | green, 225 files strippable |
| `node scripts/check-strip-types.mjs` | green, 225 files |
| `pnpm audit --prod --audit-level high` | green (3 moderate, 2 high ignored per ADR 0007) |
| `pnpm test` | **905 passed**, 6 skipped, 1 todo — shared 358, core 472, sdk 21, cli 54 |
| `migrate-cli.ts` | applied cleanly against a dropped schema |

Up from 852: +19 in `mirrored-endpoint-source.test.ts`, +14 in `worker.test.ts`,
+13 in `endpoint-registry.integration.test.ts`, +4 in `encryption.test.ts`,
+2 in `cli-args.test.ts`, +1 in `worker.integration.test.ts`.

## Rebase onto TASK-004 (2026-09-15)

The six commits above were replayed onto `feat/rest-api-and-contracts`
(TASK-004, fix round applied) and the two designs stitched into one. Two
conflicts, both textual: `src/index.ts`'s header paragraph and `README.md`'s
status block plus its ADR table — resolved by keeping both. `queue/index.ts`
and `config.ts` merged on their own, correctly: the inline seam returns before
`prefix: queuePrefix()`, and `SEARCH_INLINE_JOBS` sits beside
`SEARCH_QUEUE_PREFIX` and `SEARCH_WORKER_CONCURRENCY`. TASK-004's
`events/publish.ts` is marked binary by git (a literal NUL in the `join`
separator of `searchEventId`); nothing on this branch touched it, so it never
conflicted and its bytes are untouched.

The division of the merge was: **004 wins on the REST surface, the events, the
job dispatch and the payload shape; 005 wins on the endpoint registry, the
worker process, the configuration, the CLI and the deploy.** What follows is
every place the two designs actually met.

### The endpoint registry — one implementation, four bridges

`api/routes/endpoints.ts` was TASK-004's own copy of this branch's registry,
written against these names and this argument order so that the merge would be
a deletion. It is now a route and nothing else: it imports
`models/endpoint-registry.ts` and keeps the three things a route owes a caller
that a module underneath it must not know about — the contract, the
reconciliation of the declared *set* (`removeUndeclared`, over
`listEndpoints`), and a status code for a refusal.

1. **`upsertMirroredEndpoints(clientId, inputs)` has no sealed-resolver
   argument.** 004's copy threaded the sealed resolver into each row's
   `config.__resolver`; this branch put the declaration on
   `paired_client.endpoint_source` (migration 0002) instead, which is one fact
   about a client in one place rather than one copy per endpoint row.
   `RESOLVER_CONFIG_KEY` and the `config` stripping that went with it are gone,
   so a row's `config` is now only what the client declared.
2. **`createLocalEndpoint` is an upsert.** 004's was, because `PUT
   /v1/endpoints` is declarative: an insert-only local path means the second
   push creates a second row and the reconciliation then reaps the first, which
   is a KB's `embedding_endpoint_id` pointing at a row that has gone.
   `LocalEndpointInput` gains `externalId`, the insert is
   `onConflictDoUpdate` on `(paired_client_id, external_id)` with the partial
   index's predicate restated, and `apiKey: null` — "the declaration said
   nothing about the key" — leaves the ciphertext where it is while `''` is
   still refused. A row with no `externalId` (the old admin path) is inserted
   plainly and is neither upserted onto nor reaped. There is no second inline
   path. *Tests:* `endpoint-registry.integration.test.ts` — the same
   `externalId` twice is one row with the first key still decryptable, a later
   push with a key rotates it, and two keyless registrations are two rows
   (30 in that suite, up from 28).
3. **`getEndpointSourceSummary` returns an object, and the contract now says
   so.** This branch returns `{ kind, resolverUrl, resolverScope }` — the
   *declaration* — and `GetEndpointsResponseSchema.source` was the
   `'local' | 'mirrored'` enum. Mapping `.kind` down to the enum was the
   smaller change and it throws away the field the three sides have to agree
   on: `resolverScope` is what Search echoes as the resolver's `workspaceId`
   (ADR 0010 D5), and a client that has just pushed a catalog needs to read
   back which scope its keys will be asked for under. So the contract is
   `EndpointSourceSummarySchema`, a discriminated union on `kind`, carrying no
   credential. It is also a different *fact* from the enum: derived from the
   declaration rather than from the rows, so a client that has declared a
   resolver and pushed nothing yet reads `mirrored` rather than `local`. The
   SDK's own tests do not assert on the value and are unchanged; the REST
   fixture suite does not read it.
4. **The registry's plain `Error`s are `400`s at the route.** It is reached
   from a job and from the CLI as well, where a status means nothing, so it
   throws prose — "a mirrored source needs a resolverUrl", the SSRF guard's
   verdict, "an embedding endpoint needs a dimension". Untranslated, every one
   of them reached the router's catch-all as `500 core-error`, which tells a
   client that named a private resolver address that *Search* is broken.
   `asBadRequest` wraps the three registry calls and leaves a refusal the
   router already understands alone.

Kept as they were: 004's `removeUndeclared` (an endpoint a KB is bound to
survives being left out of a push), and `baseUrl` validation at the route (004
fix #7) — that URL is posted to by `models/embedding.ts` and the registry never
sees it. 004's duplicate `validateExternalUrl` on `resolverUrl` is **removed**,
because `sealDeclaration` does it (005 fix #1) before the column is written,
which is the same moment for the same caller. `api/routes/kbs.ts`'s
`requireOwnedEndpoints` (004 fix #6) was one import swap, as its own comment
predicted.

### Events — one door

`src/events.ts` is deleted. The worker's two `emitSearchEvent` calls are now
`publishSearchEvent(pairedClientId, event)` over TASK-004's
`events/{emitter,publish}.ts`, with the deterministic `searchEventId` (ADR 0009
D8a). `SearchEventSchema` gains `reason?: string` — 005's typed classification
of a failure (`unknown-endpoint`, `resolver-error`, …) beside 004's `error`,
which is the operator's sentence; an open string rather than an enum, because
the reasons are Search's vocabulary and a client must not break when one is
added. `worker.test.ts`'s event assertions are rewritten to the wire shape
(`type`→`event`, `knowledgeBaseId`→`kbId`) against a mocked
`events/publish.ts`. ADR 0010's closing paragraph about `events.ts` is
rewritten to the merged design and ADR 0009 D9 now names what the transport
owes it.

### Job dispatch — one table

`jobs/run.ts` is the single dispatch table both transports go through, and
`worker.ts` no longer has a `switch`. Folded in from this branch:

- **`withTimeout` became the table's own per-attempt budget.** Each entry may
  carry `budgetMs(payload)`; `knowledge-process-document` keeps Studio's
  size-scaled parse budget and `kb.embed.batch` the fifteen minutes, both
  handed to the handler as an `AbortSignal`, combined with an optional caller
  `signal` via `AbortSignal.any`. The inline runner used to run these
  unbudgeted.
- **`kb.document.timeout-sweep` has a handler.** 004's table threw "no handler"
  for it, and it is the one job that is registered as repeatable rather than
  enqueued.
- **Both finalize spellings stay** (`kb.document.finalize`,
  `kb.embed.finalize`): both are on the wire.
- **`UnrecoverableError` classification wraps `runSearchJob`** (005 fix #3),
  and `NotRunnableJobError` now covers the two pre-dispatch refusals — a job
  name `isKnownJobName` does not know, and a `kb.ingest.document` payload with
  no `kbId`, no `filename` or no `text`.
- **`handleJobFailure` / `failDocument` are kept**, with `documentOf` reading
  `kbId` as well as `knowledgeBaseId` — the ingest payload says the former,
  because that is what the frozen `ingestDocument` destructures, so reading
  only the latter left an ingest job's document in `pending` with nothing said
  about it.

### The `kb.ingest.document` payload

004's `KbIngestDocumentPayload` is adopted whole (`kbId`, `documentId`, `text`,
`filename`, `mimeType`, `metadata`, `includedInKb`, `tags`) and this branch's
shape is gone, along with its `fileUrl` branch (finding 12 — nothing enqueues
it; a file-backed document goes to `knowledge-process-document`). The worker
forwards `documentId` and `tags` straight through, so a retry resumes the row
the route staged instead of inserting another — **finding 4, closed**. Note
that `includedInKb` now has the frozen engine's default (`false`, "uploaded but
not chunked") rather than the worker's old `?? true`; every route that
enqueues the job states it.

### The `document.failed` that was not a failure yet

The post-merge behaviour this rebase had to decide, and the only place the two
designs were actually in conflict rather than merely different. 004 announces
from the job's completion by reading the row the engine wrote — and the engine
writes `failed` as soon as *this attempt* gave up, which under ADR 0010 D4 is
routinely a resolver that will answer on the next one. Published as-is, every
rolling restart on a wired client raises `document.failed` on that client's
stream and Studio's trigger acts on it.

**Decided: announce a failure only from the terminal attempt.** The worker
passes `attemptsRemaining` (BullMQ's own `attempts - (attemptsMade + 1)`) to
`runSearchJob`, and the announcement is held back while that is above zero. A
*success* is announced whatever the number. The event a terminal reason
produces — where the engine never got as far as the row — comes from
`failDocument` instead, with the typed `reason` on it; both paths derive the id
from the same facts and claim it from one set (`claimAnnouncedEvent`), and
`failDocument` falls through to announce when its narrowed `UPDATE` matched
nothing *because the row was already `failed`*, which is the gap the two doors
would otherwise leave. The named cost: a document is `failed` in the database
before it is `failed` on the wire.

### The rest

- **`queue/index.ts`**: 004's inline seam at `getJobQueue()` /
  `getFlowProducer()` returns before this branch's `prefix: queuePrefix()`;
  `JobType`'s `kb.embed.finalize` correction and `kb.document.timeout-sweep`,
  and `JOB_BACKOFF` on both enqueue paths, are all kept.
- **`index.ts`**: 004's `registerRoutes` (and no "No REST surface yet" warn)
  plus this branch's `assertEncryptionKeyConfigured()` and
  `installShutdownHandlers(workers, [api, admin])`. **`SEARCH_INLINE_JOBS=1`
  now also skips `startWorkers`** — the fixture suites must be able to boot a
  server without a Redis, and two runners on one job would race.
- **`api/admin-server.ts`**: the `GET`/`POST /admin/endpoints` stopgap is gone,
  with `AdminEndpointPort`, `LocalEndpointDraft`, `resolveClientId` and
  `admin-endpoints.test.ts` (−12 tests). What is left on that socket is the one
  thing that cannot be authenticated over mTLS, because it is what mints the
  credential.
- **The CLI's `endpoint add|ls` are client-side verbs** over
  `client.endpoints.put` / `.get` with the redeemed profile, sharing
  `kb-command.ts`'s `withClient`. `PUT` is declarative, so `add` is a
  read-modify-write: it reads the current set, re-declares it *without* keys
  (which is what leaves every sealed ciphertext alone), appends the new one and
  pushes the whole thing. `--client` is gone — the certificate is the paired
  client — and `--external-id` replaces it as the upsert key, defaulting to a
  slug of the kind, the provider and the model. `endpoint add` against a client
  that has declared a *mirrored* source is refused with the sentence rather
  than attempted. The key is still `--key-stdin` only, never argv.
  `cli-deps.ts`, `cli.ts`'s help, `packages/cli/README.md`, `admin-client.ts`
  (the two endpoint functions and `AdminEndpointRow` deleted) and
  `cli-args.test.ts` follow.
- **`config.ts`**: this branch's additions and 004's test-only
  `SEARCH_INLINE_JOBS` coexist; `config()` still throws if the latter is set
  outside a test. Migrations: 004 adds none, `0002` stays, the journal's `when`
  ordering is unchanged and the migrator applies cleanly against a dropped
  schema and skips on a second run.
- **`deploy/Dockerfile`**: the bug the Studio compose reviewer found. The image
  copies `packages/` and `scripts/` and never `deploy/`, so its own
  `HEALTHCHECK CMD node /app/deploy/healthcheck.mjs` failed with "Cannot find
  module" on every container it has ever produced — both roles, and the compose
  probes with them. `COPY deploy/healthcheck.mjs deploy/` is added, and only
  that file: the Dockerfile, the compose file and the deploy README are what
  *builds and runs* the image rather than what runs inside it. A `.dockerignore`
  is added at the root — `node_modules` above all, since `COPY packages/` was
  otherwise copying a host tree over an install that had already happened — and
  it says in as many words that `deploy/` is deliberately not ignored.
  **Not built here.** To verify: `docker build -f deploy/Dockerfile -t
  actana-search:probe .` then `docker run --rm actana-search:probe ls
  /app/deploy` (expect `healthcheck.mjs`) and `docker run --rm
  actana-search:probe node /app/deploy/healthcheck.mjs` (expect a connection
  refusal against no instance, **not** `Cannot find module`); end to end,
  `docker compose -f deploy/docker-compose.yml up -d --wait` returns rather
  than hanging.
- **Docs**: `README.md` and `CONTEXT.md` carry both branches' additions and
  both ADR rows; `docs/external-api.md`'s endpoint section documents the
  `source` object, the local upsert by `externalId` and the "omitted `apiKey`
  keeps the key" rule, and its events section the `reason` field and the
  held-back failure; ADR 0009 and ADR 0010 cross-reference each other where the
  designs met.

### Nothing left unreconciled

Every item on both reviewers' lists is above. One thing was *decided* rather
than merely merged (the held-back `document.failed`) and one thing was decided
against the letter of the brief and is argued for here rather than silently
done (`GetEndpointsResponseSchema.source` as an object rather than the enum).

### Gates

Against `search_test_b`, schema dropped first, Redis prefix `search-test-b`:

| | |
|---|---|
| `pnpm typecheck` | green, 4 packages |
| `pnpm lint` | green, 264 files strippable |
| `node scripts/check-strip-types.mjs` | green, 264 files |
| `pnpm audit --prod --audit-level high` | green (3 moderate, 2 high ignored per ADR 0007) |
| `pnpm test` | **1014 passed**, 6 skipped, 1 todo — shared 358, core 566, sdk 36, cli 54 |
| `fixture-suite.rest.test.ts` | 33 tests, the fifteen frozen queries 15/15, now seeding its endpoints through this branch's registry |
| pairing e2e | 114 passed |
| `migrate-cli.ts` | applied against a dropped schema, and skipped on a second run |
| `rehearse-npm-pack.mjs` | 11 entry points, 74 files |

The new and rewritten suites: `worker.test.ts` 36 (was 30 — the dispatch
assertions moved to the processor, and four new ones cover the held-back
failure and `documentOf`'s second spelling), `worker.integration.test.ts` 4
(was 3 — a resolver that fails twice and then answers, proving one document row
across three attempts and no `document.failed` on the way),
`endpoint-registry.integration.test.ts` 30 (was 28),
`api/admin-endpoints.test.ts` deleted (−12).
