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
> schema, the migrator, the lifted engine and the mTLS pairing below are in.
> `pnpm dev` migrates, mints this instance's identity, and serves `/v1/health`,
> `/v1/pair/redeem`, `/v1/pair/status` and `/v1/capabilities`. The rest of the
> REST surface lands in **TASK-004** and the worker and the CLI in **TASK-005**.
> `SEARCH_ENCRYPTION_KEY` is required rather than generated, and nothing
> generates one for you.

### How a client connects

On first start Search mints its identity into `SEARCH_STATE_DIR` (default
`~/.actana-search`) and logs the CA fingerprint. Pairing a client takes two
commands: mint a code on the instance, redeem it on the client.

```bash
# On the machine that is the instance. The admin surface listens on a unix
# socket under SEARCH_STATE_DIR at mode 0600 — the filesystem is what guards it.
curl -s --unix-socket ~/.actana-search/admin.sock \
  http://admin/admin/pair/new \
  -H 'content-type: application/json' \
  -d '{"label":"actanastudio","scope":"admin"}'
# → { "ticket": "ps_7c1f:QK4M-9TRW", "caFingerprint": "3B:AF:…", "endpoint": … }
```

```ts
// On the client. The key pair is generated here; only a CSR crosses the wire.
import { pairWithSearch } from "@actana/search/pairing";
import { SearchClient } from "@actana/search/client";

const blob = await pairWithSearch({
  address: "search.internal:7443",
  code: "ps_7c1f:QK4M-9TRW",
  expectedCaFingerprint: "3B:AF:…",
  client: { label: "actanastudio", platform: process.platform },
});
const search = SearchClient.fromRegistrationBlob(blob); // seal `blob`; it is the credential
```

The code is single-use, expires in five minutes (`ttlMs` on the mint raises
that, to at most 24 hours), and dies after five wrong guesses. The fingerprint
is compared **before** the code is sent, on a connection that trusts nothing — a caller with no fingerprint is not a caller
with a waived one. Every later request carries the issued certificate, **and the
certificate is the identity**: no route is scoped by anything in the URL.

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
| [0008](docs/adr/0008-the-pairing-code-is-copied-from-control.md) | The pairing code is copied from Control, and will be lifted into a package |

## Moving data out of Studio

Search's tables keep Studio's columns so the phase-4 data migration is as small
as it can be — but it is not one statement, and
[`docs/migration-from-studio.md`](docs/migration-from-studio.md) is the
statement-by-statement list: the foreign keys that point at tables staying
behind, the column and index renames, the knowledge bases with no workspace that
have to be decided about, and why the endpoint registry is mirrored rather than
moved.

## Security & privacy

- Exactly one route grants anything without a client certificate:
  `POST /v1/pair/redeem`, and it is treated as a security boundary — single-use
  codes, a five-minute expiry, capped attempts, per-caller and global rate
  limits, and the code consumed before the certificate is signed. `GET
  /v1/health` also answers without one and grants nothing; those two are the
  whole open set, enumerated in `preauth-gate.test.ts`. Everything else is
  behind mutual TLS, re-checked per request rather than only at the handshake.
- Revocation is by certificate serial, swept every second, and **fails closed**:
  an instance that cannot read `search.paired_client` refuses every paired
  client rather than serving one an operator has taken back.
- The pairing mechanism is Control's, copied rather than reimplemented — see
  [ADR 0008](docs/adr/0008-the-pairing-code-is-copied-from-control.md) for what
  must stay wire-identical while the copy exists.
- The admin surface that mints codes and revokes clients listens on a **unix
  socket** at `$SEARCH_STATE_DIR/admin.sock`, mode 0600: it has no
  authentication of its own, so reaching it is the credential and the filesystem
  is what decides who can. `SEARCH_ADMIN_PORT` adds a loopback TCP port beside
  it for a platform with no unix sockets — every process on the host can then
  reach it, so it is off by default; when set it refuses any request carrying an
  `Origin` and anything but `content-type: application/json`.
- The server certificate is re-signed against the same CA when it is within 30
  days of expiry, so an instance that is never redeployed does not one day fail
  every handshake at once. The CA survives, so nothing paired re-pairs.
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
