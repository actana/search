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
on the namespace: 26 specifiers over the 167 runtime modules. **`ipaddr.js`
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
runtime module — 167 of them — in one child `node`, and then *calls*
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
   `SUN_PATH_MAX_BYTES` (104 on macOS, 107 on Linux) and `socketPathProblem`;
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
