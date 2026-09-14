/**
 * The core's entry point: apply the migrations, then serve.
 *
 * The HTTPS listener and its routes land in TASK-004, the workers and the
 * endpoint sources in TASK-005, and the pairing handshake in TASK-006. What
 * runs today is the half that already has to be right before any of them: the
 * schema.
 */

import { createLogger } from "@actana/search-shared/log";
import { config, databaseUrl } from "./config.ts";
import { runMigrations } from "./db/migrate.ts";

const logger = createLogger("search");

export async function boot(): Promise<void> {
  const cfg = config();
  logger.info("Applying migrations");
  await runMigrations({ url: databaseUrl() });
  logger.info("Migrations applied", { port: cfg.SEARCH_PORT });
  logger.warn("No listener yet — the API lands in TASK-004.");
}

if (process.argv[1]?.endsWith("index.ts")) {
  boot().catch((err: unknown) => {
    logger.error("Boot failed", err);
    process.exitCode = 1;
  });
}
