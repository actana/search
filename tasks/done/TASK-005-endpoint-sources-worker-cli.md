# TASK-005 — Endpoint sources, worker process, CLI

1. `packages/search/src/models/source.ts` per Part 2: `ModelEndpointSource`,
   `LocalEndpointSource` (rows in `model_endpoint`, `key_ciphertext` sealed with
   `SEARCH_ENCRYPTION_KEY`, AES-256-GCM helper copied in shape from Studio's
   `lib/core/security/encryption.ts`), `MirroredEndpointSource` (metadata rows with
   `source='mirrored'`, key fetched from `resolverUrl` with `x-api-key: resolverKey`,
   body `{ workspaceId?: <paired client label/key>, externalId }`, 60 s in-memory TTL,
   never persisted, never logged). Chosen per paired client by what `PUT /endpoints`
   last declared.
2. Worker: `packages/search/src/worker.ts` — BullMQ workers for the lifted job types
   (`ingest.document`, `embed.batch`, `embed.finalize`, `clusters.validate`,
   `keywords.extract`, `document.timeout-sweep`) on queue `search` with prefix `search`;
   `pnpm --filter @actana/search-core dev` runs API + worker in one process, `start:api` /
   `start:worker` split them.
3. CLI `packages/cli` (`actana-search`): `pair new` (mints a code on a running core:
   local admin socket or `SEARCH_ADMIN_TOKEN` over loopback, prints code + CA
   fingerprint), `pair ls`, `pair revoke <id>`, `endpoint add`, `kb ls|create|rm`,
   `ingest <kb> <file>`, `query <kb> "<text>"`, `status`. Uses `@actana/search` only.
   Config in `~/.actana-search/cli.json` (registration blob per profile).
4. Tests for the sources (TTL, never-store), the worker wiring, and the CLI arg parsing.
