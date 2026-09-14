#!/usr/bin/env node
/**
 * `actana-search` — pair with a Search instance, list knowledge bases, ingest a
 * document, run a query.
 *
 * The commands land in TASK-005. The package exists from the bootstrap so the
 * CLI is a consumer of `@actana/search` from its first line rather than a
 * second client of the core's internals.
 */

import { SEARCH_PROTOCOL_VERSION } from "@actana/search/index";

export function main(argv: readonly string[] = process.argv.slice(2)): number {
  if (argv[0] === "--version" || argv[0] === "-v") {
    process.stdout.write(`actana-search (protocol ${SEARCH_PROTOCOL_VERSION})\n`);
    return 0;
  }
  process.stderr.write(
    "actana-search: no commands yet — pair / kb / ingest / query land in TASK-005.\n",
  );
  return 1;
}

if (process.argv[1]?.endsWith("index.ts")) {
  process.exitCode = main();
}
