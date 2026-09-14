# The worker is Search's own, and a missing key fails a job cleanly

Search runs its own BullMQ worker on its own queue, and the one failure mode
that is structurally new in this service — *the provider key for this job is
somewhere else and cannot be fetched right now* — is a typed error that retries
with backoff and never a document marked `failed`.

[ADR 0006](0006-blob-storage-and-queue-are-searchs-own.md) settled the first
half: the thing that owns the work owns the queue it recovers through. This
records the second half, which the first half makes necessary.
[ADR 0004](0004-model-endpoints-flow-both-ways.md) put a network call between a
job and the key it needs; a queue whose jobs can fail for a reason that has
nothing to do with their input needs to be able to say so.

## Context

In Studio, an embedding job's key was a decrypt away. In a wired Search it is an
HTTP request to the paired client's resolver — and that client is a *running
product*, which means it restarts, its load balancer drops connections, and its
internal key gets rotated.

A document is fanned out into one `kb.embed.batch` job per few hundred chunks.
A large corpus ingesting while its client rolls a deploy is therefore hundreds of
jobs that fail for thirty seconds and would work on the next attempt. Two bad
answers are available and both are worse than they look:

* **Treat it like any other error.** Three attempts inside a second, then the
  document is `failed` forever with "fetch failed" in `processing_error`. The
  operator's corpus is half-ingested and the reason is a sentence about a socket.
* **Retry forever.** No document is lost and the queue fills with jobs against a
  resolver that, in the case that actually matters — the client deleted that
  endpoint — is never going to answer. That is the poisoned queue the plan's own
  risk note names.

The distinction the queue needs is not "did it fail" but **"could a later attempt
succeed"**, and only the code that made the call knows.

## Considered Options

- **Share the client's worker (rejected, ADR 0006).** Cheaper to operate and it
  puts Search's retries, concurrency and failure handling under someone else's
  worker configuration. A stuck Search job becomes a stuck client job, and the
  retry policy below would be a request rather than a decision.
- **Resolve every key at ingest and hold it for the document (rejected).** One
  resolver call per document instead of one per minute, and no mid-document
  failure. It also means a provider key living in memory — and, for a resumable
  ingest, across a worker restart, which means *written down* — for as long as a
  large document takes to embed. That is the second vault ADR 0004 refuses.
- **A generic `retryable` flag on every error (rejected).** The same behaviour
  with none of the reasons. `unknown-endpoint` and `resolver-error` are both
  "the resolver said no" and they need opposite answers; a boolean set at the
  throw site is a boolean that gets set wrong once and is never noticed.
- **Let the queue's own `attempts` handle it (rejected).** BullMQ retries
  anything. What it cannot do is tell a document that will never ingest from one
  that will ingest in a minute, so the terminal cases would consume their
  attempts and then report the same thing as the transient ones.

## Decisions

**D1 — One worker, one queue, one prefix.** `search-knowledge`, under
`SEARCH_QUEUE_PREFIX` (default `search`). Studio ran four queues for four
products; Search has one, and the concurrency (20), the lock duration (5
minutes), the stall interval and `maxStalledCount: 2` are the numbers Studio used
for *its* knowledge queue, because these are the same jobs. A stall is tolerated
rather than fatal: every job here is idempotent and resumable, so a job whose
worker died is re-run rather than lost.

The prefix is **settable**, which ADR 0006 did not say. Sharing a *client's*
Redis was already safe at a fixed `search` — that is what the prefix is for. What
a fixed prefix cannot survive is two *Search* instances on one Redis, which is a
test run beside a dev instance, or two branches on one machine. The suites use
their own (`search-test-b`), and that is the only reason the variable exists.

**D2 — The worker is in the API process by default, and splits on one
variable.** `pnpm dev` and the compose service run both, because a container you
cannot hand a document to is not an installation of this product.
`SEARCH_WORKERS=off` on `start:api` beside any number of `start:worker`
processes is the split; they share a Redis and a prefix and nothing else changes.
Both migrate on boot — a split where only the API migrates is a split whose
worker starts first half the time.

**D3 — A key that cannot be resolved is its own error type.**
`EndpointKeyUnavailableError`, thrown by `MirroredEndpointSource`, carrying a
`reason` and a `retryable` derived from it. Three reasons are terminal:
`not-configured` (the client declared no resolver), `not-mirrored` (a pushed row
with no external id) and `unknown-endpoint` (the resolver answered 404 — the
mirror is stale). Everything else — `unauthorized`, `resolver-error`, `timeout`,
`unreachable`, `malformed` — is transient.

