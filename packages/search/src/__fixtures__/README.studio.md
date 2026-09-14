# KB behaviour freeze — fixtures

Plan 14, phase 0 (`TASK-001`). This folder records what Studio's Knowledge Base
engine does **today**, as data the `actana/search` repo can replay. It is the
evidence behind the board's first ground rule — *behaviour is identical* —
rather than an assertion that it is.

```
kb-fixture.json   the whole freeze: corpus, chunking config, embedder spec,
                  keyword vocabulary, fifteen queries, and the expected results
docs/             the 12 source documents, committed verbatim
```

`kb-fixture.json` is plain JSON with relative document paths. Reading it needs
no Studio code: the embedder spec, the keyword extractor's whole 98-term topic
list, and every expectation are inlined. The Search repo copies this folder byte
for byte and replays it over REST in TASK-004.

## Running it

The suite lives in Studio at
`apps/actana/lib/kb/fixture-suite.integration.test.ts` and is env-gated on
`TEST_DATABASE_URL`, like `lib/kb/ingest.integration.test.ts`. Without that
variable every test is skipped.

Bring up the throwaway stack (Postgres with pgvector, Redis, MinIO):

```sh
docker compose -p search-proto \
  -f tasks/search-extraction/proto/docker-compose.search.yml up -d --wait
```

Apply Studio's migrations once, if the database is empty:

```sh
cd packages/db
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/actanastudio \
  bun run ./scripts/migrate.ts
```

Then:

```sh
cd apps/actana
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/actanastudio \
  bunx vitest run lib/kb/fixture-suite.integration.test.ts
```

24 tests, all green. The embedder has its own unit tests, which need no
database:

```sh
cd apps/actana
bunx vitest run lib/kb/testing/hash-ngram-embedder.test.ts
```

13 tests, all green.

Every object the suite creates is prefixed with a fresh run id
(`searchfx-<short id>`) and dropped in `afterAll` — the four KB rows, their
vector partitions, the workspace, the endpoints and the user — so it re-runs
cleanly against a database that already holds data.

## How the expectations were produced

By running the real engine once and freezing what came back.

```sh
cd apps/actana
KB_FIXTURE_RECORD=1 TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/actanastudio \
  bunx vitest run lib/kb/fixture-suite.integration.test.ts
```

In record mode the suite writes `expectedTop5` for each query, plus the
`expectations` block (corpus counts, keyword vocabulary, the per-path results),
back into `kb-fixture.json`, and then runs `bunx biome format --write` on it so
the recording is formatted exactly like the committed file. In normal mode it
asserts them. **Never hand-edit `expectedTop5`** — re-record, then read the
diff. The file deliberately carries no timestamp, so a re-record that changes
nothing produces no diff at all: recording twice in a row is byte-identical, and
that is how the freeze's reproducibility was verified.

Each recorded top-5 was checked for semantic plausibility: the parental leave
query must top out on the parental leave document, the Redis query on the JSON
config, and so on. Three queries did not on their first recording — a
reimbursement question that landed on the changelog, a rate-limit question that
landed on the workflow docs, and the cold-start probe, whose four-word text
cannot separate twelve whole documents once each one is a single chunk. All
three were replaced with better probes, not worked around in the engine. The
`expectations.queries` block also stores the blended scores, keyword scores and
selected query keywords for every query; they are provenance for reading a
future diff, not assertions.

### What is deterministic, and how

Only the external calls are replaced, all through seams Studio already has.
Everything else — chunking, partition DDL, the `embedding` and partition writes,
the batch ledger, cluster fitting, `queryKb`, `handleKbQuery`, the v1 tag+vector
util — is the production code path.

| Seam | Replacement |
|---|---|
| `@/lib/models/embedding` → `executeWorkspaceEmbedding` | `apps/actana/lib/kb/testing/hash-ngram-embedder.ts` — token n-gram hashing into 256 dims, L2 normalised. Pure and dependency-free; the Search repo copies the file byte for byte. The algorithm spec is in the file's doc comment and in `kb-fixture.json`'s `embedder` block. |
| `@/lib/models/inference` → `executeWorkspaceInference` | `apps/actana/lib/kb/testing/deterministic-keywords.ts` — answers Studio's real keyword prompts with the strict JSON a compliant model would return. Keywords are the most frequent terms of the chunk drawn from a fixed **98-term** topic list, inlined in the fixture as `keywordExtractor.vocabulary`. (The corpus exercises 92 of those 98; `expectations.keywordVocabulary` is that recorded subset.) |
| `@/lib/core/async-jobs/config` → `getJobQueue` | Records enqueues instead of dispatching them. The suite then calls `handleClustersValidate` and `handleKeywordsExtract` itself, in the order a worker would. |
| `@actana/queue` → `getFlowProducer` | Records the `kb.embed.finalize` flow and its `kb.embed.batch` children. The suite runs every child, then the parent — the order BullMQ guarantees and `worker/processors/knowledge.ts` dispatches. |
| `@/lib/file-parsers` | Wires the **same** parser classes (`MdParser`, `CsvParser`, `parseJSON`, …) through ESM imports. Studio's registry lazy-loads them with CommonJS `require()`, which Vitest's ESM transform cannot resolve — under the runner the registry comes up empty and every parse fails with "Unsupported file type". Parsing behaviour, including the metadata that steers chunker selection, is unchanged; the parsers have their own tests in `lib/file-parsers/index.test.ts`. |

