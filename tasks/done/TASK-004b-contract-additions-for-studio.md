# TASK-004b — the contract additions Studio asked for

A follow-on to TASK-004, and deliberately a small one: **ten wire additions, no
engine changes.** Studio's TASK-009 built the strangler seam and then found that
a whole class of request it makes every day could not be *said* on this wire —
so the wrapper took the unwired path, or refused in words, and a wired workspace
was less capable than an unwired one.

Every function behind these additions already accepted these inputs; Studio
passes them today, function-to-function. Nothing under
`packages/search/src/{kb,knowledge}/**` or `src/v1/**` was touched (ADR 0005).
What changed is which of them the wire can reach and what a caller may say.

The requests are Studio's, verbatim, in
`~/Projects/actana.ai/wt-search-extraction` →
`tasks/search-extraction/done/TASK-009-wrapped-service-functions.md`,
"Contract changes requested from Search" (items 1–7) and "Second fix round"
(items 8–11, minus the one it closed itself).

## What was asked for, and why

| # | Addition | Why Studio needed it |
|---|---|---|
| 1 | `QueryRequestSchema.text` optional for `mode: 'v1-tags'` with non-empty `tags` | The tag-only search (`handleTagOnlySearch`) filters by tag and **embeds nothing**. `text: z.string().min(1)` made it unexpressible and `''` a `400`, so the KB browser's tag filter, `kb_search` with `tagFilters` and no query, and the v1 REST route all ran in Studio. |
| 2 | `QueryRequestSchema.distanceThreshold?: number (0–2)`, `v1-tags` only | Studio computes it once per multi-KB call — `0.8` above three KBs, `1.0` otherwise — and asks each KB separately; a per-KB route can only infer `1.0`. A search over four or more KBs stayed in Studio. |
| 3 | `QueryRequestSchema.topK` max 100 | Studio's own public routes accept 100. Clamping returns fewer rows than asked for and fanning out at 50 per KB is a different result set, so `topK > 50` stayed in Studio. |
| 4 | Tag parts on `IngestMultipartFieldsSchema` | `createDocumentRecords` resolves a document's tags *before* dispatch, the SDK's `ingestFormData` already appended every slot — and zod stripped them, so every wired file upload needed a second `documents.update` just to keep them. |
| 5 | `chunkCount?` on `IngestResponseSchema` | `ingestDocument` returns a count and `kb_add_file` surfaces it as a block output; with no field to read, the wrapper reported `0`. |
| 6 | `tagFilters` on `ListDocumentsQuerySchema` | The wire's tag filtering lived only on the query route, so a tag-filtered document listing kept the Drizzle body on **every** workspace. |
| 7 | `kbs.restore` | No method and no route: on a wired workspace a restore brought back everything Studio owns and left the Search-side KB archived. |
| 8 | `POST …/documents/:docId/chunks` | Studio's chunk editor adds a chunk by hand; with nothing on the wire the action refused on a wired workspace. |
| 9 | `GET /v1/kbs/:kbId/chunks/:chunkId` + chunk-addressed keyword attach/detach | Studio addresses a chunk by id alone (`{ knowledgeBaseId, chunkId }`) and had no document id for the document-addressed routes and no chunk-by-id read to recover one from, so the manual keyword overlay refused. This contract's own docstring had promised the chunk-addressed shape all along. |
| 10 | `POST …/documents/bulk` | Studio's two bulk paths became N requests for N documents, and the by-filter form was additionally capped by the listing's `limit` of 500. |

## What was built

Contracts in `packages/sdk/src/contracts/`, the routes that validate with them
in `packages/search/src/api/routes/`, the SDK methods that call them, a row per
route in [`docs/external-api.md`](../../docs/external-api.md), and the decisions
in [ADR 0009](../../docs/adr/0009-one-contract-defined-once-in-zod.md).