`unauthorized` is deliberately on the transient side. A 401 from the resolver is
most often a key that was rotated a moment ago and is about to be pushed, and the
cost of being wrong is a handful of retries and a warning line rather than a
corpus.

**D4 — Retry with backoff; on the last attempt, fail the document and say so.**
Every job carries exponential backoff from one second, so a `kb.embed.batch`'s
five attempts span about half a minute. When attempts are exhausted — or the
reason is terminal, whatever the attempt number — the worker marks the document
`failed` and emits `document.failed`.

The mark is one `UPDATE` narrowed to a non-terminal `processing_status`, so a
document a sibling batch already carried to `completed` is not dragged back, and
the second failing job of one fan-out writes nothing and emits nothing. It is
best-effort: a database that is down is usually *why* the job failed, and a throw
in the failure handler would replace one failure with another.

A transient failure that will retry is logged at **warn**, not error. A wired
client's rolling restart must not read as an incident in Search's logs.

**D5 — The key is resolved per job, and its whole life is a cache entry.**
Sixty seconds, in memory, keyed `(clientId, externalId)`, with concurrent misses
for one key collapsed into one resolver call. Not a column, not a file, not a log
line (ADR 0004; CONTEXT rule 6).

The TTL is the only number here with two forces on it. Shorter and a
forty-batch document is forty resolver round trips inside a second, which makes
the client's HTTP stack part of the hot path — the coupling the split exists to
remove. Longer and a key rotated on the client side keeps working here after it
has stopped working there. A minute is short enough that a rotation is picked up
within one and long enough that the resolver is a control-plane call.

**D6 — Nothing thrown from the resolving path carries a key, and that is
tested.** Two rules, belt and braces: the resolver client never interpolates a
response body into a message — a message names a status, a reason and the
resolver's *origin*, never its URL, because a query string is where somebody who
has not read ADR 0004 would have put a credential — and `scrubSecret` rewrites
`message` and `stack` for anything thrown where a key was in hand. The first rule
is what makes the second a no-op; the second is what makes the first testable
rather than asserted. `mirrored-endpoint-source.test.ts` resolves a live key and
then checks the thrown error's `message`, its `stack` and its own enumerable
properties; `worker.integration.test.ts` checks the same of what BullMQ kept
about a failed job.

**D7 — `SEARCH_ENCRYPTION_KEY` is required in wired mode too.** The resolver
credential rests in `paired_client.endpoint_source` sealed, never plain. It is
not a provider key; it is the credential that *fetches* provider keys, which
makes it the more valuable of the two, and a column a `SELECT *` could print is
not where it goes. This widens ADR 0004's "in wired mode nothing is sealed here":
nothing *of the client's provider keys* is, and this still is.

**D8 — The endpoint source is chosen per row, not per process.** There is no
"wired mode" flag. `model_endpoint` carries both `paired_client_id` and `source`,
so an endpoint id is enough to decide which source resolves it
(`routing-endpoint-source.ts`), and one instance serves a standalone client and a
wired one at the same time. The engine's call sites — which have an endpoint id
and no notion of a client — are unchanged, which is what ADR 0004's seam was for.

## Consequences

A client's outage is a delay and a warning line. A client's *mistake* — an
endpoint it deleted and did not un-push — is a failed document with a reason
that names it. Those are different sentences and the operator gets the right
one.

The costs are named rather than mitigated. **The retry window is finite**: a
resolver down for longer than five attempts of exponential backoff will fail
documents, and the honest fix for a planned client outage is not to ingest
during it. **`unauthorized` being transient means a genuinely revoked credential
burns a job's attempts before it reports**, which is the trade D3 makes on
purpose. And **a resolver that answers slowly is a worker slot held**: the
resolver call has a ten-second budget inside a five-minute job lock, so a
pathological client can reduce throughput without failing anything, which will
look like Search being slow.

`document.ingested`, `document.failed` and `clusters.retrained` are emitted
through a small in-process emitter (`events.ts`) that the webhook delivery and
the SSE stream subscribe to. It is a listener list and a `for` loop — no
ordering, no durability, nothing that would make it look like a bus. Durable
delivery to a client's URL is the webhook ledger's job (ADR 0006).
