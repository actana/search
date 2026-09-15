/**
 * The gate vitest cannot be fooled into passing.
 *
 * **The defect this exists for.** `core/security/url-guard.ts` imported
 * `ipaddr.js` — a CommonJS package whose named exports `cjs-module-lexer`
 * cannot detect — as a namespace (`import * as ipaddr`). vitest transforms
 * every module it loads and applies CJS/ESM interop shims on the way in, so
 * `ipaddr.isValid` resolved in this suite and was `undefined` under plain
 * `node`, which is what the deploy image runs. The result was a 1057-test green
 * run beside a live instance answering `400 ipaddr.isValid is not a function`
 * to `PUT /v1/endpoints`, `PUT /v1/webhooks` and every URL ingest.
 *
 * So no assertion in this file may be made *in this process*: everything here
 * is a judgement about a child `node`, spawned the way
 * `__tests__/deploy-healthcheck.test.ts` spawns the container probe, with
 * `--experimental-strip-types` because that is how the service is run
 * (`package.json`'s `start`, the Dockerfile, `pnpm dev`). A test that imported
 * `url-guard.ts` directly would be green on the broken code, which is the whole
 * point.
 *
 * **One child process.** The walking, importing and probing all live in
 * `scripts/import-runtime-modules.mjs` — the same script CI's Boot job runs —
 * and this suite reads the `SUMMARY` line it prints. Two reasons: the run costs
 * about a second, and the thing CI gates on and the thing this suite asserts on
 * cannot drift apart.
 *
 * @vitest-environment node
 */
import { spawn } from "node:child_process";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const SCRIPT = path.join(REPO_ROOT, "scripts", "import-runtime-modules.mjs");

type Summary = {
  /** Every runtime module the walk found, repo-relative. */
  modules: string[];
  /** The behavioural probes that ran to completion. */
  probes: string[];
  /** One entry per module that would not import, or probe that threw. */
  failures: Array<{ module: string; error: string }>;
};

type Run = { code: number | null; stdout: string; stderr: string; summary: Summary };

/**
 * The script, under plain `node` with type stripping and no loader.
 *
 * The environment is deliberately minimal: `SEARCH_*` variables from the
 * developer's shell must not decide whether a module loads, and none of these
 * modules may need one to be importable — `config.ts` is lazy on purpose and
 * this is the check that it stays that way.
 */
function runWalker(): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", SCRIPT], {
      cwd: REPO_ROOT,
      env: { PATH: process.env.PATH ?? "", NODE_ENV: "production" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => {
      const line = stdout.split("\n").find((l) => l.startsWith("SUMMARY "));
      if (!line) {
        reject(new Error(`the walker printed no SUMMARY line.\n${stdout}\n${stderr}`));
        return;
      }
      resolve({ code, stdout, stderr, summary: JSON.parse(line.slice("SUMMARY ".length)) as Summary });
    });
  });
}

describe("every runtime module loads under plain node", () => {
  /**
   * One run for the whole file. The walk imports 166 modules in about a second
   * and there is nothing a second run could tell us that the first did not.
   */
  let run: Run;

  beforeAll(async () => {
    run = await runWalker();
  }, 120_000);

  it("imports every one of them, and reports any that vitest alone can load", () => {
    // The message carries the failures: the whole value of this test is what it
    // says when it is red.
    expect(
      run.summary.failures.map((f) => `${f.module}: ${f.error}`),
      "modules or probes that vitest loads happily but plain node does not",
    ).toEqual([]);
    expect(run.code).toBe(0);
    expect(run.stderr).toBe("");
  });

  /**
   * A walk that quietly stopped finding modules would be a green gate over
   * nothing, so the coverage is asserted rather than assumed: all four
   * packages, and the file the defect was in.
   */
  it("covers all four runtime packages", () => {
    const { modules } = run.summary;
    expect(modules.length).toBeGreaterThan(150);
    for (const root of [
      "packages/search/src/",
      "packages/shared/src/",
      "packages/cli/src/",
      "packages/sdk/src/",
    ]) {
      expect(modules.filter((m) => m.startsWith(root)).length).toBeGreaterThan(5);
    }
    expect(modules).toContain("packages/search/src/core/security/url-guard.ts");
    expect(modules).toContain("packages/search/src/index.ts");
    expect(modules).toContain("packages/search/src/worker.ts");
    expect(modules).toContain("packages/sdk/src/index.ts");
  });

  /** Test scaffolding is not what a deployment loads, and must not be walked. */
  it("walks no test file, fixture or test-only helper", () => {
    for (const m of run.summary.modules) {
      expect(m).not.toMatch(/\.test\.ts$/);
      expect(m).not.toMatch(/(^|\/)(__tests__|__fixtures__|testing)\//);
    }
  });

  /**
   * The behavioural half, named.
   *
   * Importing `url-guard.ts` never failed — the namespace import resolved and
   * the throw came at the first *call*. So the probe that has to be in the
   * summary is the one that calls it.
   */
  it("ran the url-guard call probe, which is the one an import cannot make", () => {
    expect(run.summary.probes).toContain("url-guard/validateExternalUrl");
  });
});
