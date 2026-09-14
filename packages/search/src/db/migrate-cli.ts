#!/usr/bin/env node
/**
 * `pnpm db:migrate` — apply the migrations and exit.
 *
 * The same code the service runs at boot, reachable without starting the
 * service, for an operator who migrates as a separate deploy step.
 */

import { createLogger } from "@actana/search-shared/log";
import { databaseUrl } from "../config.ts";
import { runMigrations } from "./migrate.ts";

const logger = createLogger("db/migrate-cli");

runMigrations({ url: databaseUrl() })
  .then(() => {
    logger.info("Done.");
  })
  .catch((err: unknown) => {
    logger.error("Migration failed", err);
    process.exitCode = 1;
  });
