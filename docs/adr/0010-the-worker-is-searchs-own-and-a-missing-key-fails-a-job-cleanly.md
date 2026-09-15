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
`SEARCH_QUEUE_PREFIX` (default `search`). The worker does **not** own the
routing table: `jobs/run.ts` maps a job name to a handler, to a per-attempt
wall-clock budget and to the event that follows, and both transports — this
worker and the in-process runner the fixture suites use (`SEARCH_INLINE_JOBS=1`,
which also stops this worker from starting) — go through it. Two tables would be
two spellings of every job name, in a service whose job names are also sitting
in Redis. Studio ran four queues for four
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
`reason` and a `retryable` derived from it. Terminal are the reasons that are a
*decision* rather than weather: `not-configured` (the client declared no
resolver), `not-mirrored` (a pushed row with no external id),
`unknown-endpoint` (the resolver answered 404 — the mirror is stale), `refused`
(the URL is not one this instance may fetch, or it answered with a redirect —
D9), `decrypt-failed` (the sealed resolver credential will not open — D7),
`model-mismatch` (the resolver named another model — D9) and `client-mismatch`
(the row belongs to another paired client — D8). Everything else —
`unauthorized`, `resolver-error`, `timeout`, `unreachable`, `malformed` — is
transient.

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

**A terminal reason is re-thrown as BullMQ's `UnrecoverableError`.** "Whatever
the attempt number" was, for a while, a claim the queue never heard: the failure
handler knew a `404 unknown-endpoint` would say the same thing on the fifth
attempt, marked the document `failed` on the first — and BullMQ, which has never
heard of `retryable`, re-queued the job anyway. Every attempt then ran a whole
ingest against a stale mirror to arrive at the same 404. So the processor
classifies before it re-throws (`isTerminalJobFailure`), and a terminal failure
leaves it as an `UnrecoverableError` carrying the original as its `cause` — the
`cause` because the `reason` on it is the operator's sentence, and discarding it
to satisfy a type would trade the whole point of D3 for a retry.

Two other things are terminal for the same reason and were not typed at all: a
job name this build does not know, and a payload with no knowledge base id.
Both are `NotRunnableJobError`, which is the same decision wearing a different
name.

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

**A minute is the staleness budget, not the revocation budget.** The cache knows
nothing about which declaration produced an entry, so a client that re-declared
its resolver or deleted an endpoint was still served keys fetched under the old
one until the TTL ran out. A minute is not a long time and it is still the wrong
answer to "I have just revoked that": `setEndpointSource`,
`upsertMirroredEndpoints` and `deleteEndpoint` now drop that client's entries
outright, in-flight resolutions included.

And the TTL is not what keeps the map *small*, which is a separate thing that
was missing. An entry nobody reads again is an entry nobody notices has expired,
so an instance whose clients churn `externalId`s — a catalog re-pushed with new
ids — accumulated one live provider key per id for the life of the process, and
a worker process lives for weeks. The sweep runs on insert, which is the only
moment the map grows, drops what has expired, and enforces a hard cap by
evicting the entries closest to expiry.

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

Which makes the key a **boot requirement in both processes**, and it now is:
`index.ts` and `bootWorker` both call `assertEncryptionKeyConfigured()` before
anything else and refuse to start without 64 hex characters. It used to be
checked at the first *use* — the first `PUT /v1/endpoints`, the first job that
needed a mirrored key — so an instance with no key paired, served health, and
reported a cipher error hours later to whoever happened to be adding an
endpoint. The check is hex-shaped rather than merely 64 characters long, because
`Buffer.from(key, 'hex')` stops at the first character that is not hex and hands
back a short key without complaining.

**And the envelope carries no key version, so rotation means re-sealing.** The
ciphertext is `iv:ciphertext:authTag`, all hex, byte for byte Studio's format —
because the phase-4 data move copies sealed endpoint keys across and a different
envelope would make every one of them unreadable
(`core/security/encryption.ts`). There is no room in it for a key id, which is
the cost of that compatibility, and it is named here rather than mitigated:
changing `SEARCH_ENCRYPTION_KEY` re-seals nothing, so every
`model_endpoint.key_ciphertext` and every
`paired_client.endpoint_source.resolverKeyCiphertext` sealed under the old key
stops opening. A rotation is therefore a migration — decrypt with the old key,
encrypt with the new, in one transaction — and not a variable change. Without
one, what an operator gets is `decrypt-failed`, which is a *terminal* reason
(D3, D4) precisely so that they are told once per job instead of five times.

**D8 — The endpoint source is chosen per row, not per process.** There is no
"wired mode" flag. `model_endpoint` carries both `paired_client_id` and `source`,
so an endpoint id is enough to decide which source resolves it
(`routing-endpoint-source.ts`), and one instance serves a standalone client and a
wired one at the same time. The engine's call sites — which have an endpoint id
and no notion of a client — are unchanged, which is what ADR 0004's seam was for.

The corollary is that an endpoint row is selected by `id` **alone**, which is
also the one thing that could serve one client another client's key. The route
is the primary check — a caller may only name a KB its certificate owns
(ADR 0003) — and the source layer is the second: when a binding carries a paired
client id, a row belonging to anyone else is refused with `client-mismatch`,
terminally. The id is optional on the binding because the engine's lifted call
sites do not have one, and inventing a client there would be guessing rather
than checking.

**D9 — The resolver is dialled through the SSRF guard, and believed only about
the key.** The resolver URL is the one URL in this service that a *client*
chooses and Search dials, with an internal credential in a header — so it goes
through `core/security/url-guard.ts` (`validateExternalUrl` at declaration,
`secureFetch` at the call) and not through `fetch`. Three reasons, and none of
them is theoretical:

