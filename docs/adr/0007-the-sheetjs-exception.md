# The SheetJS exception

> **Superseded by [ADR 0012](0012-spreadsheets-parse-without-sheetjs.md).** SheetJS
> is removed, both advisories are no longer ignored, and `.xls` is no longer
> supported. The text below is the original record, kept unchanged.

`pnpm audit --prod --audit-level high` is a required CI job, and two advisories
against SheetJS (`xlsx@0.18.5`) are **acknowledged in `pnpm-workspace.yaml`
rather than fixed**: prototype pollution (GHSA-4r6h-8v6p-xvw6, fixed in 0.19.3)
and a regular-expression denial of service (GHSA-5pgg-2g8v-p4x9, fixed in
0.20.2). They are the only two entries in that list, and adding a third needs
this document amended first.

The reason there is no upgrade is not neglect. SheetJS stopped publishing to npm
at 0.18.5 and moved to its own CDN, so the fixed versions are reachable only as
a tarball URL — a dependency form [`SECURITY.md`](../../SECURITY.md) forbids,
for reasons that have nothing to do with SheetJS and everything to do with what
a URL dependency does to a lockfile's guarantees. `pnpm audit` reports the
patched version as `None` because, from npm's point of view, there is none.

So the choice is between shipping a known-vulnerable parser, removing it, and
letting a required check stay red. Red is the worst of the three: a check that
is red for a reason nobody can act on is a check people learn to click past, and
then it is not a check.

## What we are actually exposed to

`xlsx` is reached from exactly one place — `XlsxParser` in
`packages/shared/src/file-parsers/xlsx-parser.ts` — for `.xlsx` and `.xls`
documents, on the ingest path. Reaching it requires a paired client with `write`
scope (ADR 0003) uploading a spreadsheet. It is not reachable from a query, and
not reachable at all by an unauthenticated caller: the only pre-auth route is
`POST /v1/pair/redeem`.

The ReDoS is bounded. Every parse runs inside `withParseTimeout`, whose budget
is derived from the input size, so a crafted spreadsheet burns one worker for at
most that budget and then the parse fails cleanly. That is the same protection
the engine already applies to decompression bombs.

The prototype pollution is the real one, and it is not bounded by anything we
control. A crafted workbook can reach `Object.prototype` inside the worker
process. What it cannot reach is another paired client's data by that route —
the scope check happens before ingest, in the API layer — but a polluted
prototype in a long-lived worker is a genuine problem and this ADR is not
pretending otherwise.

## Considered Options

- **Drop SheetJS and parse spreadsheets with `officeparser` (rejected, for
  now).** `officeparser` is already a dependency and does read `.xlsx`. It
  produces different text: SheetJS gives the engine sheet and row structure,
  which is what steers `StructuredDataChunker`, and a flat text extraction
  chunks the same workbook differently. That is a retrieval-quality change on
  every spreadsheet already in a knowledge base, and ADR 0005 says behaviour
  does not move in the lift. It is the right fix; it is not a fix that belongs
  in this task.
- **Vendor the fixed SheetJS build into the repository (rejected).** It removes
  the advisory and replaces it with a copy of a third-party library that no
  tooling will ever tell us is out of date.
- **Take the CDN tarball as a dependency (rejected).** Forbidden by
  `SECURITY.md`, and the prohibition is not negotiable for one package's
  convenience.
- **Let the audit job stay red (rejected).** See above.

## Consequences

- The two GHSAs are listed in `pnpm-workspace.yaml` under `auditConfig.ignoreGhsas`,
  each with a one-line comment, pointing here.
- **The exception ends when either is true**, and whoever notices should say so:
  SheetJS resumes publishing to npm, or spreadsheet parsing moves off it behind
  a fixture re-record that shows what changed. The second is a deliberate
  behaviour change with its own ADR, not a dependency bump.
- Operators who do not need spreadsheet ingest lose nothing by rejecting
  `.xlsx` and `.xls` at their own boundary. That is worth saying out loud
  because it is the only mitigation a deployment can apply today.
- The other three findings in the same run are `moderate` and below the job's
  threshold; they are not ignored, they are simply not gating.
