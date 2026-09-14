# actana/search — Domain

The language of this repository. Use these words; do not invent synonyms for
them. If the concept you need is not here, that is a signal — either you are
inventing language the project does not use, or there is a real gap to record.

## Language

### The corpus

**Knowledge Base** (KB)
: The unit of retrieval and the unit of ownership. A KB fixes its embedding
  model and therefore its vector dimension, its chunking configuration, its
  KMeans `k`, and its full-text language. Everything below belongs to exactly
  one KB. Never "index", never "collection", never "namespace".

**Document**
: A file or a piece of text that was ingested into a KB. It carries its
  original bytes in the bucket (`file_url`), its parse and embed state
  (`processing_status`), its keyword state (`keyword_status`), and up to
  seventeen **tag** slots inherited by every chunk it produced.

**Chunk**
: A contiguous span of one Document's text, with its offsets, its token count,
  and its vector. A chunk is what a query returns. "Chunk" in prose; the row is
  in the KB's **Partition**.

**Partition**
: The per-KB table holding that KB's chunks — `search.kb_embedding_<sha>`,
  where the suffix is the first 12 hex characters of `sha256(kbId)`. It is
  created at runtime by the DDL module, not by a migration, because its vector
  column is sized to the KB's model. It carries an HNSW index over the vector,
  a GIN index over the generated `content_tsv`, and indexes on `cluster_id`
  and `kb_id`. Partitions are **not** in the Drizzle schema: adding one there
  would make `drizzle-kit generate` emit a `DROP` for live data.

**Cluster**
: A KMeans cluster over a KB's chunk vectors, with its centroid and size in
  `kb_cluster`. A query resolves the nearest cluster and may widen into its
  `neighborClusters` neighbours rather than scanning the KB. Clusters are
  re-validated as the corpus broadens, which is what moves `kmeans_k`.

**Keyword**
: A term in a KB's curated vocabulary (`kb_keyword`), linked to the chunks and
  documents that carry it. Keywords are extracted by an inference **Endpoint**
  at ingest time and at query time, and can be edited by hand. `keywordWeight`
  on a query is how much of the score they are worth.

**Tag**
: One of the seventeen typed slots on a Document — seven text, five number,
  two date, three boolean — inherited by its chunks so a query can filter on
  them without a join. A KB names its slots in
  `knowledge_base_tag_definitions`. This is the v1 filtering path and it is
  unchanged.

### Models

**Endpoint**
: A model a KB is bound to: a provider, a request **template**, a model name,
  a base URL, a dimension for the embedding kind, and a key. A KB has an
  embedding Endpoint (required) and an inference Endpoint (optional — without
  one, keyword extraction is skipped rather than failed).

**Endpoint source**
: Where an Endpoint's key comes from. `LocalEndpointSource` reads rows from
  `search.model_endpoint`, whose keys are sealed with `SEARCH_ENCRYPTION_KEY`.
  `MirroredEndpointSource` holds metadata a paired client pushed and asks that
  client's resolver for the live key per job, keeping it for the life of the
  job and never writing it down. Ingest and query code never knows which it
  has.

**Template**
: The request shape a provider speaks (`openai`, `cohere`, `voyage`, `google`,
  …) as distinct from the provider itself, so an OpenAI-compatible endpoint
  behind someone else's URL is a base URL change rather than a new provider.

### Identity and transport

**Paired client**
: Who is asking. One row in `search.paired_client` per client certificate,
  carrying its scopes and optionally the list of KB ids it may touch. Every KB,
  Document and Endpoint belongs to one. **Never "tenant"** — the name follows
  Control's per-client certificate, and Search deliberately does not know what
  a workspace is.

**Pairing code**
: A short, single-use, expiring code an operator mints on a Search instance and
  reads out, redeemed exactly once at `POST /v1/pair/redeem` — the only route
  that *grants* anything without a client certificate. Eight characters from a
  31-character alphabet with no ambiguous glyphs, five-minute expiry, five
  attempts. It travels beside the **pairing session** id that names it, as one
  ticket (`<sessionId>:<XXXX-XXXX>`), and it is never stored: what the instance
  keeps is a digest keyed by its own secret.

**Pairing session**
: The row a minted code opens (`search.pairing_code`) and a redemption spends.
  It carries the digest, the expiry, the attempt count and the **scope** the
  code grants. A redemption names one session and is answered by that session
  or by nothing — there is no search for a session a code might fit.

**Registration blob**
: What a client assembles from a redemption: the endpoint address, the CA
  certificate, its own certificate — and the private key it generated locally
  and never sent. The client seals it and presents the certificate on every
  later request. The certificate is the identity; nothing in a URL is. The shape
  is Control's `CoreRegistrationBlob`, field for field (ADR 0008).

**Scope**
: `read`, `write` or `admin`, plus an optional list of KB ids. Decided by the
  operator when the **pairing code** is minted, copied onto the **paired
  client** by the redemption, checked in the API layer, and deliberately coarse.
  Nothing a redeeming client sends can influence it.

**Open set**
: The two paths that answer on a connection with no client certificate:
  `POST /v1/pair/redeem`, which grants a certificate and carries every defence
  ADR 0034 names, and `GET /v1/health`, which grants nothing. Enumerated in
  `preauth-gate.test.ts`; a third entry is a change to ADR 0008 D5.

### Work

**Ingest**
: Parse → chunk → plan batches → embed → keyword → finalize. Resumable: the
  written chunks are the anchor, and `document_embed_batch` is the ledger that
  says which ranges are done.

**Embed batch**
: One contiguous chunk-index range of one Document routed to one Endpoint, and
  one row in `document_embed_batch` moving through
  `pending → processing → completed | failed`.

**Query**
: Semantic similarity over the Partition, full-text over the same rows, and the
  KB's Keywords, mixed under the caller's `keywordWeight` and filtered by tags.
  The v1 tag+vector path over the shared `embedding` table is the same engine
  with the keyword half at zero, and it is still served.

**Webhook**
: A URL a paired client asked to be told at: `document.ingested`,
  `document.failed`, `clusters.retrained`. Search does not know what the other
  end does with it.

## Rules

1. **Behaviour is frozen.** The engine was lifted out of Studio so that every
   existing caller ranks exactly as it did. Ranking, chunking, clustering and
   keyword logic change only in a pull request that is about changing them, with
   an ADR and fixture evidence.
2. **Search owns `search`, and nothing else.** It creates no table outside its
   schema and references none.
3. **The certificate is the identity.** Never read a client id from a URL, a
   body or a header.
4. **The SDK is the only way in.** No consumer reads a table.
5. **Search does not know what a workspace, an agent, a crew or a workflow
   is.** Where the lifted code did, the branch was cut and marked `// lifted:`.
6. **A provider key is never logged, never returned by a route, and in wired
   mode never stored.**