The keyword extractor draws from a closed topic list rather than from open
frequency ranking for a specific reason. Free-form selection grows a vocabulary
of several hundred keywords, and Studio then hands the model only the top 100 by
usage count (`EXISTING_KEYWORDS_TOP_N`) via `listKbKeywords`, which orders by
`usage_count DESC` with no tie-break. Which keywords fall either side of 100th
place is up to Postgres, and the frozen query keywords differed between
otherwise identical runs. Bounding the vocabulary under 100 removes the
truncation and makes the fixture reproducible. Keywords are still derived from
the text: a term is only ever emitted for a chunk that contains it.

### What is deliberately not frozen

**The cluster count.** `handleClustersValidate` calls `validateK` and
`runClustering` without a seed, so D² seeding falls back to `Math.random` and the
silhouette-chosen `k` varies run to run (12, 8, … on the same corpus). The suite
asserts that clusters exist and that every partition row carries an assignment,
not how many clusters there are. Ranking is unaffected: below
`CLUSTER_PRUNE_MIN_CHUNKS` (50 000) the read path never prunes to clusters.

## The corpus

12 documents, ingested four different ways.

| Knowledge base | Ingested by | Contents |
|---|---|---|
| `hybrid` | `lib/knowledge/documents/service.ts::processDocumentAsync` | All 12 documents, **71 chunks**. The inline (non-BullMQ) fallback. Writes the shared `embedding` table (tags inherited from the document) **and** the per-KB vector partition with the same row ids, then extracts keywords inline. The eight v2 hybrid queries and the v1 tag+vector query run here. |
| `bullmq` | `embed-pipeline.ts::planDocumentEmbedding` → `processEmbedBatch` → `finalizeDocumentEmbedding` → `handleKeywordsExtract` | All 12 documents, **71 chunks**, 12 `document_embed_batch` rows, all `completed`. The **production worker path** (`worker/processors/knowledge.ts:92-117` dispatches exactly these four jobs). Has no queries of its own: every `hybrid` query is replayed against it and asserted to return identical top-5s, and its per-document chunk counts, statuses and keyword vocabulary are asserted equal too. |
| `sdk` | `lib/kb/ingest.ts::ingestDocument` | 4 documents, **25 chunks**. The SDK / runtime-route / `kb_add_file` block path. The only path that writes caller `metadata` into the partition, which is why the metadata-filter probe lives here. See *Known defects*. |
| `defaults` | `lib/kb/ingest.ts::ingestDocument`, KB row inserted with **no** `chunking_config` | All 12 documents, **12 chunks** — one per document. Studio's column default applies, which is the shape a UI-created KB actually has, and the read path sits below the 50-chunk clustering cold start: no clusters are fitted at all. |

The first three KBs use `{ chunkSize: 200, maxSize: 200, minSize: 100, overlap: 24 }`,
language `english`. The numbers are shrunk from Studio's so a 12-document corpus
crosses the 50-chunk clustering cold-start threshold without padding the
documents into something nobody would write. The ingest paths read different
keys out of the same column — `chunkSize`/`overlap` (`lib/kb/ingest.ts`) versus
`maxSize`/`overlap`/`minSize` (`service.ts`, `embed-pipeline.ts`) — so the
fixture sets both to the same numbers.

**Studio has no single set of defaults**, which the `defaults` KB exists to
record. The `knowledge_base.chunking_config` column defaults to
`{"maxSize": 1024, "minSize": 1, "overlap": 200}`
(`packages/db/schema.ts:2642-2644`) — that is what a UI-created KB stores. The
code fallbacks are chunk size 1024 / overlap 128 (`lib/kb/ingest.ts`) and
maxSize 1024 / minSize 100 / overlap 200 (`service.ts`, `embed-pipeline.ts`). So
a UI-created KB and a code-defaulted KB disagree on `minSize` (1 against 100),
and on the `ingest.ts` path they disagree on overlap too: because the column
default supplies `overlap: 200`, `DEFAULT_CHUNK_OVERLAP = 128` is unreachable for
any KB created through the UI. The suite asserts both — the stored column
default, and that `selectChunker` with a `null` config really does produce the
1024/128 chunking.

