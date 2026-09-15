# TASK-012s — The three defects the end-to-end proof found

The TASK-012 proof paired a real Studio to a real instance for the first time
and ran the train under **plain `node`**, which is what the deploy image runs
and what no suite in this repository had ever done. Its record — request and
response bodies, log lines, exit codes — is in the Studio worktree at
`tasks/search-extraction/proto/PROOF.md`, §Defects S-1..S-3. This is what was
done about them.

Branch `fix/plain-node-esm-interop`, off the `beta/0.1.0` train at `3c59994`.

## Proof defects (2026-09-15)

### S-1 (blocking) — `ipaddr.isValid is not a function`

`core/security/url-guard.ts` did `import * as ipaddr from 'ipaddr.js'`.
`ipaddr.js` is CommonJS whose named exports `cjs-module-lexer` cannot detect, so
under plain Node ESM that namespace holds `default` and `module.exports` and
nothing else: `ipaddr.isValid` is `undefined` and every call throws. On the live
instance that was `PUT /v1/endpoints` (the guard on `sealDeclaration`'s
`resolverUrl`, reached even with no `baseUrl`), `PUT /v1/webhooks`, and every
URL
ingest — a `400` each, with a green 1057-test gate behind them, because vitest
transforms what it loads and applies CJS/ESM interop shims.

**Fixed** by the default import (`import ipaddr from 'ipaddr.js'`).

**The audit the fix asks for.** Every runtime import of an external package in
`packages/*/src` (tests excluded) was checked by importing it under plain `node`
from its own package directory and asking whether the names the code reads are
on the namespace: the 23 distinct external specifiers named in this paragraph
(22 across the 167 runtime modules of `search`, `shared` and `cli`, plus
`undici` from `sdk`). **`ipaddr.js`
was the only one.** `bullmq`, `drizzle-orm` (and `/pg-core`, `/postgres-js`,
`/postgres-js/migrator`), `ioredis`, `@aws-sdk/client-s3`,
`@aws-sdk/s3-request-presigner`, `pdf-lib`, `unpdf`, `zod`, `undici`,
`@peculiar/x509`, `cheerio`, `csv-parse`, `js-tiktoken`, `js-yaml`, `xlsx`,
`officeparser`, `mammoth`, `selfsigned` and `postgres` all resolve the names
they are used by — the CommonJS ones because the lexer does find their exports
(`js-yaml` and `xlsx` are namespace imports and both work), and `mammoth`,
`selfsigned` and `postgres` because they are already default imports.

**The regression gate, which cannot be fooled by vitest.**
`scripts/import-runtime-modules.mjs` walks `packages/{search,shared,cli}/src`
(skipping `*.test.ts`, `__tests__`, `__fixtures__`, `testing/`), imports every
runtime module — 167 of them (186 since the train review fix round added
`packages/sdk/src`) — in one child `node`, and then *calls*
`validateExternalUrl('https://example.com')` — because the import never failed;
only the call did. It runs in two places:

- `packages/search/src/__tests__/plain-node-imports.test.ts` spawns it with
  `--experimental-strip-types`, the way the service is started, and asserts on
  the `SUMMARY` line it prints — no assertion in that file is made in the vitest
  process, which is the point.
- CI's **Boot** job runs it directly, beside the migrator it already runs under
  plain `node`. That job needs no database for this step and is the one place
  that loads this repository the way the image does.

Red-first, on the old `import * as ipaddr`: 2 of the 4 tests in that file fail
with `probe:url-guard/validateExternalUrl: ipaddr.isValid is not a function`,
and the script exits 1. `migrate-cli.ts` is the one module the walk skips —
importing it *is* running the migrations, and CI's Boot job already runs it
twice.

### S-2 — a persisted `embedding_endpoint_id` reported as `null`

The write was fine; the response was not, and the cause was not in `kbToWire`
alone. `createKnowledgeBase` returns an object it assembles by hand that names
**none** of Search's own columns, the lifted listing and update select twelve
columns that do not include them, and only `getKnowledgeBaseById` selects them
all — so the mapper's `kb.embeddingEndpointId ?? null` was reading a field that
was never set. The engine is behaviour-frozen (ADR 0005), so the fix is in the
route layer:

- `kbToWire(kb, row)` now takes the row as a **required** argument
  (`KbWireColumns`) and reads `language`, `embedding_endpoint_id`,
  `inference_endpoint_id`, `inference_model_id`, `kmeans_k`,
  `kmeans_silhouette` and `kmeans_updated_at` off it. Required, because every
  route that serialises a KB already holds the row — so the compiler asking for
  it closes the hole rather than trusting the next author.
