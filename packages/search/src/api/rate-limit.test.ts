// The per-client query limit: the refusal it raises, and the header on it.
import { afterEach, describe, expect, it } from "vitest";
import { PairingRateLimiter } from "../pairing/pairing-rate-limit.ts";
import { HttpError } from "./http.ts";
import {
  chargeQuery,
  DEFAULT_QUERY_CLIENT_WINDOW,
  DEFAULT_QUERY_GLOBAL_WINDOW,
  queryRateLimiter,
  setQueryRateLimiter,
} from "./rate-limit.ts";

afterEach(() => {
  setQueryRateLimiter(undefined);
});

describe("chargeQuery", () => {
  it("allows a client up to its limit and then refuses with 429", () => {
    setQueryRateLimiter(
      new PairingRateLimiter({ peer: { limit: 3, windowMs: 60_000 }, global: { limit: 100, windowMs: 60_000 } }),
    );
    for (let i = 0; i < 3; i++) expect(() => chargeQuery("pc_1")).not.toThrow();

    const failure = (() => {
      try {
        chargeQuery("pc_1");
        return null;
      } catch (err) {
        return err as HttpError;
      }
    })();
    expect(failure).toBeInstanceOf(HttpError);
    expect(failure).toMatchObject({ status: 429, code: "rate-limited" });
    expect(failure!.detail).toMatchObject({ scope: "peer" });
    // In seconds, rounded up, because that is what the header means.
    expect(Number(failure!.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("counts each client separately", () => {
    setQueryRateLimiter(
      new PairingRateLimiter({ peer: { limit: 1, windowMs: 60_000 }, global: { limit: 100, windowMs: 60_000 } }),
    );
    chargeQuery("pc_1");
    expect(() => chargeQuery("pc_2")).not.toThrow();
    expect(() => chargeQuery("pc_1")).toThrow(HttpError);
  });

  it("refuses on the global window too, and says which one it was", () => {
    setQueryRateLimiter(
      new PairingRateLimiter({ peer: { limit: 100, windowMs: 60_000 }, global: { limit: 2, windowMs: 60_000 } }),
    );
    chargeQuery("pc_1");
    chargeQuery("pc_2");
    try {
      chargeQuery("pc_3");
      expect.unreachable("the global window should have refused this");
    } catch (err) {
      expect((err as HttpError).detail).toMatchObject({ scope: "global" });
    }
  });
});

describe("the default windows", () => {
  it("are far above an honest caller and far below a loop", () => {
    // Ten queries a second sustained per client; a hundred across the instance.
    expect(DEFAULT_QUERY_CLIENT_WINDOW).toEqual({ limit: 600, windowMs: 60_000 });
    expect(DEFAULT_QUERY_GLOBAL_WINDOW).toEqual({ limit: 6_000, windowMs: 60_000 });
    expect(DEFAULT_QUERY_GLOBAL_WINDOW.limit).toBeGreaterThan(DEFAULT_QUERY_CLIENT_WINDOW.limit);
  });

  it("are what the lazily-built limiter uses", () => {
    const limiter = queryRateLimiter();
    expect(queryRateLimiter()).toBe(limiter);
    for (let i = 0; i < DEFAULT_QUERY_CLIENT_WINDOW.limit; i++) chargeQuery("pc_default");
    expect(() => chargeQuery("pc_default")).toThrow(HttpError);
  });
});
