#!/usr/bin/env node
/**
 * Every runtime module, imported by plain `node` — and then asked to do the one
 * thing an import cannot prove it can do.
 *
 * **Why this exists.** The deploy image runs this repository's TypeScript under
 * plain `node` with type stripping and no bundler; every test runs it under
 * vitest, which applies CJS/ESM interop shims on the way in. Those shims make a
 * whole class of defect invisible to the 1100-test gate:
 * `import * as ipaddr from 'ipaddr.js'` is a working namespace under vitest and
 * — because `ipaddr.js` is CommonJS whose named exports `cjs-module-lexer`
 * cannot detect — a namespace with nothing on it but `default` under `node`. The
 * proof run found it the expensive way: every URL-validating write on a live
 * instance answered `400 ipaddr.isValid is not a function`, with a green suite.
 *
 * So this script is the configuration production actually uses, asserting two
 * things:
 *
 *   1. **Every runtime module imports.** That catches a bad specifier, a
 *      missing runtime dependency, TypeScript syntax Node will not strip, and
 *      any module whose *body* touches a missing interop name.
 *   2. **The probes below run.** An import says nothing about whether the names
 *      a module read off a CommonJS namespace are there, because the read
 *      happens when the function is called. One probe per defect of that class
 *      we have actually been bitten by — today that is `url-guard.ts`.
 *
 * Run it the way the runtime runs:
 *
 *   node --experimental-strip-types scripts/import-runtime-modules.mjs
 *
 * `--verbose` lists every module as it loads. The last line is always
 * `SUMMARY <json>`, which is what
 * `packages/search/src/__tests__/plain-node-imports.test.ts` reads: the suite
 * spawns this script once rather than re-walking the tree itself, so the thing
 * CI runs and the thing the suite asserts on cannot drift apart.
 */

import { readdirSync, statSync } from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(import.meta.dirname, "..");

/**
 * The packages whose modules a deployment loads under plain `node`. The SDK is
 * one of them: it is what a client imports, and its `exports` map points at
 * `src/*.ts` itself. Its `scripts/` (the npm-pack rehearsal) sits outside
 * `src` and so is never walked, like every other package's.
 */
const ROOTS = [
  "packages/search/src",
  "packages/shared/src",
  "packages/cli/src",
  "packages/sdk/src",
];

/** Test scaffolding, which the runtime never loads. */
const SKIP_DIRS = new Set(["__tests__", "__fixtures__", "testing", "node_modules", "dist"]);

/**
 * Entry points whose module *body* is the command.
 *
 * `db/migrate-cli.ts` applies the migrations when it is imported — importing it
 * here would either need a database or fail for want of one, and neither is
 * this script's question. It is already run under plain `node`, twice, by CI's
 * Boot job, which is the coverage it wants.
 */
const SKIP_FILES = new Set([path.join("packages", "search", "src", "db", "migrate-cli.ts")]);

const verbose = process.argv.includes("--verbose");

/** Every runtime module under `dir`, relative to the repo root, sorted. */
function walk(dir, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(full, found);
      continue;
    }
    if (!/\.(ts|mts)$/.test(entry.name)) continue;
    if (/\.test\.ts$/.test(entry.name) || /\.d\.ts$/.test(entry.name)) continue;
    const rel = path.relative(repoRoot, full);
    if (SKIP_FILES.has(rel)) continue;
    found.push(rel);
  }
  return found;
}

const modules = [];
for (const root of ROOTS) {
  const abs = path.join(repoRoot, root);
  if (!statSync(abs).isDirectory()) throw new Error(`${root} is not a directory`);
  walk(abs, modules);
}
modules.sort();

const failures = [];

for (const rel of modules) {
  try {
    await import(pathToFileURL(path.join(repoRoot, rel)).href);
    if (verbose) console.log(`  ok  ${rel}`);
  } catch (err) {
    const message = err instanceof Error ? err.message.split("\n")[0] : String(err);
    failures.push({ module: rel, error: message });
    console.error(`  FAIL ${rel}: ${message}`);
  }
}

/**
 * The behavioural half: a name read off a CommonJS namespace at *call* time.
 *
 * `url-guard.ts` is the one this repository has been bitten by, and the shape
 * of the probe is the shape of the defect — the guard imported fine and threw
 * on the first call, so nothing short of calling it is a check.
 */
const probes = [
  {
    name: "url-guard/validateExternalUrl",
    async run() {
      const guard = await import(
        pathToFileURL(
          path.join(repoRoot, "packages/search/src/core/security/url-guard.ts"),
        ).href
      );
      const ok = guard.validateExternalUrl("https://example.com");
      if (ok.isValid !== true) throw new Error(`a public https URL was refused: ${ok.error}`);
      const literal = guard.validateExternalUrl("https://93.184.216.34");
      if (literal.isValid !== true) {
        throw new Error(`a public IP literal was refused: ${literal.error}`);
      }
      if (guard.isPrivateOrReservedIP("127.0.0.1") !== true) {
        throw new Error("127.0.0.1 was not called private");
      }
      if (guard.isPrivateOrReservedIP("8.8.8.8") !== false) {
        throw new Error("8.8.8.8 was called private");
      }
    },
  },
];

const probesRun = [];
for (const probe of probes) {
  try {
    await probe.run();
    probesRun.push(probe.name);
    if (verbose) console.log(`  ok  probe ${probe.name}`);
  } catch (err) {
    const message = err instanceof Error ? err.message.split("\n")[0] : String(err);
    failures.push({ module: `probe:${probe.name}`, error: message });
    console.error(`  FAIL probe ${probe.name}: ${message}`);
  }
}

console.log(
  `imported ${modules.length - failures.filter((f) => !f.module.startsWith("probe:")).length}/${modules.length} runtime modules under plain node; ` +
    `${probesRun.length}/${probes.length} probes ran`,
);
console.log(`SUMMARY ${JSON.stringify({ modules, probes: probesRun, failures })}`);

if (failures.length > 0) {
  console.error(
    `\n${failures.length} module(s) or probe(s) that vitest loads happily do not work under plain ` +
      "node. That is the configuration the deploy image runs.",
  );
  process.exit(1);
}