| Addition | Contract | Route | SDK |
|---|---|---|---|
| 1, 2, 3 | `contracts/kbs.ts` — `QueryRequestSchema` gains a `superRefine`, `distanceThreshold`, and a `topK` of 100 | `routes/kbs.ts` — `runV1TagQuery` branches to `handleTagOnlySearch` when there is no `text`, and the caller's threshold wins | `kbs.query` (typed from the schema) |
| 4 | `IngestMultipartFieldsSchema` extends `TagWritesSchema` | `routes/documents.ts` — `tagWritesFrom(fields)` reads the *validated* fields | already sent by `ingestFormData` |
| 5 | `IngestResponseSchema.chunkCount` | `settledAnswer(documentId)`, one read, no wait | `kbs.ingest` |
| 6 | `TagFilterConditionSchema`, `ListDocumentsQuerySchema.tagFilters` | handed to `getDocuments` whole | `documents.list` JSON-encodes it |
| 7 | none — the answer is `KnowledgeBaseSchema` | `POST /v1/kbs/:kbId/restore` over `requireKbIncludingArchived` (until now unused) and the lifted `restoreKnowledgeBase` | `kbs.restore` |
| 8 | `CreateChunkRequestSchema` | `POST …/documents/:docId/chunks` over the lifted `createChunk` | `chunks.create` |
| 9 | `AttachChunkKeywordRequestSchema`'s docstring, now true | `GET /v1/kbs/:kbId/chunks/:chunkId`, `PUT\|POST …/keywords`, `DELETE …/keywords/:keywordId`, over a new `requireChunkInKb` | `chunks.get`, `chunks.attachKeyword`, `chunks.detachKeyword` |
| 10 | `BulkDocumentsRequestSchema`, `BulkDocumentsResponseSchema` | `POST …/documents/bulk` over `bulkDocumentOperation` / `bulkDocumentOperationByFilter` | `documents.bulk` |

### The decisions inside the additions

- **`distanceThreshold` with `hybrid` is a `400`, not a no-op.** That path ranks
  by a blended score, whose floor is `minScore`; a threshold accepted and
  dropped looks exactly like one that was applied. Both cross-field rules live
  in one `superRefine`, so a request that is wrong twice is told both times.
- **`strategy.distanceThreshold` reports the threshold that *ran*.** A caller
  comparing what it asked for against what it is told should not have to know
  which of the two the field means.
- **`tagFilters` is one JSON-encoded parameter, not `tag1=…&tag2=…`.** Studio's
  filter is a list of conditions — an operator each, a second bound for
  `between`, several allowed on one slot — and a flat parameter round-trips the
  easy ones and silently loses the rest. `tagSlot` is the closed seventeen-slot
  enum rather than the lifted signature's bare `string`, because the engine
  *drops* a condition whose slot it does not recognise, which would answer a
  filtered listing with an unfiltered one.
- **`chunkCount` is absent, never `0`, until the row carries one.** "Not known
  yet" and "no chunks" are different claims, and the `202` does not wait for a
  chunker. In practice it is present on the idempotent re-ingest of an id and on
  an ingest whose work had already landed.
- **`kbs.restore` answers with the knowledge base.** The lifted restore
  un-archives under `generateRestoreName`, so a KB whose name was taken while it
  was archived comes back as `…_restored`; a caller that cannot read the name it
  got is a caller whose next `PATCH` names a KB that is not there. Not archived
  is `409 conflict`, following the `include`-with-no-bytes precedent.
- **Bulk: the route adds a check the frozen function does not make.**
  `bulkDocumentOperation` acts on the ids it recognises and logs the rest —
  right for a transaction, wrong for a socket. So every id is proved to be in
  the KB first and the whole call is refused with a `404` that names **none** of
  them (ADR 0009 D5). Its two forms are the service's two: a list of ids, or an
  `enabledFilter`. Not `{ filter: { enabled?, tags?, processingStatus? } }` as
  the ticket sketched — `bulkDocumentOperationByFilter` reads `enabled` and no
  other column, and the other two would have been the wire inventing engine
  behaviour (ADR 0005). Filter by tag with `?tagFilters=` and pass the ids.
- **The chunk-addressed attach takes `PUT` and `POST`.** The contract's
  docstring and the document-addressed route say `PUT`, the request asked for
  `POST`, and the operation is idempotent (create-or-return on the
  `(chunk, keyword)` pair) so both verbs are unambiguous. One handler behind
  both; the `DELETE` is a `DELETE` either way.
- **A second SDK namespace, `chunks`, rather than more `documents.*` methods.**
  These take `(kbId, chunkId)`; the document-addressed ones keep taking a
  document. Two addressings, each on the namespace whose arguments a caller
  actually holds, instead of one method whose third argument means two things.

## Two things a reader should know before using the chunk routes

Neither is new and neither was introduced here; both surfaced while testing and
are now written down on the routes, in `docs/external-api.md` and in ADR 0009's
consequences.

1. **The chunk routes are v1 code over the shared `embedding` table**, and the
   `hybrid` rank reads the KB's own partition (`kbPartitionRef`). The file
   pipeline writes both; `ingestDocument` (the `text` encoding) writes only the
   partition. So a text-ingested document has **no chunks** on the chunk routes,
   and a chunk added by hand is found by `mode: 'v1-tags'` and not by `hybrid`.
   That is Studio's behaviour unchanged — its chunk editor works over uploaded
   files — and a route that reconciled the two would be new retrieval behaviour.
   The tests for additions 8 and 9 use file-ingested documents for this reason.
