#!/usr/bin/env node
// `pnpm test` — every package suite, every time, and a report that names what
// failed.
//
// `pnpm -r test` is deliberately not used: it bails on the first failing
// package and hides the rest, which turns "one package is red" into "the run
// is red" with no way to see how much else is broken without re-running it
// package by package. This driver runs every stage to completion, aggregates
// the exit codes, and only then decides the run's own code.
//
// The one thing it must never do is exit zero while a stage was red.

import { spawnSync } from "node:child_process";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");

/** The suites, in the order a reader would want them reported. */
const STAGES = [
  { name: "@actana/search-shared", filter: "@actana/search-shared" },
  { name: "@actana/search-core", filter: "@actana/search-core" },
  { name: "@actana/search", filter: "@actana/search" },
  { name: "@actana/search-cli", filter: "@actana/search-cli" },
];

const results = [];

for (const stage of STAGES) {
  console.log(`\n── ${stage.name} ──`);
  const run = spawnSync(
    "pnpm",
    ["--filter", stage.filter, "--if-present", "test"],
    { cwd: repoRoot, stdio: "inherit", env: process.env },
  );
  results.push({ ...stage, code: run.status ?? 1 });
}

const failed = results.filter((r) => r.code !== 0);

console.log("\n── summary ──");
for (const r of results) {
  console.log(`${r.code === 0 ? "✓" : "✗"} ${r.name}`);
}

if (failed.length > 0) {
  const names = failed.map((r) => r.name).join(", ");
  if (process.env.GITHUB_ACTIONS) {
    console.log(`::error title=Unit Tests::Red suites: ${names}`);
  }
  console.error(`\n${failed.length} suite(s) failed: ${names}`);
  process.exit(1);
}

console.log("\nAll suites passed.");
