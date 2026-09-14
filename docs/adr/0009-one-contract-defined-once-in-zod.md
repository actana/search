# One contract, defined once in zod, served and consumed

Every request body, response body, error body and event payload on Search's
`/v1` surface is a zod schema in **`packages/sdk/src/contracts/`**, exported as
`@actana/search/contracts`. The core validates incoming requests with those
exact objects; the SDK's method signatures are `z.infer`red from them. There is
one definition of a request, and it lives in the package a consumer already
installs.

Four things fall out of that, and each of them is a decision this ADR is also
recording: the SDK owns the schemas rather than the service; the hybrid and the
v1 tag+vector retrieval paths are one route with a `mode`, not two routes; a
knowledge base belonging to another paired client answers `404` and not `403`;
and events go out over both a webhook and an SSE stream because those are two
different problems.

## Context

The REST surface is the boundary Studio will call across for every knowledge
base read and write (plan Part 3), and behaviour on both sides of it is frozen
(ADR 0005). Two properties therefore matter more than they usually would.

**The two halves must not be able to drift.** A hand-written client against a
hand-written server is two descriptions of one protocol, and the second one to
be edited is wrong for as long as nobody notices. The failure is quiet: a field
a route stopped reading, a nullable one a client stopped expecting.

**Studio must be able to hand the body back.** A Studio wrapper's job is to
return what it returns today (`getKnowledgeBaseById`, `queryKb`, `getDocuments`
…). If the wire's field names are the service functions' field names, the
wrapper passes the body along; if they are new ones, the wrapper is a mapping
layer that is itself a place for behaviour to change.

## Considered Options

- **Schemas in the core, types copied into the SDK (rejected).** The obvious
  shape, and it makes the SDK a second description. It also makes the SDK depend
  on the core, or on a generator run nobody remembers to re-run.
- **OpenAPI as the source, both sides generated (rejected).** It buys a
  document, and it costs a build step, a generator's opinion about every
  nullable field, and a spec that is edited in YAML rather than in the language
  the validation is written in. `docs/external-api.md` gets the document without
  the pipeline.
- **No shared schemas; validate ad hoc (rejected).** What the first draft of
  most services does. It is how `detail` on a validation error ends up being a
  string.
- **Two routes for the two retrieval paths (rejected).** `POST /kbs/:id/query`
  and `POST /kbs/:id/tag-query` reads cleanly until you notice both take the
  same text, the same `topK`, the same KB, and differ in which frozen function
  runs. Two routes is two places to add a parameter to.

## Decisions

**D1 — The contracts live in the SDK package, and the core imports them.**
`@actana/search/contracts` is a peer of `@actana/search/client`. The dependency
arrow points from the core to the SDK, which looks backwards and is not: the SDK
is the published artefact, the wire is its public surface, and a consumer that
installs it gets the schemas to validate against without installing a service.
`packages/search` depends on `@actana/search` already (for the pairing wire).

