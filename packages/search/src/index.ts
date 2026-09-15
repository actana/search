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
 *   6. **The ingestion workers**, unless `SEARCH_WORKERS=off` — or
 *      `SEARCH_INLINE_JOBS=1`, which is the test-only in-process runner.
 *
 * The `/v1` REST surface is mounted at step 4 through `registerRoutes`
 * (`api/routes/index.ts`).
 *
 * **One process by default, two when a deployment wants two** (ADR 0010).
 * `pnpm dev` and the compose service run the API and the worker together,
 * because a single container that ingests what it is given is what "run Search"
 * should mean. A deployment that wants them apart runs `start:api` with
 * `SEARCH_WORKERS=off` beside any number of `start:worker` processes; they share
 * a Redis and a queue prefix and nothing else changes.
 */

import { createLogger } from "@actana/search-shared/log";
import { defaultStateDir } from "@actana/search-shared/pairing/material-store";
import { config, databaseUrl } from "./config.ts";
import { createDatabase } from "./db/client.ts";
import { runMigrations } from "./db/migrate.ts";
import { adminSocketPath, startAdminServer } from "./api/admin-server.ts";
import { startSearchServer } from "./api/server.ts";
import { registerSearchRoutes } from "./api/routes/index.ts";
import { SearchPairingStore } from "./pairing/pairing-store.ts";
import { PairingRevocations, startPairingRevocationSweep } from "./pairing/pairing-revocation.ts";
import { ensureMaterial } from "./pairing/self-register.ts";
import { assertEncryptionKeyConfigured } from "./core/security/encryption.ts";
import { installShutdownHandlers, startWorkers } from "./worker.ts";

const logger = createLogger("search");

export async function boot(): Promise<void> {
  const cfg = config();
  const url = databaseUrl();

  /**
   * The sealing key, before anything else is touched.
   *
   * It was checked nowhere: `encryption.ts` threw at the first *use*, which is
   * the first `PUT /v1/endpoints` or the first job that needs a mirrored key —
   * so an instance with no `SEARCH_ENCRYPTION_KEY` paired, served health, and
   * reported a cipher error hours later to whoever happened to be adding an
   * endpoint. It is required in both modes (ADR 0010 D7): standalone it seals
   * the provider keys, wired it seals the resolver credential that fetches them.
   */
  assertEncryptionKeyConfigured();

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
    registerRoutes: registerSearchRoutes,
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

  /**
   * The workers, in this process unless a deployment has split them out.
   *
   * `SEARCH_WORKERS=off` is read straight from the environment rather than
   * through the config schema: it is a deployment shape, not a tuning knob, and
   * the only two things that ever set it are `start:api` and a compose file.
   *
   * `SEARCH_INLINE_JOBS` turns them off as well, and that one is not a shape —
   * it is the test-only mode that runs the jobs inside the enqueue
   * (`queue/inline.ts`), refused outside a test by `config()` itself. Starting
   * a BullMQ worker beside it would mean the fixture suites needed a Redis to
   * boot a server, which is exactly what that mode exists to avoid, and the two
   * runners would then race for the same job.
   */
  const workersOff =
    cfg.SEARCH_INLINE_JOBS || /^(off|0|false|no)$/i.test(process.env.SEARCH_WORKERS ?? "");
  const workers = workersOff ? null : await startWorkers();

  /**
   * One set of handlers for everything this process owns.
   *
   * It used to install them only when the workers were in this process, and
   * only over the workers: a SIGTERM drained the queue and then called
   * `process.exit(0)` with the API listener and the admin socket still open, so
   * an in-flight request was cut mid-response and `admin.sock` was left behind
   * for the next boot. With `SEARCH_WORKERS=off` there were no handlers at all.
   * Now: drain the worker if there is one, then close the API, then the admin
   * listener (which unlinks its socket), then exit.
   */
  installShutdownHandlers(workers, [
    { name: "api", close: () => api.close() },
    { name: "admin", close: () => admin.close() },
  ]);

  logger.info("Search is up", {
    api: api.origin,
    adminSocket: admin.socketPath,
    adminPort: admin.port,
    workers: cfg.SEARCH_INLINE_JOBS
      ? "off (SEARCH_INLINE_JOBS=1 — the jobs run in the enqueue)"
      : workersOff
        ? "off (SEARCH_WORKERS=off)"
        : "in this process",
  });
}

if (process.argv[1]?.endsWith("index.ts")) {
  boot().catch((err: unknown) => {
    logger.error("Boot failed", err);
    process.exitCode = 1;
  });
}
