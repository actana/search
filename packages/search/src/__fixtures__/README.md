# The behaviour-freeze fixture

**Copied from Studio, byte for byte. Do not edit anything in here.**

```
kb-fixture.json    the whole freeze: corpus, chunking config, embedder spec,
                   the keyword extractor's vocabulary, fifteen queries across
                   four knowledge bases, and their expected top-5
docs/              the 12 source documents, verbatim
README.studio.md   Studio's own README for this fixture, copied unchanged —
                   how it was recorded, what is deliberately not frozen, and
                   the three frozen quirks
```

Source: `actana.ai/tasks/search-extraction/fixtures/` on branch
`search-extraction` (TASK-001). `kb-fixture.json` and every file under `docs/`
are identical to that directory — verified with `diff -r` when they were copied.
This `README.md` is the only file in here that is Search's own.

## Why a copy and not a reference

The two repositories have no shared build, no shared lockfile and no path
between them. A fixture that lived in one and was read from the other would be
a cross-repo dependency in the one place that must not have one: the evidence
that both repos behave the same. Copying it costs a `diff -r` and buys a suite
that runs from a clean clone of either.

## What it is for

ADR 0005 says behaviour is identical and nothing is retired. This is how that
claim is checked rather than asserted: Studio recorded what its engine did, and
`../kb/fixture-suite.integration.test.ts` replays the same corpus and the same
fifteen queries through the **lifted** engine — across all four ingest paths —
and asserts the same ranked results. 24 tests.

The suite runs in-process here. TASK-004 runs the same fixture over the REST
API; a result that differs between the two is a behaviour change, not a
refactor.

## Running it

Needs a Postgres with pgvector, and gates on `SEARCH_TEST_DATABASE_URL` — without
it the whole suite skips.

```sh
docker compose -f deploy/docker-compose.yml up -d --wait postgres
export SEARCH_TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/search_test
pnpm --filter @actana/search-core test
```

Every row the suite creates is prefixed with a fresh run id
(`searchfx-<short id>`) and dropped in `afterAll`, so it re-runs cleanly against
a database that already holds data.

## Re-recording

**Not from here.** The fixture is recorded in Studio, by running the real engine
against it with `KB_FIXTURE_RECORD=1` (see `README.studio.md`). Search replays;
it never records. If an expectation here needs to change, the engine change and
the re-recording both happen on the Studio side first, with an ADR, and the new
fixture is copied across — which is the whole point of the copy being byte for
byte.

## The two deterministic seams

Only the two external calls are replaced, through seams the engine already has:

| Seam | Replacement |
|---|---|
| `models/embedding.ts` → `executeWorkspaceEmbedding` | `@actana/search-shared/testing/hash-ngram-embedder` — token n-gram hashing into 256 dims, L2-normalised. **This file is byte-identical to Studio's** (`apps/actana/lib/kb/testing/hash-ngram-embedder.ts`); it has to be, or the replayed vectors differ and the fixture proves nothing. Selectable at runtime with `SEARCH_TEST_EMBEDDING=hash-ngram`. |
| `models/inference.ts` → `executeWorkspaceInference` | `../kb/testing/deterministic-keywords.ts` — answers the engine's real keyword prompts with the strict JSON a compliant model would return. Also byte-identical to Studio's. |

Everything else — chunking, the partition DDL, the `embedding` and partition
writes, cluster fitting, `queryKb`, `handleKbQuery`, the v1 tag+vector util — is
the production code path.
