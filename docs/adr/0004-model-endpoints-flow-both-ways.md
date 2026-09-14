# Model endpoints flow both ways

Search reaches a model through a `ModelEndpointSource`: one interface, two
implementations, chosen by configuration. Ingest and query code asks for "the
embedding endpoint this KB is bound to" and never learns where the key came
from.

`LocalEndpointSource` reads `search.model_endpoint`, where a key is sealed with
`SEARCH_ENCRYPTION_KEY`. This is how a standalone Search runs, and how the CLI
registers an endpoint with a literal key.

`MirroredEndpointSource` is wired mode. The registry is a **mirror** a paired
client keeps current: on pairing, and whenever an endpoint changes, the client
pushes catalog metadata — provider, template, model, dimensions, a stable
external id. **No key crosses.** When a job needs one, Search asks the client's
resolver URL for that endpoint's key, uses it for the job, and holds it in
memory under a short TTL. The client stays the only place a provider key is
sealed at rest.

This is the one place the integration is deeper than Control's Cores, and it
has to be: Search must run alone with its own keys, and when wired it must use
the endpoints the client already manages — including linked and secret-backed
ones — without becoming a second vault.

## Considered Options

- **Ship the key with each request (rejected).** The obvious shortcut. It
  sprays a client's sealed secrets through Search's logs and memory across
  thousands of chunk jobs, and it makes standalone and wired mode diverge at
  every call site instead of at one seam. A resolver ties a key's lifetime to
  one job.
- **Copy the keys into Search on pairing (rejected).** It makes Search a second
  vault with a second rotation story, and the day a key changes on the client
  side, Search is quietly wrong.
- **Standalone only — the client always registers keys with Search
  (rejected).** It works, and it forces every wired deployment to duplicate and
  re-rotate credentials it already manages, which is how one of the two copies
  ends up stale.
- **Search calls the client for the whole embedding (rejected).** It would keep
  keys entirely on the client side and put the client's HTTP stack in the
  hot path of every batch, which is the coupling the split removes.

## Consequences

- `ModelEndpointSource` is the seam the lifted `provider-context.ts` grew into.
  The engine's call sites are unchanged.
- The SDK exposes the same endpoint shape to both, so `PUT /endpoints` stores
  locally for a standalone user and mirrors for a wired one. One contract, two
  sources, no branching in ingest or query.
- A resolved key is never logged, never returned by a route, and in wired mode
  never written to disk.
- A KB's embedding dimension is fixed by its endpoint at creation: the
  partition's vector column is sized from it. Rebinding a KB to a
  different-dimension endpoint is a re-ingest, not an update.
- An inference endpoint is optional. Without one, keyword extraction records
  `skipped:no-inference-endpoint` rather than failing the document.
