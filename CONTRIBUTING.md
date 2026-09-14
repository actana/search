# Contributing to actana/search

Thanks for being here. This file is the short version of how the project is
shaped, what a reviewer will hold you to, and where your pull request goes.

## The shape of the project

Search is a pnpm workspace with one package per role. The layering is
deliberate and one-directional:

```
packages/shared   pure code, no database, no environment, no network
      ↑
packages/search   the core — API, workers, migrations, pairing
      ↑
packages/sdk      @actana/search — the typed client and the wire schemas
      ↑
packages/cli      packages/panel      Studio
```

Everything above the SDK reaches the core **only** through the SDK. There are
no direct table reads, no shared Drizzle schema, and no imports across the
boundary. If a consumer needs something, the SDK gains a method and the core
gains a route — not a shortcut.

`packages/shared` is pure on purpose. A module that wants a database handle,
an environment variable or an HTTP client belongs in `packages/search`.

### The stack

Node 24, TypeScript, pnpm. Postgres with pgvector through drizzle-orm and
postgres-js. BullMQ on Redis for the ingestion fan-out. An S3-compatible
bucket for the blobs. vitest for the suites. No framework.

### Where the code lives

Read [`CONTEXT.md`](CONTEXT.md) first — it is the domain language, and a pull
request that invents a synonym for a word already in there will be asked to
use the word. [`docs/adr/`](docs/adr/) holds the decisions; read the ones that
touch what you are changing.

## Setup

```bash
nvm use 24                    # Node 24 is required — `engine-strict` enforces it
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test
```

Integration suites need a database and gate themselves on
`SEARCH_TEST_DATABASE_URL`. Without it they skip; with it they run:

```bash
docker compose -f deploy/docker-compose.yml up -d --wait
export SEARCH_TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/search_test
pnpm test
```

## Before you open a PR

`pnpm typecheck`, `pnpm lint` and `pnpm test` all green, locally, before you
push. CI runs the same three and nothing more forgiving.

## The rules a reviewer will hold you to

- **The engine's behaviour does not drift.** Ranking, chunking, clustering and
  keyword extraction were lifted out of Studio unchanged so that every existing
  caller scores exactly as it did. A change to any of them is its own pull
  request, with its own ADR, and the fixture suite is the evidence.
- **One definition of a request.** The zod schema the core validates with is
  the schema the SDK is built from. Do not write a second one.
- **The certificate is the identity.** No route takes a client id, a tenant id
  or a workspace id from the URL, the body or a header.
- **Dependencies are the last resort.** Vanilla code over a package. If you do
  add one: exact pin, no git dependency, no install script outside the
  `allowBuilds` allow-list, and it must clear the seven-day release-age gate in
  `pnpm-workspace.yaml`. See [`SECURITY.md`](SECURITY.md).
- **A lifted file keeps its name.** The first commits of `packages/search` are
  a lift from Studio, and a reviewer diffs them against the original. Renaming
  a lifted module costs that, so do not — and where a lifted module lost a
  branch that reached a Studio-only concept, the cut is marked in place with a
  `// lifted:` comment saying what went and why.

## Architectural decisions

Decisions live in [`docs/adr/`](docs/adr/), numbered and immutable once
landed. **The ADR ships in the same pull request as the code it describes.** If
your change contradicts an existing one, say so in the pull request rather than
routing around it: reopening a decision is normal, quietly inverting one is not.

## Where your PR goes: the open train, not `main`

Work targets the open `beta/x.y.z` branch — the **train** — never `main`.
`main` advances only by promoting a train that has already been through CI.
A train is cut by a person, by hand; nothing guesses a version.

## Branch naming

Branch off the open train. Names must match `<type>/<kebab-case-description>`:

```
feat/local-endpoint-source
fix/partition-provision-race
docs/pairing-quickstart
```

Allowed types: `feat` `feature` `fix` `bugfix` `hotfix` `release` `chore`
`docs` `refactor` `perf` `test` `ci` `revert`. Lowercase only,
hyphen-separated, no leading, trailing or doubled separators.

CI checks this (the `Conventions` job). To be told before you push rather than
after, enable the local hooks once per clone:

```bash
git config core.hooksPath .husky
```

Husky is not a dependency — these run under plain git. The `commit-msg` hook
checks your message with commitlint if it is available and steps aside with a
hint if it is not.

## Commits and PRs

Commit messages and **PR titles** follow
[Conventional Commits](https://www.conventionalcommits.org/):
`<type>(<scope>): <subject>`. The types are the same list as the branch types.
`commitlint.config.mjs` is the source of truth and CI enforces it on both.

Scopes in this repo: `search`, `sdk`, `shared`, `cli`, `panel`, `repo`, `deps`.

```
feat(search): lift the KB query path out of Studio
fix(shared): keep the recursive chunker's overlap at a token boundary
```

We **squash-merge, using the PR title as the commit message** — so the PR
title is what lands on the train and what the changelog is built from. Write it
as the commit you want, not as a description of your branch.

CI lints **every commit in the pull request**, not just the title. A tidy title
over a branch of `wip` commits fails the `Conventions` job.

Subject limit is 120 characters, body lines 132 — measure them before you
commit, because a single unwrapped body line is the most common way a commit
here goes red. Footers (`Refs #39`, `Co-authored-by:`, `BREAKING CHANGE:`) go
last, separated from the body by a blank line.

- Keep PRs to one reviewable idea.
- Link an issue with a closing keyword (`Closes #123`).
- `git config commit.template .gitmessage` gives you the format in your editor.

## Filing issues

A maintainer triages with five labels and no others: `needs-triage`,
`needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See
[`.agents/triage-labels.md`](.agents/triage-labels.md).

Do not file security problems as issues — see [`SECURITY.md`](SECURITY.md).

## Licence

Contributions are accepted under the [MIT Licence](LICENSE).
