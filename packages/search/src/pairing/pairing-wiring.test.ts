// Carried from actana/control's `core-pairing-wiring.test.ts` (ADR 0008), with
// the endpoint-resolver cases rewritten for Search's one address.
import { describe, expect, it } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { PairingSession } from "@actana/search-shared/pairing/pairing-session";
import { createPairingSession } from "@actana/search-shared/pairing/pairing-session";
import type { SearchHttpRoutes } from "../api/routes.ts";
import {
  buildPairingEndpointResolver,
  composeHttpRoutes,
  isPairingPath,
  primaryPublicHost,
} from "./pairing-wiring.ts";

const req = {} as IncomingMessage;
const res = {} as ServerResponse;

function family(claims: boolean, seen: string[], name: string): SearchHttpRoutes {
  return {
    handle: () => {
      seen.push(name);
      return claims;
    },
    handleContinue: () => {
      seen.push(`${name}:continue`);
      return claims;
    },
  };
}

describe("composeHttpRoutes", () => {
  it("gives a request to the first family that claims it", () => {
    const seen: string[] = [];
    expect(composeHttpRoutes(family(true, seen, "a"), family(true, seen, "b")).handle(req, res)).toBe(true);
    expect(seen).toEqual(["a"]);
  });

  it("does not offer it to the families behind that one", () => {
    const seen: string[] = [];
    composeHttpRoutes(family(true, seen, "a"), family(true, seen, "b")).handle(req, res);
    expect(seen).not.toContain("b");
  });

  it("falls through to the next family for a path the first does not claim", () => {
    const seen: string[] = [];
    expect(composeHttpRoutes(family(false, seen, "a"), family(true, seen, "b")).handle(req, res)).toBe(true);
    expect(seen).toEqual(["a", "b"]);
  });

  it("leaves an unclaimed path unclaimed, so the server keeps its 404", () => {
    const seen: string[] = [];
    expect(composeHttpRoutes(family(false, seen, "a"), family(false, seen, "b")).handle(req, res)).toBe(false);
  });

  it("composes `handleContinue` the same way", () => {
    const seen: string[] = [];
    expect(
      composeHttpRoutes(family(false, seen, "a"), family(true, seen, "b")).handleContinue(req, res),
    ).toBe(true);
    expect(seen).toEqual(["a:continue", "b:continue"]);
  });
});

describe("isPairingPath", () => {
  it("names the redeem route and nothing else", () => {
    expect(isPairingPath("/v1/pair/redeem")).toBe(true);
    for (const pathname of [
      "/v1/pair/",
      "/v1/pair/status",
      "/v1/pair/redeem/",
      "/v1/pair/redeemer",
      "/v1/pairing/redeem",
      "/v1/kbs",
      "/",
    ]) {
      expect(isPairingPath(pathname)).toBe(false);
    }
  });
});

describe("buildPairingEndpointResolver", () => {
  const session = (overrides: Partial<PairingSession> = {}): PairingSession => ({
    ...createPairingSession({ id: "ps_1", label: "studio", codeHash: "h", now: 1 }),
    ...overrides,
  });

  it("hands back the instance's configured primary", () => {
    const resolve = buildPairingEndpointResolver({ publicHosts: ["search.internal"], port: 7443 });
    expect(resolve(session())).toBe("https://search.internal:7443");
  });

  it("brackets an IPv6 literal so the result is a URL", () => {
    const resolve = buildPairingEndpointResolver({ publicHosts: ["::1"], port: 7443 });
    expect(resolve(session())).toBe("https://[::1]:7443");
  });

  it("falls back to loopback when nothing was configured", () => {
    expect(primaryPublicHost([])).toBe("localhost");
    expect(primaryPublicHost(["  ", ""])).toBe("localhost");
  });

  it("reads nothing but its own configuration — there is nothing on the request to read", () => {
    const resolve = buildPairingEndpointResolver({ publicHosts: ["search.internal"], port: 7443 });
    // A session carrying anything at all still resolves to the configured
    // address: no caller-supplied value reaches this function, which is the
    // property `Host`-header spoofing would otherwise break.
    expect(resolve(session({ label: "https://attacker.example" }))).toBe("https://search.internal:7443");
  });
});
