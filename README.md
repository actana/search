# actana/search

**The Actana Knowledge Base, as its own service.**

Search ingests documents, chunks them, embeds them, extracts keywords from
them, clusters them, and answers hybrid (vector + full-text + keyword) queries
over them. It runs standalone with its own provider keys, or wired to an
Actana Studio workspace that pushes its model endpoints across.

The engine is not new. It is the same code that has been running inside Studio
— the same chunkers, the same ranking, the same clustering and keyword
extraction — lifted out so that it can be deployed, scaled, upgraded and used
on its own. **Nothing was retired in the split**: every id, name, signature and
score a caller could observe is the same.

> Search follows [**actana/control**](https://github.com/actana/control) for
> everything structural — pnpm workspace, Node 24, one package per role, ADRs
> at the root, Conventional Commits, `beta/x.y.z` release trains — and for the
> transport: the mTLS pairing is Control's, reused rather than reinvented. A
> contributor moving between the two repos relearns nothing.

## Quickstart

```bash
# Node 24 is required.
nvm use 24
pnpm install --frozen-lockfile

# Bring up Postgres (with pgvector), Redis and an S3-compatible bucket.
docker compose -f deploy/docker-compose.yml up -d --wait

export SEARCH_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/search
export SEARCH_REDIS_URL=redis://localhost:6379
export SEARCH_ENCRYPTION_KEY=$(openssl rand -hex 32)

pnpm db:migrate     # migrations are also applied at boot
pnpm dev
```

> **Where this is up to.** `pnpm db:migrate` and `pnpm dev` work today: the
> schema, the migrator and the lifted engine are in. There is no listener yet —
> `pnpm dev` applies the migrations and says so. The routes land in **TASK-004**,
> the worker and the CLI in **TASK-005**, and the pairing handshake described
> below in **TASK-006**. `SEARCH_ENCRYPTION_KEY` is required rather than
> generated, and nothing generates one for you.

### How a client will connect (TASK-006)

Search prints a one-time pairing code and its CA fingerprint on first start.
A client — Studio's Settings → Search, or `actana-search pair` — redeems the
code once and receives a registration blob holding the endpoint, the CA
certificate and its own client certificate. Every later request carries that
certificate, **and the certificate is the identity**: no route is scoped by
anything in the URL.

## Layout

| Package | Name | Role |
|---|---|---|
| `packages/search` | `@actana/search-core` | the core: HTTPS API (mTLS), ingestion workers, migrations, pairing |
| `packages/sdk` | `@actana/search` | the typed client and the zod wire schemas. Everything else is built on it |
| `packages/shared` | `@actana/search-shared` | pure code both sides need: chunkers, parsers, tokenization, ranking math |
| `packages/cli` | `@actana/search-cli` | `actana-search`: `pair`, `kb ls`, `ingest`, `query` |
| `packages/panel` | `@actana/search-panel` | the standalone management UI (TASK-016) |

```
actana-search
├── packages/       the five above
├── deploy/         Dockerfile, compose fragment, healthcheck
├── docs/adr/       the decisions, starting with the six that shaped the split
├── CONTEXT.md      the domain language (KB, Document, Chunk, Partition, Cluster, Keyword, Endpoint)
├── AGENTS.md       the entry point for an agent working in this repo
└── tasks/          the task board
```

## How it works

A **Knowledge Base** owns **Documents**. Ingesting a document parses it,
chunks it, and writes the chunks into a **Partition** — a per-KB table
(`search.kb_embedding_<sha>`) carrying the vector column sized to that KB's
embedding model, an HNSW index over it, and a generated `tsvector` beside it.
Chunks are embedded in resumable batches against the KB's embedding
**Endpoint**, keyworded against its inference Endpoint, and periodically
**Clustered** so that a query can widen into neighbouring clusters instead of
scanning the whole corpus.

A query is hybrid: semantic similarity over the partition, full-text over the
same rows, and the KB's curated **Keyword** vocabulary, mixed under the
caller's `keywordWeight`. The v1 tag+vector path over the shared `embedding`
table is still there, unchanged, for the callers that use it.

Search owns its data: the `search` schema in Postgres (pgvector), its own
BullMQ queue (prefix `search`), and its own S3-compatible bucket. When it
shares Studio's Postgres it is still a schema Studio never references.

## Architecture decisions

| # | Decision |
|---|---|
| [0001](docs/adr/0001-the-knowledge-base-is-its-own-service.md) | The Knowledge Base is its own service |
| [0002](docs/adr/0002-search-owns-its-data.md) | Search owns its data — the `search` schema |
| [0003](docs/adr/0003-the-paired-client-is-the-identity.md) | The paired client is the identity |
| [0004](docs/adr/0004-model-endpoints-flow-both-ways.md) | Model endpoints flow both ways |
| [0005](docs/adr/0005-behaviour-is-identical-nothing-is-retired.md) | Behaviour is identical; nothing is retired |
| [0006](docs/adr/0006-blob-storage-and-queue-are-searchs-own.md) | Blob storage and the queue are Search's own |
| [0007](docs/adr/0007-the-sheetjs-exception.md) | The SheetJS exception — two advisories acknowledged, not fixed |

## Moving data out of Studio

Search's tables keep Studio's columns so the phase-4 data migration is as small
as it can be — but it is not one statement, and
[`docs/migration-from-studio.md`](docs/migration-from-studio.md) is the
statement-by-statement list: the foreign keys that point at tables staying
behind, the column and index renames, the knowledge bases with no workspace that
have to be decided about, and why the endpoint registry is mirrored rather than
moved.

## Security & privacy

- Exactly one route is reachable without a client certificate:
  `POST /v1/pair/redeem`. Everything else is behind mutual TLS.
- Provider keys are sealed with `SEARCH_ENCRYPTION_KEY` (AES-256-GCM) when
  Search holds them. When Studio holds them, Search never stores one — it
  resolves the key per job and keeps it for the life of that job.
- `SEARCH_STATE_DIR` holds the CA, the server certificate and the pairing
  material. Treat a backup of it as secret material.

See [`SECURITY.md`](SECURITY.md).

## Contributing

[`CONTRIBUTING.md`](CONTRIBUTING.md) — branch naming, Conventional Commits, and
the release-train model. Agents start at [`AGENTS.md`](AGENTS.md).

## License

[MIT](LICENSE).
