# The one engine edit: replacing a document's chunks under a lock

[ADR 0005](0005-behaviour-is-identical-nothing-is-retired.md) says the lifted
engine changes only in a pull request that is *about* changing it, with a record
and fixture evidence. `packages/search/src/kb/ingest.ts` has been changed. This
is the record.

**What changed.** The transaction that writes a document's chunks — the one
`ingestDocument` already opened, minutes after it started chunking and
embedding — now begins with two more statements:

```
SELECT pg_advisory_xact_lock(hashtext($documentId))
DELETE FROM "search"."<partition>" WHERE document_id = $documentId RETURNING id
```

and, when that delete returned rows, one further statement that removes the
`embedding_keyword` links over exactly those chunk ids and decrements the
`kb_keyword.usage_count` those links were counted in. Nothing else in the file
moved. Each statement carries a `// lifted: additive guard, no result change`
comment where it sits, which is how ADR 0005 says an engine cut or addition is
marked.

## Why

`kb.ingest.document` is on a queue whose jobs are re-run
([ADR 0010](0010-the-worker-is-searchs-own-and-a-missing-key-fails-a-job-cleanly.md)
D1: a stall is tolerated rather than fatal, because every job here is idempotent
and resumable). Two ordinary things produce a second run of one ingest: an
attempt whose worker lost its BullMQ lock — a blocked event loop, a killed
container — and was re-queued while the first attempt is still working, and a
crash between the chunk commit and `moveToCompleted`.

The insert those runs arrive at has no `(document_id, chunk_index)` uniqueness
on the partition to fall back on, so the second run **added** a second copy of
every chunk. The document row reported N chunks, the partition held 2N, and
every query over that knowledge base was then answered twice out of the same
text — with the duplicate pair scoring identically, so it occupied two of five
result slots. That is a retrieval fault, arrived at through the queue's normal
recovery behaviour, on a corpus nobody touched.

## Why the job layer could not do it

`jobs/ingest-idempotency.ts` is where the rest of the property lives, and it was
where all of it was meant to live: a `prepare` hook that runs before the frozen
handler. A job layer can only delete *before* the engine, and that is the one
place the delete does not work.

The window is the whole of the problem. `ingestDocument` parses, chunks and
embeds for minutes before it opens the transaction that writes anything. So run
two's pre-engine delete commits while run one is still embedding, and run one's
chunks are written *after* run two has finished looking — 2N again, with the
delete having removed nothing that mattered. Serialising the two runs needs a
lock held across the insert, and the insert is in the engine.

Three alternatives were available and each is worse:

- **A unique index on `(document_id, chunk_index)` with an upsert.** The right
  shape, and it is a migration over every existing partition plus a change to
  the insert statement itself — a larger engine edit than this one, and one
  that changes what the insert *does* rather than what precedes it.
- **A per-document application lock in the job layer, held across the handler.**
  The lock would be correct and it would be held by a process that can be
  killed, which is the failure this exists to survive. `pg_advisory_xact_lock`
  is released by the transaction ending, whatever ends it.
- **Serialising `kb.ingest.document` on the queue.** One document at a time
  across the whole instance, to fix a case that arises on re-runs.

## What is unchanged, and what is cosmetically off

**A single run writes exactly what it wrote before.** A first ingest takes a
lock nothing else wants and deletes nothing: the delete's `RETURNING` is empty,
the keyword statement is skipped entirely, and the rows inserted are the rows
that were inserted before, in the same order, with the same cluster assignments
and the same embeddings. Ranking, chunking, clustering and keyword logic are
untouched. The frozen fixture suite — the fifteen queries q01–q15, in-process
and over the REST API — is the check ADR 0005 asks for, and it passes with the
same top-5 it passed with before.

**One cosmetic residue, deliberately not fixed.** `totalExisting` is counted
before the transaction opens (`SELECT count(*)` over the partition), so on a
*replacement* run it counts rows this transaction then deletes. It feeds
`totalAfter = totalExisting + chunkRows.length`, which sets the
`kb.clusters.validate` threshold (`max(500, 0.2 × totalAfter)`) and the
`sinceLastValidation` compared against it: a re-ingest therefore carries one
document's worth of chunks twice in a number that decides whether a background
*validation* job is enqueued. It cannot change whether a chunk is written or
what a query returns. It could in principle move `useClusters`, which turns on
at 50 existing chunks — an overstated count admits clustering for a
re-ingest that a first ingest of the same rows would have cold-started — but
that requires `kb_cluster` rows to exist already, which means clustering has
already run over the corpus this document is being replaced in, and the count
is only ever overstated, never under.

None of it is new: a re-run counted the same inflated number before this
change, because the first run's chunks were still there. What the delete does is
make the staleness *visible* on the line above it. Moving the count inside the
transaction would be a second engine edit — one that changes an engine decision
rather than guarding a write — so it is recorded here instead, so that the next
reader of that line knows it was seen and left alone on purpose.

## Consequences

- Two runs of one `kb.ingest.document` are serialised on the document id, and
  the one that arrives second replaces the first. N chunks, atomically, however
  many attempts it took.
- `jobs/ingest-idempotency.ts` keeps what only a job layer can know: that the
  work is *already done* and the handler should not run at all, that the payload
  names the knowledge base its document is actually in, and the
  `document_keyword` rollup the chunk transaction does not write. One path per
  table; there is nothing for two paths to disagree about.
- This is the engine's **one** logic edit since the lift. The other two — a
  returned-value addition and an `export` keyword — are not behaviour and are
  named where they appear. A third belongs in a pull request of its own, with
  its own ADR and its own fixture evidence.
- ADR 0010 D1 previously said the property lives in the job layer "immediately
  before the engine runs". That paragraph has been corrected to point here; the
  decision it records — a tolerated stall, because a re-run is safe — is
  unchanged and is what makes this edit necessary.