Documents: three handbook sections (parental leave, expenses and travel, device
security), three product docs (workflow builder, knowledge base, agents), two
operational runbooks (incident response, database maintenance), a changelog, a
REST API reference, a JSON service config for the structured chunker, and a CSV
of support tickets. Topics overlap deliberately — the changelog talks about
parental leave *and* chunk overlap *and* rate limits — so keyword, semantic and
blended ranking pull in visibly different directions.

## The fifteen queries

| # | KB | Query | Params | Probes | Top result |
|---|---|---|---|---|---|
| q01 | hybrid | parental leave entitlement for a birthing parent | `keywordWeight: 1` | pure keyword | `handbook-parental-leave` #1 |
| q02 | hybrid | book rail travel standard class through the company travel desk | `keywordWeight: 0` | pure semantic | `handbook-expenses` #3 |
| q03 | hybrid | incident severity levels and the on-call rotation | defaults | the 50/50 blend | `runbook-incident-response` #4 |
| q04 | hybrid | incident severity levels and the on-call rotation | `minScore: 0.6` | the threshold trims q03's tail from 5 to 3 | `runbook-incident-response` #4 |
| q05 | **sdk** | full disk encryption on company laptops | `filter: {category: handbook}` | metadata filter, on the one path that stores metadata | `handbook-security` #3 |
| q06 | hybrid | chunk overlap and vector retrieval blending | `neighborClusters: 4` | cluster routing after clustering | `product-knowledge-base` #2 |
| q07 | hybrid | exceeding the rate limit returns retry after and backoff with jitter | `includeContent: false` | response shape with content suppressed | `api-reference` #1 |
| q08 | hybrid | redis connection pool idle timeout | defaults | the JSON document and its structured chunker | `service-config` #1 |
| q09 | hybrid | refund request ticket from an enterprise customer | `topK: 3` | the CSV document, and a topK below the default | `support-tickets` #0 |
| q10 | hybrid | parental leave entitlement | two tag filters | the **v1** tag+vector path over the shared `embedding` table | `handbook-parental-leave` #0 |
| q11 | sdk | parental leave entitlement for a birthing parent | `keywordWeight: 1` | q01 on the SDK path, where keywordWeight is a no-op | `handbook-parental-leave` #1 |
| q12 | sdk | incident severity levels and the on-call rotation | defaults | q03 on the SDK path | `runbook-incident-response` #3 |
| q13 | defaults | parental leave entitlement for a birthing parent | `keywordWeight: 1` | q01 at Studio's column-default chunking — document-level retrieval | `handbook-parental-leave` #0 |
| q14 | defaults | knowledge base chunking embeddings keyword vocabulary and hybrid retrieval | `neighborClusters: 4` | cold start: no clusters fitted at all | `product-knowledge-base` #0 |
| q15 | defaults | redis connection pool idle timeout | defaults | q08 where the JSON config is one chunk, not four | `service-config` #0 |

q01, q02 and q03 differ from each other in their top five, which is the point:
the keyword side, the semantic side and the blend are each doing visible work.
q11 and q13 are the same text as q01 with the same `keywordWeight: 1` and return
different rankings on every KB, which is the SDK-path defect below made visible.

Beyond the ranked ids, every query also asserts the returned shape — `matches[]`
with `id`, `documentId`, `chunkIndex`, `content`, `metadata`, `score`,
`semanticScore`, `keywordScore`, plus `usage` — that scores are monotonically
non-increasing, that they sit in [0, 1], and that `minScore` is respected.

## Known defects carried deliberately (decision pending)

These three are frozen because they are what the engine does, not because they
are what it should do. The board rule is *behaviour identical*, so the lift
carries them as-is and the Search repo must reproduce them. **Whether to fix
them before the lift or carry them into `actana/search` is an open decision for
the user** — the evidence is here so that decision can be made on facts.

### 1. `queryKb` accepts `filter` and never applies it

`QueryKbArgs.filter` is declared (`apps/actana/lib/kb/query.ts:73`), accepted by
`kbQueryBodySchema` and forwarded by `handleKbQuery`
(`apps/actana/lib/kb/query-handler.ts:18,65`) — and then the `queryKb`
destructure at `apps/actana/lib/kb/query.ts:110-120` simply does not bind it. It
never reaches the SQL. Every caller that passes a metadata filter gets an
unfiltered result and no error.

