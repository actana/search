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
import { adminSocketPath, startAdminServer, type AdminServer } from "./api/admin-server.ts";
import { startSearchServer, type SearchServer } from "./api/server.ts";
import { registerSearchRoutes } from "./api/routes/index.ts";
import { SearchPairingStore } from "./pairing/pairing-store.ts";
import { PairingRevocations, startPairingRevocationSweep } from "./pairing/pairing-revocation.ts";
import { ensureMaterial } from "./pairing/self-register.ts";
import { assertEncryptionKeyConfigured } from "./core/security/encryption.ts";
import {
  installShutdownHandlers,
  openInOrder,
  startWorkers,
  type SearchWorkers,
} from "./worker.ts";

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

  /**
   * Steps 4, 5 and 6 — **together or not at all** (`openInOrder`).
   *
   * They used to be three awaits in a row, and a failure at step 5 left the
   * API listener from step 4 open: the process went on answering
   * `GET /v1/health` with `{"ok":true}` with no admin socket to mint a pairing
   * code on and no worker to ingest anything, and a container probe called that
   * healthy. Now a failure closes what opened, in reverse, and the rejection
   * reaches the entry point below, which exits non-zero.
   */
  let api!: SearchServer;
  let admin!: AdminServer;
  let workers: SearchWorkers | null = null;

  await openInOrder([
    {
      name: "api",
      open: async () => {
        api = await startSearchServer({
          material,
          store,
          revocations,
          port: cfg.SEARCH_PORT,
          publicHosts,
          devInsecure: cfg.SEARCH_DEV_INSECURE,
          registerRoutes: registerSearchRoutes,
        });
        return { name: "api", close: () => api.close() };
      },
    },
    {
      name: "admin",
      open: async () => {
        admin = await startAdminServer({
          store,
          revocations,
          bearerSecret: material.bearerSecret,
          caFingerprint,
          endpoint: api.origin,
          socketPath: adminSocketPath(stateDir),
          ...(cfg.SEARCH_ADMIN_PORT === undefined ? {} : { port: cfg.SEARCH_ADMIN_PORT }),
        });
        return { name: "admin", close: () => admin.close() };
      },
    },
    {
      name: "workers",
      open: async () => {
        if (workersOff) return null;
        workers = await startWorkers();
        return { name: "workers", close: () => workers!.close() };
      },
    },
  ]);

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
    /**
     * `process.exit`, not `process.exitCode`.
     *
     * Setting the code and returning asks the event loop to run dry, and a
     * half-finished boot is precisely the state where it does not: a listener
     * that opened before the failing step keeps the process alive, with the
     * exit code set and nobody to read it. That is what the proof run saw — a
     * logged `Boot failed` beside a process still answering
     * `GET /v1/health`. `openInOrder` closes the listeners first, so by here
     * there is nothing to drain and nothing to wait for.
     */
    process.exit(1);
  });
}
