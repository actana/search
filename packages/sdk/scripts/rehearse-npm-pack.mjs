#!/usr/bin/env node
// Rehearse the publish: pack the tarball npm would, install it into a throwaway
// Node project, and import it there.
//
// **What this catches that `pnpm typecheck` cannot.** Inside the workspace this
// package is consumed as TypeScript source and its relative imports carry
// `.ts`. A registry consumer gets `dist/`, resolved through the `publishConfig`
// exports map, with no type stripping and no bundler. Four things can be wrong
// at once there and green here: a missing `dist` file, an export the map does
// not name, a `.ts` specifier `rewriteRelativeImportExtensions` did not rewrite,
// and a runtime dependency that is only a devDependency.
//
// So the rehearsal is a real `npm pack` and a real `npm install <tarball>` in a
// temporary directory, followed by importing every entry point the map
// promises. It leaves nothing behind.
//
// **It packs from a staging copy, and that is not an optimisation.** `npm
// publish` folds `publishConfig`'s manifest overrides — `exports` among them —
// into the manifest it uploads; `npm pack` does not. A rehearsal that packed
// this directory as it stands would install a package whose `exports` still
// point at `./src/*.ts`, which is not the package anybody will install. So the
// fold is done here, by hand, over the same field list npm overrides, and the
// tarball is built from the result.
//
//   node scripts/rehearse-npm-pack.mjs
//
// `npm` rather than `pnpm` on purpose: what is being rehearsed is what someone
// outside this repository does, and that is npm's resolution of npm's tarball.

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const packageDir = path.resolve(import.meta.dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf8"));

/** Every entry point the published exports map promises, as a consumer names it. */
const ENTRY_POINTS = [
  pkg.name,
  `${pkg.name}/client`,
  `${pkg.name}/pairing`,
  `${pkg.name}/pairing-wire`,
  `${pkg.name}/pairing-csr`,
  `${pkg.name}/registration-blob`,
  `${pkg.name}/errors`,
];

/** The named exports the rehearsal insists are actually there. */
const MUST_EXPORT = {
  [pkg.name]: ["SearchClient", "SearchApiError", "pairWithSearch", "SEARCH_PROTOCOL_VERSION"],
  [`${pkg.name}/client`]: ["SearchClient"],
  [`${pkg.name}/pairing`]: ["pairWithSearch", "SearchPairingError"],
  [`${pkg.name}/pairing-wire`]: ["SEARCH_PAIRING_REDEEM_PATH"],
  [`${pkg.name}/pairing-csr`]: ["generateClientCsr"],
  [`${pkg.name}/registration-blob`]: ["decodeRegistrationBlob", "encodeRegistrationBlob"],
  [`${pkg.name}/errors`]: ["SearchApiError"],
};

/** The manifest fields `npm publish` lets `publishConfig` override. */
const OVERRIDABLE = [
  "bin",
  "browser",
  "exports",
  "imports",
  "main",
  "module",
  "types",
  "typings",
];

/**
 * The manifest npm would upload: this one, with `publishConfig` folded in.
 *
 * `scripts` goes, and `devDependencies` with it. The staging directory holds a
 * built `dist` and nothing else, so a `prepack` that shells out to `tsc` would
 * run in a directory with no TypeScript and no source — and the build has
 * already happened, a step above.
 */
function publishedManifest(manifest) {
  const published = { ...manifest };
  for (const field of OVERRIDABLE) {
    if (manifest.publishConfig?.[field] !== undefined) published[field] = manifest.publishConfig[field];
  }
  delete published.scripts;
  delete published.devDependencies;
  return published;
}

const run = (cmd, args, cwd) =>
  execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "actana-search-pack-"));
let failed = false;
try {
  console.log(`▸ building ${pkg.name}@${pkg.version}`);
  run("npm", ["run", "build"], packageDir);

  console.log("▸ staging the manifest npm would publish");
  const staging = path.join(temp, "staged");
  fs.mkdirSync(staging);
  fs.writeFileSync(
    path.join(staging, "package.json"),
    JSON.stringify(publishedManifest(pkg), null, 2),
  );
  for (const file of ["dist", "README.md", "LICENSE"]) {
    const from = path.join(packageDir, file);
    if (fs.existsSync(from)) fs.cpSync(from, path.join(staging, file), { recursive: true });
  }

  console.log("▸ packing");
  const packed = run("npm", ["pack", "--pack-destination", temp], staging).trim().split("\n").pop();
  const tarball = path.join(temp, packed);
  console.log(`  ${packed} (${(fs.statSync(tarball).size / 1024).toFixed(0)} KB)`);

  const project = path.join(temp, "consumer");
  fs.mkdirSync(project);
  fs.writeFileSync(
    path.join(project, "package.json"),
    JSON.stringify({ name: "pack-rehearsal", private: true, version: "0.0.0", type: "module" }, null, 2),
  );

  console.log("▸ installing the tarball into a plain Node project");
  run("npm", ["install", "--no-audit", "--no-fund", tarball], project);

  const probe = ENTRY_POINTS.map(
    (entry) => `
{
  const mod = await import(${JSON.stringify(entry)});
  for (const name of ${JSON.stringify(MUST_EXPORT[entry])}) {
    if (!(name in mod)) throw new Error(${JSON.stringify(entry)} + " does not export " + name);
  }
  console.log("  ✓ " + ${JSON.stringify(entry)});
}`,
  ).join("\n");

  fs.writeFileSync(
    path.join(project, "probe.mjs"),
    `${probe}\n// The client has to be constructible from a blob, not merely importable.\n` +
      `import { SearchClient } from ${JSON.stringify(pkg.name)};\n` +
      `if (typeof SearchClient.fromRegistrationBlob !== "function") {\n` +
      `  throw new Error("SearchClient.fromRegistrationBlob is missing from the tarball");\n}\n` +
      `console.log("  ✓ SearchClient.fromRegistrationBlob");\n`,
  );

  console.log("▸ importing every entry point");
  console.log(run("node", ["probe.mjs"], project).trimEnd());
  console.log(`\n${pkg.name}@${pkg.version} installs and imports from a tarball.`);
} catch (err) {
  failed = true;
  console.error(`\nThe pack rehearsal failed: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);
