# TASK-006 — `@actana/search` SDK and mTLS pairing copied from Control

## Pairing (copy, adapt storage, keep the wire)
From `~/Projects/opensource/actana-control`:
- `packages/shared/src/{pairing-code,pairing-session,pairing-store,pairing-audit,
  core-cert-material,core-material-store,registration-blob,client-id}.ts` →
  `packages/shared/src/pairing/`
- `packages/core/src/{core-preauth-gate,core-pairing-routes,core-pairing-rate-limit,
  core-pairing-revocation,core-pairing-wiring,core-self-register}.ts` and the TLS
  server options from `pty-core-link-server.ts` (CA issuance with `selfsigned` /
  `@peculiar/x509`, `requestCert`, `rejectUnauthorizedAtHandshake`, per-request
  certificate re-check) → `packages/search/src/pairing/` and `api/server.ts`
- `packages/sdk/src/{core-pairing,core-pairing-csr,core-pairing-wire,
  core-registration-blob}.ts` → `packages/sdk/src/{pairing,pairing-csr,pairing-wire,
  registration-blob}.ts`
- Their tests. Keep the ADR 0034 invariants and name them in tests: the pre-auth hole is
  exactly one route wide; the code is not a credential; single-use, five-minute expiry,
  capped attempts; per-client certificate; revocation by serial.
- Storage: pairing sessions and paired clients live in Postgres (`pairing_code`,
  `paired_client`), CA + server key in `SEARCH_STATE_DIR` like Control's state paths.
- Wire: **identical** to Control — `POST /v1/pair/redeem`, `CorePairingRedeemRequest`
  shape (`{ sessionId, code, csr, client: { label, platform } }` — the session id
  travels with the code, ADR 0034 D11), response = the four fields Control returns,
  `{ endpoint, caCert, clientCert, bearer }`; keep the type names
  (`SearchPairingRedeemRequest` re-exports the same fields) so TASK-015 can lift the
  code into one package later without a wire change.
- Scopes: the redeem grants what the code was minted with (`pair new --scope admin
  --kbs a,b`), default `admin`.

## SDK (`packages/sdk`, published as `@actana/search`)
- `client.ts`: `SearchClient.fromRegistrationBlob(blob, { label })` → `undici`
  `Agent` with `ca`, `cert`, `key`; `request(method, path, body | multipart)`; typed
  namespaces `kbs.{list,create,get,update,delete,query,ingest}`, `documents.{list,get,
  update,delete,chunks,updateChunk,deleteChunk,include,upsert}`, `keywords.*`,
  `clusters.*`, `tags.*`, `endpoints.{get,put}`, `webhooks.{get,put}`, `events()`
  (SSE async iterator), `health()`, `capabilities()`. Errors → `SearchApiError { code,
  status, detail }`.
- `pairing.ts`: `pairWithSearch({ address, code, expectedCaFingerprint, client })`
  with the same failure codes as Control's `CorePairingError`.
- `contracts/` (zod, TASK-004) is exported: `@actana/search/contracts`.
- `README.md` with the Part 2 snippet; `tsconfig.build.json`; `pnpm pack` produces a
  tarball that installs in a plain Node 22 project (`scripts/rehearse-npm-pack.mjs`).
- Version `0.1.0`.

## Outcome

Done on `feat/mtls-pairing-and-sdk`. Control's pairing copied rather than
reimplemented ([ADR 0008](../../docs/adr/0008-the-pairing-code-is-copied-from-control.md)):
the pure half in `packages/shared/src/pairing/` (code alphabet and CSPRNG draw,
session rules, digest, audit, cert material and CSR signing, material store,
bearer, registration blob, client id), the server half in
`packages/search/src/pairing/` (pre-auth gate, redeem route, rate limit,
revocation, wiring, identity bootstrap), the client half in
`packages/sdk/src/{pairing,pairing-csr,pairing-wire,registration-blob}.ts`.

**The wire is Control's, byte for byte** — `POST /v1/pair/redeem`, request
`{ sessionId, code, client: { label?, platform? }, csr }`, 200 body
`{ endpoint, caCert, clientCert, bearer }` — with two values (not fields)
different: `endpoint` is `https://` because Search has no WebSocket, and
`bearer` is inert because the certificate is the identity. Storage moved to
Postgres (`search.pairing_code` keyed by session id, `search.paired_client`
carrying the grant; migration `0001`), which makes `consume` one conditional
`UPDATE` and closes the cross-process race Control's file store concedes. Scopes
ride on the session and never on the request. The pre-auth predicate is an exact
path rather than a prefix, because `GET /v1/pair/status` lives under the same
one; `GET /v1/health` is a second open route and is recorded as such.

Also: the mTLS server (`api/server.ts`) with per-request identity from the leaf
certificate and a `SEARCH_DEV_INSECURE` mode that refuses to start in
production, the loopback admin listener (`api/admin-server.ts`,
`SEARCH_ADMIN_PORT` 7444) that mints codes and revokes clients, the
`SearchClient` with typed namespace stubs for TASK-004, the SDK README and a
pack rehearsal that installs the tarball into a plain Node project. Control's
test names carried over, plus an end-to-end suite that pairs over real TLS.

### Review round (REQUEST-CHANGES, addressed)

- **Serial spelling.** `@peculiar/x509` issues `03ab…` and Node reports `3AB…`,
  so the `cert_serial` lookup never matched and every request resolved through
  the fingerprint fallback. `normaliseCertSerial` moved to
  `@actana/search-shared/pairing/cert-material` and is applied on both sides —
  at `recordClient` and at `findClientByCertificate` — with a test that looks a
  row up by the socket's spelling and no fingerprint at all.
- **Admin CSRF.** The surface moved to a Unix socket at
  `$SEARCH_STATE_DIR/admin.sock`, 0600, which is Control's filesystem guarantee
  expressed the same way. The loopback TCP port survives as opt-in
  (`SEARCH_ADMIN_PORT`, unset by default) and refuses any request carrying
  `Origin` or a content type other than `application/json`. ADR 0008 D6 amended.
- **`SEARCH_DEV_INSECURE`** is now an allow-list (`NODE_ENV=test`, or
  `SEARCH_TEST_DATABASE_URL` set) rather than a deny-list on `production`, so an
  unset `NODE_ENV` refuses.
- **KB grants are enforced.** `SearchRoute.kbIdFrom` is checked by the router
  before `handle` (403 `kb-forbidden`) and `SearchRequestContext.allowsKb` is
  there for a route whose KB is in a body.
- **The server leaf renews** inside the last 30 days of its life, against the
  same CA, so nothing paired re-pairs.
- Plus: `/v1/health` tells an unauthenticated caller `{ ok }` only,
  `last_seen_at` is written once a minute per client, the rate limit is
  asserted through the route, a foreign-CA certificate is refused, and
  `runMigrations` now refuses a database where drizzle silently skipped a
  migration.