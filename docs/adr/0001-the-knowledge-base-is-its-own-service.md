# The Knowledge Base is its own service

The knowledge-base engine — ingestion, chunking, embedding, keyword extraction,
clustering and hybrid retrieval — is extracted from Actana Studio and becomes
**actana/search**, a standalone service with its own repository, its own
deployment, its own database schema, its own queue and its own bucket. Studio
becomes one of its clients, reaching it through a published SDK over the same
mutual-TLS transport Actana Control already uses.

The engine had outgrown the application it lived in. It is the heaviest thing
Studio does — a long-running, resumable, fan-out workload with a vector
database and an HNSW index under it — and it was scaled, deployed, upgraded and
reasoned about as part of a Next.js application that mostly serves a UI. It
also has obvious value on its own: a retrieval service is a product, and it was
locked inside a workspace-shaped application that could never expose it.

Nothing about the split is a rewrite. The first commits of `packages/search`
are a **lift**: the same files, with their tests, with Studio-specific imports
replaced by Search's own equivalents.

## Considered Options

- **Leave it in Studio and scale Studio (rejected).** The cheapest option and
  the one that keeps the status quo. It leaves the heaviest workload sharing a
  deployment unit with the UI, keeps ingest throughput coupled to request
  serving, and keeps the engine unusable by anything that is not Studio.
- **A library, not a service (rejected).** Publish the engine as a package and
  let Studio depend on it. This solves reuse and solves nothing else: the
  database, the queue, the bucket and the workers are still Studio's, so the
  operational half of the problem — the half that motivated this — survives
  intact.
- **A new engine behind a compatible API (rejected).** Tempting while the code
  is being moved anyway. It converts a mechanical, reviewable change into a
  behavioural one: every ranking difference becomes a regression a user can see,
  and there is no way to tell a deliberate improvement from an accident. See
  ADR 0005.

## Consequences

- Search is its own repository, following Control's structure so contributors
  move between them without relearning anything: pnpm workspace, Node 24, one
  package per role, ADRs at the root, Conventional Commits, release trains.
- Studio keeps **only** the pairing record (`workspace_search`). Every KB,
  document and chunk listing is read back from Search.
- Function signatures survive the move on the Studio side — `queryKb`,
  `ingestDocument`, `getKnowledgeBases` and the rest keep their names and return
  shapes, and their bodies become SDK calls.
- The migration is phased: Studio runs its in-process engine for unpaired
  workspaces until the data migration has settled in production. Nothing is
  retired in this split.
- Search gains a surface Studio never had — a CLI, a standalone Panel, and
  clients that are not Studio — and with it the obligation to have a wire
  contract worth publishing.