2. **`ListDocumentsResponseSchema.pagination.total` arrives as a string**, on
   every listing, filtered or not: the lifted `getDocuments` hands back
   `COUNT(*)` as Postgres sent it and the route passes `pagination` through.
   `PaginationSchema.total` is `z.number().int()`, so the response does not
   satisfy its own contract. **Not fixed here** — it is a pre-existing mismatch
   on a field this task did not touch, and coercing it changes an existing
   response's type, which belongs in its own change with its own note. The one
   test that reads it wraps it in `Number(…)` and says why.

## Tests

`packages/sdk/src/__tests__/contracts.test.ts` — **new**, 25 tests. The
schemas as validators, which under ADR 0009 D2 is what the surface accepts: when
`text` may be left out and when it may not (both refusals reported at once),
`distanceThreshold` accepted for `v1-tags` and refused for `hybrid` and for no
mode at all, its `[0, 2]` bounds, `topK` 100 in and 101 out, the flattened tag
parts, `chunkCount` optional and non-negative, `tagFilters` decoded from JSON
and refused as a slot the engine would drop or a number where it parses a
string, the bulk request's exactly-one rule and its 500 cap, and
`CreateChunkRequestSchema` stripping what the engine decides.

`packages/sdk/src/__tests__/client.test.ts` — +3 tests, and five rows in the route table. `kbs.restore`,
`documents.bulk` and the three `chunks` methods in the route table; the restore
answering with the record; `tagFilters` encoded once and absent when absent; and
a chunk addressed by id alone with the same body the document-addressed form
takes.

`packages/search/src/__tests__/fixture-suite.rest.test.ts` — +13, over the real
server, the real SDK and the real database. Each one is the *request* Studio
makes rather than a field's presence:

| Test | What it proves |
|---|---|
| runs a tag-only v1 search, and embeds nothing at all to do it | `usage.embed` is zero and every `distance` is `0` — a route that quietly embedded the tag values or `''` would show both; and the tag+vector result over the same filters is a subset of the tag-only set |
| keeps `text` required everywhere a query still embeds | five bodies, five `400`s |
| applies the `distanceThreshold` the caller stated, and reports that one back | `0.000001` empties a result set the default fills; `0.8` — Studio's multi-KB value — keeps every row inside it |
| refuses a `distanceThreshold` on the hybrid path | with and without an explicit `mode` |
| accepts a `topK` of 100 | and 101 is still a `400`, so the ceiling moved rather than went away |
| stages the tag parts of a multipart ingest, exactly as the JSON body's `tags` does | the two encodings' rows compared slot for slot, `date1` included; a part that is not a slot is dropped |
| answers with `chunkCount` as soon as the row carries one, and never waits for it | absent on the first `202`, right on the re-ingest, absent for an upload excluded from the KB |
| filters a document listing by tag, with the operators the engine has | `eq`, `starts_with` + `between` ANDed, a filter that matches nothing answering with nothing, and a dropped-slot or non-JSON parameter refused |
| restores an archived knowledge base, under a free name | archived → invisible → restored with its document back; then archived again with its name taken, and restored as `…_restored` |
| refuses a restore of a foreign KB, an unknown one, and one that is not archived | `404`, `404`, `409`, and the foreign call wrote nothing |
| writes a chunk by hand: embedded, appended, and inheriting its document's tags | next `chunkIndex`, inherited tags, the document's three counters, and the v1 path ranking it — which a row with no vector cannot be |
| reads a chunk by its own id, and hangs a keyword off it the same way | identical to the document-addressed row, `404` for another KB's, attach by `PUT` then `POST` (create-or-return), detach, and the body's exactly-one rule |
| enables, disables and deletes documents in bulk — by id, and by filter | in a KB of its own; one foreign id refuses the whole call, names none of the ids and writes nothing; every contract refusal over the wire |

The fifteen frozen queries (q01–q15) are untouched and green, which is the
evidence that none of this reached the engine.

## Gate

```sh
pnpm typecheck && pnpm lint && node scripts/check-strip-types.mjs \
  && pnpm audit --prod --audit-level high
SEARCH_TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/search_test pnpm test
node packages/sdk/scripts/rehearse-npm-pack.mjs
```

1014 → 1055 passing, no new reds, no dependency added and no version bumped.

## Review fix round (2026-09-15)