- the create re-reads the whole row it just wrote (it already read two columns
  of it for the partition); the listing's `languagesFor` became
  `searchColumnsFor` and reads the seven in one query it was already making;
  `PATCH` answers from the post-update row; the restore from the un-archived
  one.

Tested twice: `api/serialize.test.ts` pins the mapper against the exact shape
the lifted create returns, and `api/routes/kbs.integration.test.ts` drives
create, list, get, patch, archive and restore over the wire through the SDK
against a live Postgres and compares each response to the row. On the old
mapper, 5 of its 6 cases are red — the sixth is the single read, which
`getKnowledgeBaseById` always had right, exactly as the proof observed.

### S-3 — a failed boot that went on serving `{"ok":true}`

`boot()` opened the API listener at step 4 and the admin listener at step 5, and
the step-5 failure (`listen EINVAL` on a socket path longer than `sun_path`)
left step 4's listener open. The entry point set `process.exitCode = 1` and
returned, which asks the event loop to run dry — and the listener is precisely
what keeps it from doing so. The result: a live process answering
`GET /v1/health` with `{"ok":true}`, no admin socket to mint a pairing code on,
no workers, and a container probe calling it healthy.

Three changes, and the third is the one that makes the failure legible:

1. **All or nothing.** `worker.ts` gained `openInOrder(steps)`: it opens each
   step in order and, on a failure, closes everything already opened in reverse
   through `drainAndClose` (best-effort, so one listener that will not close
   cannot mask the error) and throws `BootStepFailedError`, which names the
   step.
   `boot()`'s steps 4–6 go through it.
2. **Exit, not `exitCode`.** The entry point calls `process.exit(1)` after
   logging — by then `openInOrder` has closed the listeners, so there is nothing
   to drain.
3. **`SEARCH_STATE_DIR` is measured at configuration time.**
   `api/admin-socket.ts`
   is a new leaf module holding `ADMIN_SOCKET_FILENAME`, `adminSocketPath`,
   `SUN_PATH_MAX_BYTES` (104 on macOS, 108 on Linux — corrected from 107 in the train review fix round) and `socketPathProblem`;
   `config()` refuses a state directory whose `admin.sock` would be too long,
   with the length, the limit, the path and both ways out. `startAdminServer`
   asks the same question about a `socketPath` handed straight to it, and now
   closes its own listener if a later bind in the same call fails rather than
   leaving a bound socket and a socket file behind. The README says the limit
   exists.

Tested with fakes for the ordering (`worker.test.ts`, "a boot that cannot
finish" — a rejecting listener, reverse unwinding, an unwind that itself throws,
and a step that opens nothing), against the kernel for the limit
(`api/admin-socket.test.ts` binds at the limit and gets `EINVAL` one byte past
it, so the constant cannot drift), and through `config()` for the refusal
(`config.test.ts`). Verified for real as well: a 136-byte `SEARCH_STATE_DIR`
now exits 1 at configuration time with the sentence, and a boot whose admin
listener cannot bind closes the API listener (`Closed { what: 'api' }`), exits
1,
and leaves the port refusing connections and no socket file behind.

## Two things found on the way, neither fixed here

- **`SEARCH_ADMIN_PORT` cannot be used beside the Unix socket.**
  `startAdminServer` calls `listen` twice on one `http.Server` — deliberately,
  per its own comment ("Two listeners would be two routers") — and Node refuses
  the second with *"Listen method has been called more than once without
  closing"*. So any instance that sets `SEARCH_ADMIN_PORT` fails to boot, and
  before S-3 it failed to boot *while still serving*. The fix is a second
  `http.Server` sharing the one request handler, which keeps the single router
  the comment is protecting; it is a change to that surface's shape and is not
  one of the three defects this branch was for.
- **`POST /v1/kbs` accepts a `language` the partitioner will refuse.** The
  contract takes any non-empty string; `provisionKbPartition` allows `english`
  and `simple` and throws otherwise — after the row has been inserted. A KB
  exists with no partition and the caller gets a `500` where a `400` and no row
  is the answer.

## Gates