* `fetch` defaults to `redirect: 'follow'`, and Node follows a `307` to another
  host carrying the `x-api-key` header and the POST body with it. That is the
  credential handed to whoever controls the redirect. `maxRedirects: 0`: a
  resolver that redirects is misconfigured, not a hop.
* `http(s)` was the whole of the declaration check, which accepted
  `http://169.254.169.254/latest/…` and `http://10.0.0.5/` — the instance's own
  metadata service and the operator's internal network, reachable from inside
  the deployment and from nowhere else. Refused at declaration now, which makes
  it a `400` to the client that asked rather than a failed job three days later.
* The answer was `await response.json()` with no cap. A resolver that answers
  `200` and then streams was a held worker slot and a growing heap;
  `maxResponseBytes` is 8 KB, and a resolution is a few hundred bytes.

A refused URL is `refused` — terminal, because the next attempt is refused for
the same reason. `SEARCH_ALLOW_LOCAL_FETCH=1` is the guard's own switch and
re-admits loopback for a single-machine deployment and for the fixture suites;
it is off unless set.

And the answer's `model`, `provider` and `baseUrl` are now checked against the
mirror row rather than preferred over it. `resolved.model ?? row.model` is a
plausible line that quietly changes what a corpus *means*: a KB's partition is a
table with a vector column sized to the dimension the client declared when it
pushed the row, so a resolver answering with a different model embeds the next
chunks into a different space in the same table, at a width that may well fit.
Nothing downstream can notice. For an embedding endpoint a disagreement about the
model or the provider is therefore `model-mismatch` and terminal; a disagreement
about the base URL is a warning and the row's value, because moving a deployment
behind a new URL is a thing clients legitimately do and it does not move the
embedding space on its own. An inference endpoint has no partition to corrupt
and only warns.

**D10 — One image, two roles, and the probe knows which.** The split deployment
(D2) runs the *same image* a second time with `command: [… worker.ts]` and
`ports: []`, and the image carries a single Docker `HEALTHCHECK`, which probed
`GET /v1/health`. A worker container serves nothing, so it was permanently
unhealthy while working perfectly: `--wait` never returns, a
`depends_on: service_healthy` never fires, and an orchestrator restarts a
healthy worker in a loop.

`healthcheck: { disable: true }` on the worker service would have been one line,
and it buys a container with no liveness signal at all. And the probe was not *there*: the image copied `packages/` and `scripts/` and
never `deploy/`, so `HEALTHCHECK CMD node /app/deploy/healthcheck.mjs` failed
with "Cannot find module" on every container this image has produced — both
roles, not just the worker. `COPY deploy/healthcheck.mjs deploy/` fixes it, and
only that file: `Dockerfile`, `docker-compose.yml` and the deploy README are
what *builds and runs* the image rather than what runs inside it.

Instead of disabling the check, `SEARCH_ROLE=worker` switches
`deploy/healthcheck.mjs` to `PING` the Redis the worker dials — hand-rolled RESP over a socket, because the probe must not depend
on anything a `--prod` install could leave out. Queue *depth* is deliberately
not part of it: a backlog is a capacity problem and restarting the container is
the wrong answer to it.

## Consequences

A client's outage is a delay and a warning line. A client's *mistake* — an
endpoint it deleted and did not un-push — is a failed document with a reason
that names it. Those are different sentences and the operator gets the right
one.

A `SIGTERM` is a handover rather than a kill, and in the combined process that
now includes the listeners: the worker drains first — a job in flight still
needs the database and the queue — then the API closes, then the admin listener,
which unlinks its socket. Draining the worker and calling `process.exit(0)` used
to leave both open, so an in-flight request was cut mid-response and
`$SEARCH_STATE_DIR/admin.sock` survived for the next boot to trip over.

The costs are named rather than mitigated. **The retry window is finite**: a
resolver down for longer than five attempts of exponential backoff will fail
documents, and the honest fix for a planned client outage is not to ingest
during it. **`unauthorized` being transient means a genuinely revoked credential
burns a job's attempts before it reports**, which is the trade D3 makes on
purpose. And **a resolver that answers slowly is a worker slot held**: the
resolver call has a ten-second budget inside a five-minute job lock, so a
pathological client can reduce throughput without failing anything, which will
look like Search being slow.

**Where the events come from, now that both halves exist.** This branch carried
its own `events.ts` — a listener list and a `for` loop — because the worker had
to be able to say `document.ingested` before there was anything listening. ADR
0009 D8/D9 is the answer that survived: one payload, two transports
(`events/publish.ts` over `events/emitter.ts` and the webhook ledger), and the
announcement made from the **job's completion** in `jobs/run.ts` rather than
from inside the frozen engine. `events.ts` is gone and the worker publishes
through that one door.

Which leaves one thing this ADR has to decide, because it is where the two
designs actually met. Announcing from the job's completion means reading the row
the engine just wrote — and the engine writes `failed` the moment *an attempt*
gives up, which under D4 is routinely a resolver that will answer on the next
one. Published as-is, every rolling restart on a wired client would raise
`document.failed` on that client's own stream, and Studio's trigger would act on
it. So **a `document.failed` is announced only from the terminal attempt**: the
worker tells `runSearchJob` how many attempts BullMQ has left and the
announcement is held back while that is above zero (a success is announced
whatever the number). The event that a *terminal* reason produces — where the
engine never got as far as the row — comes from the failure handler instead,
with the typed `reason` on it, and both paths derive the event id from the same
facts and claim it from the same set, so a document that fails is one event and
not two.

The cost is named rather than hidden: a document is `failed` in the database
before it is `failed` on the wire, so a client polling `GET
/v1/kbs/:id/documents/:docId` can see a state the stream has not mentioned. That
is the right way round — the row is the truth and the event is the notification
— and the alternative is a notification that is wrong four times out of five.
