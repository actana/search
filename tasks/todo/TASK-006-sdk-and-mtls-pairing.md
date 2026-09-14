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
  shape (`{ code, csr, client: { label, platform } }`), response = registration blob
  `{ endpoint, caCertificate, clientCertificate, ... }`; keep the type names
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