**D2 — The core validates with the schema; it does not re-describe the body.**
Every route's first statement is `parseWith(SomeRequestSchema, await
readJsonBody(req))`. A field the contract does not name cannot reach a handler,
so "the SDK can send it" and "the route accepts it" are the same sentence.

**D3 — Field names on the wire are the lifted service functions' field names.**
`userId` is `owner_id`, `workspaceId` is `paired_client_id`, `chunkingConfig`
carries both `maxSize` and `chunkSize` because the two ingest paths read
different keys. All three are ugly seen fresh, and all three are what Studio
returns today (ADR 0005). Renaming them would move the cost from this repo to
every caller of Studio's.

**D4 — One query route, with `mode`.** `mode: 'hybrid'` (the default) is
`handleKbQuery`: closed-set query-keyword selection from the KB's own
vocabulary, then the blended keyword+semantic rank over the KB's partition.
`mode: 'v1-tags'` is the pre-v2 path over the shared `embedding` table: the tag
filter first, then a vector search restricted to what survives. The response is
a discriminated union on the same `mode`, so a caller that asked for one cannot
mistake the other's rows for it.

Both are served and neither is a reimplementation of the other — that is ADR
0005, and it is why the route cannot just pick. What the route must not do is
*decide*: the mode is the caller's, and the two engines are called unmodified.

**D4a — `queryKeywords` picks between the two frozen v2 entry points.** Omitted,
the instance selects the query's keywords from the KB's vocabulary first
(`handleKbQuery`). Present, the caller's list is used verbatim — and `[]`
collapses the blend to pure semantic similarity, whatever `keywordWeight` says
(`queryKb`). Both rankings are frozen and the fixture suite asserts both, so the
wire has to be able to name which one it means. It is not a tuning knob: the
same request with and without it returns materially different documents.

**D5 — A row belonging to another paired client is `404`, not `403`.** A `403`
on somebody else's knowledge base confirms that the id names something, which
makes the id space worth walking. A `404` says the same thing to a caller with a
right to know — *there is no such KB for you* — and nothing at all to a caller
without one.

The router's own `403 kb-forbidden` is deliberately different and stays. There
the pairing named an explicit allow-list of KB ids at redemption time, so the
refusal tells the caller only what the operator already told them. The rule is
therefore: **enumeration is refused with a 404; a stated restriction is refused
with a 403.**

**D6 — The error body is `{ code, message, detail? }` with a closed `code`
enum.** A caller switches on `code`; `message` is for a human reading a log and
must not be parsed. `detail` is structured and route-specific — zod's own issue
list for a `validation-failed`, an error id for a `core-error`. A closed enum
means an instance cannot invent a reason a caller has no branch for, and it is
the same enum `SearchApiError.code` is documented against.

`error` is written beside `message` with the same string. The pre-auth pairing
surface has spelled it that way since it was copied out of Control (ADR 0008),
and a client written against that spelling still works.

**D7 — A `500` carries an error id and no stack.** A stack is an internal map of
the process. The id is in the log line beside the real error, which is what an
operator greps.

**D8 — Events go out twice over, and both are load-bearing.** One payload
(`document.ingested`, `document.failed`, `clusters.retrained`), two transports.
A **webhook** is a signed, retried POST to a URL the client registered, with a
`webhook_delivery` row per event: it survives the client being disconnected, and
it is what a server-side integration — Studio's trigger — needs. **SSE** on
`GET /v1/events` is the same payload pushed down an open connection: it is live,
needs no publicly reachable URL, and is what a UI needs. Neither substitutes for
the other, so the service offers both and a client may register both, one, or
neither.

**D8a — Event ids are derived from what happened, not from when it was
noticed.** `id` is a digest of the event name and the facts (the document and
its terminal state; the KB and its fit timestamp). Two workers that both notice
the same document finished therefore produce the *same* event, and the delivery
ledger's `(webhook, event)` unique index turns the second into a no-op rather
than a duplicate POST.

**D8b — The signature is over the raw body.** `x-search-signature:
sha256=<hex>`, an HMAC-SHA256 over the exact bytes sent, keyed by the webhook's
secret. Not over a re-serialisation: two JSON encoders do not agree on key order
or whitespace, and a receiver that re-encodes before checking is a receiver whose
check passes on a body it never saw.

**D9 — Events are announced from the job's completion, not from inside the
engine.** The terminal writes — a document reaching `completed` or `failed`, a
fit landing — are in lifted code whose behaviour is frozen and whose value is
being diffable against Studio's. `jobs/run.ts` reads the row the engine just
wrote and publishes from there, which is correct for every path into that state
including ones added later, and which costs the lifted files nothing.

## Consequences

- A new field is one edit: the schema. The route gets it validated and the SDK
  gets it typed.
- `packages/search` cannot be published without `@actana/search`, which is
  already true and is why the SDK's `rehearse:pack` gate exists.
- The route table in `docs/external-api.md` is written from the contracts by
  hand and will drift if nobody looks. It names the schema for every request and
  response so that "did this change?" is answerable by reading one file.
- Studio's wrapper layer (TASK-009) is a mapper for dates and envelopes and
  nothing else — every field it needs is on the wire under the name it already
  uses.
- The `v1-tags` mode keeps the older retrieval path alive on the new surface.
  Retiring it is a separate ADR with its own callers to find, which is exactly
  what ADR 0005 asked for.
