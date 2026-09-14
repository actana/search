#!/usr/bin/env node
/**
 * Every `.ts` file in this repository must survive Node's type stripping.
 *
 * Node 24 runs TypeScript by *erasing* the type annotations, never by
 * compiling: there is no emit step, so any syntax that has to produce code to
 * mean something is refused outright with `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`.
 * That is a small list — constructor parameter properties (`constructor(private
 * x: T) {}`), non-`declare` `enum`, `namespace`/`module` blocks with a body,
 * and the legacy `<T>expr` cast — and every one of them type-checks cleanly, so
 * `tsc --noEmit` will never tell you about it. The first you hear is the
 * service failing to start.
 *
 * This is the check that tells you at lint time instead. It parses each file
 * exactly the way `node file.ts` would, and reports every file that would not
 * load.
 *
 * Test files are included. They run under vitest, which compiles rather than
 * strips and would not care — but a helper that is fine in a test today is a
 * helper someone imports from `src/` tomorrow, and one rule for the whole tree
 * is cheaper to keep than an exception list.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import { stripTypeScriptTypes } from "node:module";

const repoRoot = path.resolve(import.meta.dirname, "..");
const roots = ["packages"];
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "drizzle"]);

/** @returns {string[]} every `.ts` file under `dir`, recursively. */
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

const files = roots.flatMap((r) => walk(path.join(repoRoot, r))).sort();
const failures = [];

for (const file of files) {
  try {
    // `transform` mode, matching Node's own loader: the erasable subset only.
    stripTypeScriptTypes(readFileSync(file, "utf8"), { mode: "strip", sourceMap: false });
  } catch (err) {
    failures.push({ file: path.relative(repoRoot, file), message: err?.message ?? String(err) });
  }
}

if (failures.length > 0) {
  console.error(
    `\n${failures.length} file(s) use TypeScript syntax Node cannot strip:\n`,
  );
  for (const f of failures) {
    console.error(`  ${f.file}`);
    console.error(`    ${f.message.split("\n")[0]}`);
    if (process.env.GITHUB_ACTIONS) {
      console.log(`::error file=${f.file}::${f.message.split("\n")[0]}`);
    }
  }
  console.error(
    "\nNode runs this repository's TypeScript by stripping types, not by compiling it.\n" +
      "Rewrite the construct — a parameter property becomes a field and an assignment,\n" +
      "an enum becomes an `as const` object, a namespace becomes a module.\n",
  );
  process.exit(1);
}

console.log(`✓ ${files.length} TypeScript files are strippable by Node ${process.version}.`);
