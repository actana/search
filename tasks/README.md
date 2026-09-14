# actana/search — Task Board

The Search-side half of plan 14 (Studio's `tasks/search-extraction/README.md` holds
the ground rules and the full sequence; read it first — the settled decisions there are
binding here). This repo follows **actana/control** for everything structural: pnpm
workspace, Node 24, one package per role, `docs/adr/`, `CONTEXT.md`, `AGENTS.md`,
Conventional Commits, `<type>/<kebab>` branches, `beta/x.y.z` release trains, ADRs
in the same PR as the code.

## Packages (Part 2 layout)

| Package | Name | Role |
|---|---|---|
| `packages/search` | `@actana/search-core` | the core: HTTPS API (mTLS), ingestion workers, migrations, pairing |
| `packages/sdk` | `@actana/search` | typed client + wire schemas (zod). Everything else is built on it |
| `packages/shared` | `@actana/search-shared` | pure code both sides need: chunkers, parsers, ranking math, pairing code |
| `packages/cli` | `@actana/search-cli` (bin `actana-search`) | pair, kb ls, ingest, query |
| `packages/panel` | `@actana/search-panel` | standalone management UI (TASK-016, later) |

## Ground rules

- **The first commit of `packages/search` is a lift, not a rewrite.** Studio's
  `apps/actana/lib/kb/`, the v2 half of `lib/knowledge/`, `lib/chunkers`,
  `lib/file-parsers`, `lib/tokenization`, `lib/models` (embedding + inference dispatch)
  and `app/api/knowledge/search/utils.ts` (v1 tag+vector) move across with their tests.
  Studio-specific imports (`@actana/db`, `@/lib/acl`, `env`, `@actana/logger`,
  `@actana/queue`) are replaced by Search's own equivalents. Ranking must not change.
- **Data:** Search owns schema `search` in Postgres (pgvector), its own BullMQ queue
  (prefix `search`), its own S3-compatible bucket. Standalone it owns all three; wired
  to Studio it receives credentials for the same Postgres/Redis and a bucket of its own.
- **Identity:** `paired_client` (never "tenant"), after Control's per-client
  certificate. Every route is scoped by the mTLS client certificate, never by the URL.
  Scopes `read | write | admin` + optional KB id list.
- **Transport:** Control's mTLS pairing copied in as it is (ADR 0034): CA, per-client
  certificates, short-code pairing session, `POST /v1/pair/redeem` as the single
  pre-auth route, revocation. Source: `~/Projects/opensource/actana-control`.
- **Models both ways:** `ModelEndpointSource` with `LocalEndpointSource` (keys sealed
  with `SEARCH_ENCRYPTION_KEY` in `search.model_endpoint`) and `MirroredEndpointSource`
  (Studio pushes metadata, Search resolves the key per job from Studio's resolver URL,
  short TTL, never stored).
- **Dependencies:** exact pins, release-age gate (`minimumReleaseAge` ≥ 7 days in
  `pnpm-workspace.yaml`), no git deps, no install scripts except an allow-list, frozen
  lockfile. Prefer vanilla code over a dependency.
- **Tooling:** Node 24 (`~/.nvm/versions/node/v24.19.0/bin` on this machine), pnpm.
  `pnpm typecheck`, `pnpm test`, `pnpm lint` must be green before a task is done.
- **Environment (core):** `SEARCH_DATABASE_URL`, `SEARCH_REDIS_URL`, `SEARCH_S3_ENDPOINT`,
  `SEARCH_S3_BUCKET`, `SEARCH_S3_ACCESS_KEY`, `SEARCH_S3_SECRET_KEY`, `SEARCH_S3_REGION`,
  `SEARCH_S3_FORCE_PATH_STYLE`, `SEARCH_ENCRYPTION_KEY`, `SEARCH_PORT` (default 7443),
  `SEARCH_PUBLIC_HOST`, `SEARCH_STATE_DIR` (CA, server cert, pairing material; default
  `~/.actana-search`), `SEARCH_LOG_LEVEL`.
- **Local stack** for tests: Studio's proto compose
  (`~/Projects/actana.ai/wt-search-extraction/tasks/search-extraction/proto/docker-compose.search.yml`)
  — Postgres `postgresql://postgres:postgres@localhost:5432/actanastudio` (use schema
  `search`), Redis `redis://localhost:6379`, MinIO `http://localhost:9000`
  (`minioadmin`/`minioadmin`, bucket `search`). Integration tests gate on
  `SEARCH_TEST_DATABASE_URL`.

## Folders
`todo/`, `in-progress/` (one at a time), `done/` (append **Outcome**).

## Sequence
| # | Task |
|---|---|
| 002 | Repo bootstrap and engine lift |
| 003 | `search` schema and migrations |
| 004 | REST API and zod contracts (+ fixture suite over REST) |
| 005 | Local endpoint source, worker, CLI |
| 006 | `@actana/search` SDK and mTLS pairing copied from Control |
| 016 | Panel (later) |
