/**
 * The core's entry point: apply the migrations, load the identity, serve.
 *
 * In order, and the order is the point:
 *
 *   1. **Migrate.** Search owns its schema (ADR 0002), so an instance that
 *      starts against a database it has not migrated migrates it rather than
 *      failing in the first query.
 *   2. **Identity.** The CA, the server certificate and the secret the pairing
 *      code digest is keyed under, from `SEARCH_STATE_DIR` — loaded, re-signed
 *      or minted (`pairing/self-register.ts`). A boot that cannot serve TLS
 *      stops here rather than at a client's handshake.
 *   3. **Revocations, seeded before the first request.** The sweep's first read
 *      happens before the listener is up, so an instance that cannot read its
 *      own `paired_client` table is already failing closed when it answers.
 *   4. **The API**, mutual TLS with exactly one pre-auth route.
 *   5. **The admin listener** on a Unix socket under `SEARCH_STATE_DIR`, which
 *      is where a pairing code is minted. `SEARCH_ADMIN_PORT` adds a loopback
 *      TCP port beside it for a platform with no Unix sockets.
 *
 * The ingestion workers and the endpoint sources land in TASK-005; the rest of
 * the REST surface in TASK-004, through `registerRoutes`.
 */

import { createLogger } from "@actana/search-shared/log";
import { defaultStateDir } from "@actana/search-shared/pairing/material-store";
import { config, databaseUrl } from "./config.ts";
import { createDatabase } from "./db/client.ts";
import { runMigrations } from "./db/migrate.ts";
import { adminSocketPath, startAdminServer } from "./api/admin-server.ts";
import { startSearchServer } from "./api/server.ts";
import { SearchPairingStore } from "./pairing/pairing-store.ts";
import { PairingRevocations, startPairingRevocationSweep } from "./pairing/pairing-revocation.ts";
import { ensureMaterial } from "./pairing/self-register.ts";

const logger = createLogger("search");

export async function boot(): Promise<void> {
  const cfg = config();
  const url = databaseUrl();

  logger.info("Applying migrations");
  await runMigrations({ url });

  const stateDir = cfg.SEARCH_STATE_DIR ?? defaultStateDir();
  const publicHosts = [cfg.SEARCH_PUBLIC_HOST];
  const { material, caFingerprint, outcome } = await ensureMaterial({ stateDir, publicHosts });
  logger.info("Identity ready", { outcome, stateDir, caFingerprint });

  const { db } = createDatabase(url);
  const store = new SearchPairingStore(db);

  const revocations = new PairingRevocations(store);
  await revocations.refresh();
  startPairingRevocationSweep({ revocations, onRevoked: () => {} });

  const api = await startSearchServer({
    material,
    store,
    revocations,
    port: cfg.SEARCH_PORT,
    publicHosts,
    devInsecure: cfg.SEARCH_DEV_INSECURE,
  });

  const admin = await startAdminServer({
    store,
    revocations,
    bearerSecret: material.bearerSecret,
    caFingerprint,
    endpoint: api.origin,
    socketPath: adminSocketPath(stateDir),
    ...(cfg.SEARCH_ADMIN_PORT === undefined ? {} : { port: cfg.SEARCH_ADMIN_PORT }),
  });

  logger.info("Search is up", {
    api: api.origin,
    adminSocket: admin.socketPath,
    adminPort: admin.port,
  });
  logger.warn("No REST surface yet — the routes land in TASK-004.");
}

if (process.argv[1]?.endsWith("index.ts")) {
  boot().catch((err: unknown) => {
    logger.error("Boot failed", err);
    process.exitCode = 1;
  });
}