The review read the ten additions against the frozen functions behind them and
found eight places where the wire and the engine disagreed. **Six of the eight
were a `500` on a request the contract had just accepted** — which is the worst
shape a seam can take, because the caller is told it did nothing wrong and the
log says this instance failed. Two were a field that reported something that had
not happened. Nothing under `src/{kb,knowledge,v1}/**` was touched here either:
every fix is a bound on the contract, a branch in a route, or a sentence.

| # | Was | Is |
|---|---|---|
| 1 | `distanceThreshold: z.number().min(0)`, and a stated `0` reached `!distanceThreshold` in the frozen guard — "was one given?" — which throws a plain `Error`: **`500`** | `.gt(0).max(2)`, a `400` on the field |
| 2 | `text` with no `tags` called `handleTagAndVectorSearch` with `structuredFilters: []` and hit its "Tag filters are required…" guard: **`500` on Studio's ordinary wired v1 search** | the third v1 engine, `handleVectorOnlySearch`, with the same vector, threshold and `topK` |
| 3 | `TagFilterConditionSchema.operator` was `z.string().min(1)`: an operator the engine cannot build was **dropped**, and a *filtered* listing was answered with the *unfiltered* one. A slot/`fieldType` mismatch was a Postgres type error: **`500`** | the eleven operators the engine implements, bound to the slot's own type, `between` bound to `valueTo` |
| 4 | `pagination.total` was `COUNT(*)` as Postgres sent it — a **string**, so the listing did not satisfy its own `PaginationSchema` | cast in the route; the test parses the response with the schema instead of wrapping the field in `Number(…)` |
| 5 | the bulk pre-check asked `deleted_at IS NULL` while the engine's own predicate also wants `userExcluded = false AND archived_at IS NULL`, so an id it would skip passed the check and the call answered `200` with a short `affected` — or **`500`** out of "No valid documents found to update" | the engine's predicate, exactly (additive: every id that used to pass and be acted on still passes) |
| 6 | `PATCH …/chunks/:chunkId` re-embeds and had **no mapping** for "no embedding endpoint": `500`, on the one condition a caller can fix, while the new `POST` next to it answered `400` | one helper, both routes, `400` — and the wire's own sentence, naming `PUT /v1/endpoints` rather than the engine's "Set one in the KB settings.", which is Studio's UI telling a person where to click |
| 7 | the tag-only answer echoed `strategy.distanceThreshold` though that path embeds nothing and thresholds nothing | the field is **absent** there, including when the request stated one; the rest of `strategy` is still what ran |
| 8 | the restore mapped the engine's `'Knowledge base not found'` to **`409`** through a shared regex, telling a caller whose KB had just been hard-deleted to go and un-archive it | `'not found'` → `404`, `'not archived'` → `409` — the same two answers the route gives when it is not racing |

### Two notes on the scope

- **Item 3 closes one more hole than the review named.** An operator that is in
  the enum but that the *type's* branch does not implement (`contains` on a
  number, `gt` on a boolean) is dropped by `buildTagFilterCondition` exactly as
  an unknown one is, and so answers a filtered listing with an unfiltered one —
  the same bug, by the same mechanism. `OPERATORS_BY_FIELD_TYPE` is therefore
  read off the four branches of that function and bound too.
- **Item 8 is not separately testable over the wire.** Both mappings are
  reached only by losing a race with a concurrent delete or restore of the same
  KB — outside the race, `requireKbIncludingArchived` and the `deletedAt` check
  above answer `404` and `409` themselves, which the existing test asserts and
  which is unchanged.

### Tests

`contracts.test.ts` — 25 → 30. `distanceThreshold` refused at `0` and accepted
just above it; the operator enum in both directions; `fieldType` bound to the
slot's prefix, with the issue landing on `fieldType`; `valueTo` required for
`between` on both types that have it.

`fixture-suite.rest.test.ts` — +3, and three amended. The new vector-only case
is asserted **row for row against the lifted `handleVectorOnlySearch` called in
process**, with the arguments the route hands it: the frozen fixture corpus has
no vector-only v1 query to compare against (q01–q15 are the two v2 engines and
one tag+vector search), so the in-process call is the oracle — the same kind of
evidence the fixture is, one step closer in. It also proves the two engines are
different by reaching a row the tag filter excludes. Beside it: `0` refused on
both v1 shapes, and the chunk `PATCH`/`POST` pair refused with the wire's
sentence on a KB whose endpoint was taken away. Amended: the tag-only answer's
missing `distanceThreshold`, `pagination.total` parsed by
`ListDocumentsResponseSchema` rather than cast in the test, the ten condition
refusals over the wire beside the combinations that still work, and a bulk id
the engine would skip refused with a `404` and then accepted once the row is
back.

q01–q15 unchanged and green.
