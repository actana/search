# TASK-002 — Repo bootstrap and engine lift

## Bootstrap (copy Control's grammar, not its content)
- Root: `package.json` (`actana-search`, private, `packageManager: pnpm@<same as
  Control>`, `engines.node >=24 <25`, scripts `dev`, `build`, `typecheck`, `lint`,
  `test`, `db:generate`, `db:migrate`), `pnpm-workspace.yaml` (`packages/*`,
  `minimumReleaseAge: 10080`, `allowBuilds` allow-list), `.npmrc` (`engine-strict=true`),
  `.nvmrc` (24), `tsconfig.base.json`, `eslint.config.mjs`, `vitest.config.ts`,
  `commitlint.config.mjs`, `.gitmessage`, `.husky/commit-msg`, `.gitignore`,
  `.editorconfig`, `LICENSE` (MIT), `README.md` (what it is, quickstart, the
  Control relationship), `CONTRIBUTING.md` (branch naming, commits, trains — adapted
  from Control's), `SECURITY.md`, `CODE_OF_CONDUCT.md`, `CONTEXT.md` (domain language:
  Knowledge Base, Document, Chunk, Partition, Cluster, Keyword, Endpoint, Paired
  client, Pairing code, Registration blob), `AGENTS.md` + `CLAUDE.md` (`@AGENTS.md`
  import, like Control), `.agents/{domain,issue-tracker,triage-labels}.md`, `docs/adr/`
  with `README.md` and ADRs **0001–0006** written from the plan: 0001 the Knowledge
  Base is its own service; 0002 Search owns its data (schema `search`); 0003 the
  paired client is the identity (mTLS reused from Control); 0004 model endpoints flow
  both ways; 0005 behaviour is identical, nothing is retired; 0006 blob storage and
  queue are Search's own. `deploy/Dockerfile`, `deploy/docker-compose.yml`,
  `deploy/healthcheck.mjs`. `.github/workflows/ci.yml` (typecheck, lint, test,
  conventions) adapted from Control's, without the release/promotion machinery for now.
- Packages `search`, `sdk`, `shared`, `cli` with `package.json`, `tsconfig.json`,
  `vitest.config.ts` in Control's style (SDK: ESM, `Bundler` resolution, `.ts`
  specifiers, `exports: { "./*": "./src/*.ts" }`, `tsconfig.build.json` for publish).
  `panel` is a placeholder README only.

## Lift (into `packages/search/src/` and `packages/shared/src/`)
From `~/Projects/actana.ai/wt-search-extraction/apps/actana/` (branch
`search-extraction`, identical to `core-integration` for these files):
- `lib/kb/**` (query, query-handler, ingest, ddl, partition, clustering,
  clustering-trigger, pca, locks, provider-context, jobs/*, keywords/*, search/*) — not
  `agent-auth.ts` (stays in Studio).
- `lib/knowledge/`: `embeddings.ts`, `constants.ts`, `types.ts`, `chunks/`,
  `documents/` (service, document-processor, embed-pipeline, utils, parser-extension,
  types), `filters/`, `tags/` (service + utils + types: the v1 tag definitions), and
  the **v1 tag+vector search** from `app/api/knowledge/search/utils.ts` and
  `app/api/v1/knowledge/utils.ts`. Not `connectors/` (stays in Studio).
- `lib/chunkers/**`, `lib/file-parsers/**`, `lib/tokenization/**` → `packages/shared`
  (pure) where they have no DB/env imports; otherwise `packages/search`.
- `lib/models/` embedding + inference dispatch, providers, templates, catalog,
  endpoint-schemas → `packages/search/src/models/` (behind `ModelEndpointSource`,
  TASK-005 wires the sources; for this task a `LocalEndpointSource` stub that reads
  env `SEARCH_TEST_EMBEDDING=hash-ngram` is enough to run tests).
- Every `*.test.ts` beside the code. The Studio fixture suite
  (`tasks/search-extraction/fixtures/`) is copied byte for byte into
  `packages/search/src/__fixtures__/` and run in-process (not over REST yet).

Replacements: `@actana/db` → `packages/search/src/db/` (drizzle-orm + postgres-js,
schema in `db/schema.ts` per TASK-003, `db/client.ts`); `@actana/logger` → a small
`log.ts` like Control's `packages/shared/src/log.ts`; `@actana/queue` →
`packages/search/src/queue/` (BullMQ, prefix `search`); `env` → `config.ts` (zod-parsed
`SEARCH_*`); `@/lib/acl` and workspace checks → **removed** (the paired client scope is
the only check, applied in the API layer, TASK-004); `@/lib/uploads` / S3 → `blob/`
(`@aws-sdk/client-s3`, S3-compatible). `generateId` → `shared/src/short-id.ts` like
Control.

## Done when
`pnpm install --frozen-lockfile` (first run creates the lockfile), `pnpm typecheck`,
`pnpm lint`, `pnpm test` are green; the lifted unit tests pass; the fixture suite passes
in-process against `SEARCH_TEST_DATABASE_URL`; `git log` is a series of Conventional
Commits on `feat/bootstrap-and-lift`.