q05 freezes this on the `sdk` KB, where `ingestDocument` really does write the
caller's `metadata` into every partition row
(`apps/actana/lib/kb/ingest.ts:314, 320-336` — `metadata` is bound into the
insert as `${JSON.stringify(row.metadata)}::jsonb`). The suite asserts the
returned matches carry that metadata **and** that filtering by it changes
nothing, so the no-op is a defect rather than a missing input.

*Impact if carried:* silent. A caller filtering on `{category: 'handbook'}` gets
handbook and non-handbook chunks alike.

### 2. `ingestDocument` writes only the partition, so its KBs can never carry keywords

`ingestDocument` generates fresh chunk ids and inserts them into
`kb_embedding_<hash>` only (`apps/actana/lib/kb/ingest.ts:309-336`); nothing is
written to the shared `embedding` table. It then enqueues the keyword worker
(`apps/actana/lib/kb/ingest.ts:361`), and that worker reads its chunks *from*
`embedding` (`apps/actana/lib/kb/jobs/keywords-extract.ts:128`). It finds none,
logs "no enabled chunks", marks the document `keywordStatus: 'extracted'` with
zero keywords, and the KB's vocabulary stays empty.

It cannot be repaired by re-running the worker:
`embedding_keyword.embedding_id` is a foreign key onto `embedding.id`
(`packages/db/schema.ts:3043-3045`), so a partition chunk that has no `embedding`
row can never be linked to a keyword at all. Consequently `queryKb`'s keyword
LATERAL join matches nothing, `selectQueryKeywordsFromMenu` returns `[]` for
want of a vocabulary, and `queryKb` forces `keywordWeight` to 0 — every query
against such a KB is semantic-only whatever the caller asked for.

`expectations.sdkPath` records it: `partitionRows: 25`,
`sharedEmbeddingRows: 0`, `keywordVocabularySize: 0`. q11 freezes the
consequence: `keywordWeight: 1` and `keywordWeight: 0` return identical
rankings, and every match has `keywordScore: 0`.

*Impact if carried:* silent, and path-dependent. The same document in the same
workspace ranks differently depending on whether it arrived through the UI
(`processDocumentAsync` / the BullMQ pipeline, both of which write both tables
with shared ids) or through the SDK, the `kb_add_file` block, or the runtime
route.

### 3. `neighborClusters` is inert below 50 000 chunks

Cluster routing is an optimisation for very large corpora; under
`CLUSTER_PRUNE_MIN_CHUNKS` the ANN over-fetch runs unpruned and
`diagnostics.candidateClusterIds` is `null` regardless of what the caller asked
for. q06 asserts `neighborClusters: 4` and `neighborClusters: 0` return the same
five matches. q14 reaches the same `null` for a second reason — on the
`defaults` KB no clusters are fitted at all, because the corpus is under the
50-chunk cold start.

*Impact if carried:* none functionally; the parameter is documented as an
optimisation. Listed because it is a knob that appears to do nothing, and a
reimplementation that honours it would change results.

## Known-failures baseline

These fail on the base branch (`core-integration`) and still fail on
`search-extraction`. They pre-date this board and TASK-001 did not touch them.
Recorded so a future red is recognisable as new.

```sh
cd apps/actana
bunx vitest run lib/kb/query.test.ts lib/kb/ingest.test.ts
# → Test Files 2 failed (2), Tests 5 failed (5)
```

`lib/kb/query.test.ts` — 5 failing tests:

| Test | Failure |
|---|---|
| `queryKb > cold-start (no clusters) → candidateClusterIds null` | `expected 1 to be close to 0.65` |
| `queryKb > respects keywordWeight=1 (pure keyword)` | `expected 1 to be close to 0.9` |
| `queryKb > respects keywordWeight=0 (pure semantic)` | `expected 1 to be close to 0.7` |
| `queryKb > applies minScore filter` | `expected [ Array(1) ] to have a length of +0 but got 1` |
| `queryKb > uses cluster routing when populated and ≥50 chunks` | `expected null not to be null` |

All five expect raw blended scores. `queryKb` min-max normalises the semantic
and keyword columns across the candidate set before blending (changelog 4.7.0),
so a single-candidate mock normalises to 1 and every arithmetic expectation in
that file is stale.

`lib/kb/ingest.test.ts` — the suite fails to collect, so it reports 0 tests:

```
Error: [vitest] No "KB_KEYWORDS_EXTRACT_JOB_NAME" export is defined on the
"@/lib/kb/keywords" mock. Did you forget to return it from "vi.mock"?
  ❯ lib/kb/jobs/keywords-extract.ts:31:39
  ❯ lib/kb/ingest.ts:35:1
```

The file's `@/lib/kb/keywords` mock predates the barrel gaining
`KB_KEYWORDS_EXTRACT_JOB_NAME`.
