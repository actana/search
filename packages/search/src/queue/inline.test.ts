/**
 * `SEARCH_INLINE_JOBS` refuses to be a deployment.
 *
 * The README, ADR and TASK-004's own notes all said this mode "refuses to run
 * outside a test" — and nothing checked: `inlineJobsEnabled` read the variable
 * and answered. So a deployment with it set ran its whole ingestion pipeline
 * inside the API process, which looks like it is working right up until the
 * process is restarted mid-document.
 *
 * Two refusals, because there are two ways in: reading the configuration
 * (`config()`, which every process does while starting) and asking the queue
 * for its backend (`inlineJobsEnabled`, which is where the swap happens).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { config, inATestEnvironment, resetConfig } from "../config.ts";
import { INLINE_JOBS_VAR, inlineJobsEnabled } from "./inline.ts";

afterEach(() => {
  vi.unstubAllEnvs();
  resetConfig();
});

describe("inlineJobsEnabled", () => {
  it("is on under NODE_ENV=test", () => {
    expect(inlineJobsEnabled({ SEARCH_INLINE_JOBS: "1", NODE_ENV: "test" })).toBe(true);
  });

  it("is on when the integration suites' database variable is set", () => {
    expect(
      inlineJobsEnabled({
        SEARCH_INLINE_JOBS: "true",
        SEARCH_TEST_DATABASE_URL: "postgres://x",
      }),
    ).toBe(true);
  });

  it("is off when the variable says nothing, wherever it is", () => {
    expect(inlineJobsEnabled({})).toBe(false);
    expect(inlineJobsEnabled({ SEARCH_INLINE_JOBS: "" })).toBe(false);
    expect(inlineJobsEnabled({ SEARCH_INLINE_JOBS: "0", NODE_ENV: "production" })).toBe(false);
  });

  it("throws outside a test environment rather than answering", () => {
    // Not `false`: the variable being set there at all is the mistake, and
    // quietly handing back the Redis queue leaves it in place.
    for (const env of [{}, { NODE_ENV: "" }, { NODE_ENV: "production" }, { NODE_ENV: "staging" }]) {
      expect(() => inlineJobsEnabled({ ...env, SEARCH_INLINE_JOBS: "1" })).toThrowError(
        new RegExp(`${INLINE_JOBS_VAR} is set outside a test environment`),
      );
    }
  });
});

describe("the configuration", () => {
  it("carries the variable, so it is declared rather than read off `process.env`", () => {
    vi.stubEnv("SEARCH_INLINE_JOBS", "1");
    vi.stubEnv("NODE_ENV", "test");
    resetConfig();
    expect(config().SEARCH_INLINE_JOBS).toBe(true);
  });

  it("defaults to off", () => {
    vi.stubEnv("SEARCH_INLINE_JOBS", "");
    resetConfig();
    expect(config().SEARCH_INLINE_JOBS).toBe(false);
  });

  it("refuses to parse at all outside a test environment, naming what the mode does", () => {
    vi.stubEnv("SEARCH_INLINE_JOBS", "1");
    vi.stubEnv("NODE_ENV", "");
    vi.stubEnv("SEARCH_TEST_DATABASE_URL", "");
    resetConfig();
    expect(() => config()).toThrowError(
      /SEARCH_INLINE_JOBS is set outside a test environment[\s\S]*inside this process/,
    );
  });
});

describe("inATestEnvironment", () => {
  it("is the one answer both test-only modes ask for", () => {
    expect(inATestEnvironment({ NODE_ENV: "test" })).toBe(true);
    expect(inATestEnvironment({ SEARCH_TEST_DATABASE_URL: "postgres://x" })).toBe(true);
    expect(inATestEnvironment({})).toBe(false);
    expect(inATestEnvironment({ NODE_ENV: "production" })).toBe(false);
  });
});