`pnpm typecheck`, `pnpm lint` (276 files strippable), `node
scripts/check-strip-types.mjs`, `pnpm audit --prod --audit-level high`, and
`SEARCH_TEST_DATABASE_URL=…/search_test_b pnpm test` — 1142 passing over four
packages (shared 358, core 651, sdk 73, cli 60; 6 skipped, 1 todo), with the
fixture suite's q01–q15 green in both replays. `node
packages/sdk/scripts/rehearse-npm-pack.mjs` still installs and imports every
entry point from a tarball.

## Train review fix round

A Fable review of `3c59994..f937702` (the `beta/0.1.0` train) returned one
blocker, one should-fix and three nits. Fixed on
`fix/sun-path-and-blob-attach-race`.

| Finding | What changed | Where | Test |
|---|---|---|---|
| BLOCKER: `SUN_PATH_MAX_BYTES` was 107 on Linux, so "limit+1 → EINVAL" was red on Linux CI | Linux limit is 108. The comment now gives the real reason: libuv's `uv_pipe_bind2` with `UV_PIPE_NO_TRUNCATE` refuses only a name longer than `sizeof(sun_path)`, and Linux accepts a 108-byte path with no trailing NUL. macOS is 104. The refusal message says "the size of sun_path" and no longer says the kernel refuses it. README wording matches. | `packages/search/src/api/admin-socket.ts:31-43`, `:59`; `README.md:61-66` | `admin-socket.test.ts` › "accepts a path at the limit and refuses one past it" (`:57`), "is the length the kernel actually enforces" (`:95`) |
| SHOULD-FIX: blob attach treated `pending` as settled, but ingest and include leave a `pending` row with a job already queued. The `UPDATE` was also check-then-act. | Only `completed`, `failed`, and `pending` with `includedInKb: false` can be attached (`blobAttachRefusal`). The same rule, written as SQL (`blobAttachableSql`), is in the `UPDATE`'s `WHERE` (`repointDocumentBlob`). If zero rows update, the route re-reads the row: a deleted row gets 404, anything else 409. Updated the route doc, `docs/external-api.md` and the SDK `attachBlob` docstring to list exactly which documents can be attached. | `packages/search/src/api/routes/documents.ts:73-168`, `:335-342`, `:366-379`; `docs/external-api.md:317-333`; `packages/sdk/src/client.ts:464-470` | `fixture-suite.rest.test.ts` › "attaches new bytes to a document without re-ingesting it" (`:2241`): pending+included → 409 (`:2337`), pending+not-included → 200, lost race (status set to `embedding` / `pending`+included after the check) → `repointDocumentBlob` returns `false` and `fileUrl` stays the same (`:2366`) |
| Docs: orphaned objects | The blob attach docs now say that a replaced object, or one stored by an attach that loses the race, is left orphaned. There is no GC or reaper and no route calls `deleteFile`. No GC was built. | `docs/external-api.md:308-312`; `documents.ts:321-323`; `client.ts:461-462` | docs only |
| NIT: walker `ROOTS` did not include `packages/sdk/src` | Added it. `sdk/scripts` is outside `src` and is not walked. Coverage assertion now covers four packages and also checks for `packages/sdk/src/index.ts`. The walker exits 0 over **186** modules (search 114, shared 42, sdk 19, cli 11), with 0 failures. | `scripts/import-runtime-modules.mjs:50-55`; `plain-node-imports.test.ts:100-120` | `plain-node-imports.test.ts` › "covers all four runtime packages" (`:105`) |
| NIT: "26 specifiers" could not be reproduced | Replaced it with a count you can check. I took every `from '…'`, side-effect `import '…'` and `import('…')` specifier in the walker's module list. I dropped relative paths, `@actana/*` and anything `module.isBuiltin` accepts, plus one hit that was inside a comment (`@/providers/models`, `models/catalog.ts:16`). That leaves 23 distinct packages: exactly the ones the paragraph names. 22 are in search/shared/cli and `undici` is in sdk. | this file, "The audit the fix asks for" | n/a |

**Linux measurement** (`docker run --rm -v "$PWD":/w node:24-slim node
<probe>`, a plain-node copy of the test's `pathOfLength` and `bind` helpers
that imports the real module):

```
before: node v24.21.0 libuv 1.52.1 platform linux SUN_PATH_MAX_BYTES=107
bind 107 bytes -> OK; guard -> accepts
bind 108 bytes -> OK; guard -> refuses     # limit+1 bound: the red test
bind 109 bytes -> EINVAL; guard -> refuses
after:  node v24.21.0 libuv 1.52.1 platform linux SUN_PATH_MAX_BYTES=108
bind 107 bytes -> OK; guard -> accepts
bind 108 bytes -> OK; guard -> accepts
bind 109 bytes -> EINVAL; guard -> refuses
```

**Left as recorded, not in scope:** the `SEARCH_ADMIN_PORT` double listen, a KB
`language` that is refused only after the row is inserted, and an empty part
filename (ingest has the same behaviour).

**Gates.** `pnpm typecheck`, `pnpm lint` and `node scripts/check-strip-types.mjs`
pass (277 files strippable). `pnpm audit --prod --audit-level high` finds 3
moderate issues and nothing high. `pnpm test` against `search_test_b` passes
1155 tests (shared 358, core 655 with 6 skipped and 1 todo, sdk 82, cli 60).
The test count did not change because the new assertions were added to existing
`it` blocks. `rehearse-npm-pack.mjs` installs and imports from a tarball, and
`import-runtime-modules.mjs` exits 0.
