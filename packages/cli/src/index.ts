#!/usr/bin/env node
/**
 * `actana-search` — the entry point, and the only file in this package that
 * knows about `process`.
 *
 * Everything else takes its side effects from `SearchCliDeps` and returns an
 * exit code (`cli.ts`), so this file is the whole of the seam: it builds the bag
 * out of the real world, runs the CLI, and sets `process.exitCode`.
 *
 * `process.exitCode` rather than `process.exit()`: a hard exit can truncate a
 * pipe that has not drained, which turns `actana-search pair new > ticket.txt`
 * into a file with half a pairing ticket in it.
 */

import * as os from "node:os";
import { readFile } from "node:fs/promises";
import { SearchClient } from "@actana/search/client";
import { pairWithSearch } from "@actana/search/pairing";
import { AdminClient } from "./admin-client.ts";
import { runSearchCli } from "./cli.ts";
import type { SearchCliDeps } from "./cli-deps.ts";

/** Read stdin to end. Only called by a verb that was told to (`--key-stdin`). */
function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
}

/** The dependency bag, built out of the real world. */
export function realDeps(argv: readonly string[] = process.argv.slice(2)): SearchCliDeps {
  const verbose = argv.includes("--verbose");
  return {
    argv: [...argv],
    env: process.env,
    home: os.homedir(),
    out: (line) => {
      process.stdout.write(`${line}\n`);
    },
    err: (line) => {
      process.stderr.write(`${line}\n`);
    },
    // On stderr, where it cannot corrupt the stdout a `--json` consumer parses.
    verbose: (line) => {
      if (verbose) process.stderr.write(`${line}\n`);
    },
    now: () => Date.now(),
    stdoutIsTty: Boolean(process.stdout.isTTY),
    readStdin,
    readFile: (path) => readFile(path),
    adminClient: (socketPath) => new AdminClient(socketPath),
    pair: (options) => pairWithSearch(options),
    clientFor: (blob) => SearchClient.fromRegistrationBlob(blob),
  };
}

/** Run, and set the exit code. */
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const code = await runSearchCli(realDeps(argv));
  process.exitCode = code;
  return code;
}

/**
 * Run when this file *is* the program — `node src/index.ts`, which is what a
 * contributor types.
 *
 * Reached through `bin/actana-search.mjs` this is false (`process.argv[1]` is
 * the shim), and the shim calls {@link main} itself. One run either way: a
 * guard that also fired for the shim would run the command twice.
 */
if (process.argv[1]?.endsWith("index.ts")) {
  void main();
}

export { runSearchCli } from "./cli.ts";
export type { SearchCliDeps } from "./cli-deps.ts";
