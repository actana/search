// The one variable that turns the mTLS wall off, and what it takes to set it.
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEV_INSECURE_VAR, inATestEnvironment, startSearchServer } from "./server.ts";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("SEARCH_DEV_INSECURE", () => {
  it("is allowed under NODE_ENV=test", () => {
    expect(inATestEnvironment({ NODE_ENV: "test" })).toBe(true);
  });

  it("is allowed when the integration suites' database variable is set", () => {
    expect(inATestEnvironment({ SEARCH_TEST_DATABASE_URL: "postgres://x" })).toBe(true);
  });

  it("is refused when NODE_ENV says nothing at all", () => {
    // The case the first version got wrong: refusing only `production` made an
    // unset NODE_ENV — a bare `node src/index.ts`, a container that drops it —
    // a place where one variable makes a header an identity.
    expect(inATestEnvironment({})).toBe(false);
    expect(inATestEnvironment({ NODE_ENV: "" })).toBe(false);
  });

  it("is refused in production and in staging alike", () => {
    expect(inATestEnvironment({ NODE_ENV: "production" })).toBe(false);
    expect(inATestEnvironment({ NODE_ENV: "staging" })).toBe(false);
    expect(inATestEnvironment({ NODE_ENV: "development" })).toBe(false);
  });

  it("refuses to start the server outside a test, naming what it would have done", async () => {
    vi.stubEnv("NODE_ENV", "");
    vi.stubEnv("SEARCH_TEST_DATABASE_URL", "");
    await expect(
      startSearchServer({
        // Nothing below is reached: the refusal is the first statement.
        material: {} as never,
        store: {} as never,
        revocations: {} as never,
        port: 0,
        publicHosts: ["localhost"],
        devInsecure: true,
      }),
    ).rejects.toThrowError(new RegExp(`${DEV_INSECURE_VAR} is set outside a test environment`));
  });
});
