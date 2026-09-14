# Agent skills

### Issue tracker

Issues and specs for this repo live as GitHub issues on `actana/search`, driven
with the `gh` CLI. The task board for the extraction itself is in-repo under
`tasks/` — `todo/`, `in-progress/` (one at a time), `done/` (append a one-line
**Outcome**). See `.agents/issue-tracker.md`.

### Triage labels

Five canonical roles as label strings: `needs-triage`, `needs-info`,
`ready-for-agent`, `ready-for-human`, `wontfix`. See `.agents/triage-labels.md`.

### Domain docs

Single-context — one `CONTEXT.md` + `docs/adr/` at the repo root. See
`.agents/domain.md`.

### Provenance

`packages/search` and `packages/shared` began as a **lift** out of Actana
Studio's `apps/actana/lib/{kb,knowledge,chunkers,file-parsers,tokenization,models}`.
File names were kept recognisable on purpose so a reviewer can diff them
against the original, and where a lifted module lost a branch that reached a
Studio-only concept — an agent, a workspace, an ACL check, a crew token — the
cut is marked in place with a `// lifted:` comment saying what went and why.
**Ranking, chunking, clustering and keyword logic did not change in the lift**
and do not change without an ADR.

The transport is Actana Control's, copied rather than reinvented: the CA, the
per-client certificates, the short-code pairing session and the single
pre-auth route. Once it is proven here it is lifted out of Control into its own
package and both repos consume it.

### Structure

`packages/shared` is pure — no database handle, no environment variable, no
network client. Anything that needs one belongs in `packages/search`.
Everything above the SDK reaches the core only through `@actana/search`.

### Release trains

Work targets the open `beta/x.y.z` train, never `main`. A train is cut by a
person, by hand, and never by a workflow. See `CONTRIBUTING.md`.
