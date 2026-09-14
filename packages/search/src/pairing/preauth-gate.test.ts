// The one hole in the mTLS wall, asserted as a rule rather than as a route
// (ADR 0034 D2). Carried from actana/control's `core-preauth-gate.test.ts`,
// name for name (ADR 0008), plus the case Search's narrower predicate adds.
// The end-to-end proof that a real server behaves this way is in
// `__tests__/pairing.e2e.test.ts`; this is the rule that server applies.
import { describe, expect, it } from "vitest";
import {
  clientCertGate,
  upgradeGate,
  rejectUnauthorizedAtHandshake,
} from "./preauth-gate.ts";
import { isOpenPath, isPairingPath } from "./pairing-wiring.ts";

describe("clientCertGate", () => {
  it("serves anything to a connection that presented a verified certificate", () => {
    expect(clientCertGate({ pathname: "/v1/projects/p1/files", authorized: true })).toBe("serve");
    expect(clientCertGate({ pathname: "/v1/pair/redeem", authorized: true, isPreAuthPath: isPairingPath })).toBe(
      "serve",
    );
  });

  it("serves the pairing path to a connection that presented none", () => {
    expect(clientCertGate({ pathname: "/v1/pair/redeem", authorized: false, isPreAuthPath: isPairingPath })).toBe(
      "serve",
    );
  });

  it("refuses every other path to that connection", () => {
    for (const pathname of ["/v1/projects/p1/files", "/v1/projects/p1/files/list", "/healthz", "/"]) {
      expect(clientCertGate({ pathname, authorized: false, isPreAuthPath: isPairingPath })).toBe("refuse");
    }
  });

  it("refuses everything when no pre-auth surface is configured", () => {
    // A gate whose safety depends on a TLS flag set somewhere else is not a
    // gate. This is the answer even where it is unreachable.
    expect(clientCertGate({ pathname: "/v1/pair/redeem", authorized: false })).toBe("refuse");
  });

  it("is not fooled by a path that merely starts like the pairing prefix", () => {
    expect(
      clientCertGate({ pathname: "/v1/pairing-secrets", authorized: false, isPreAuthPath: isPairingPath }),
    ).toBe("refuse");
  });
});

describe("upgradeGate", () => {
  it("has no pairing exception at all", () => {
    // No pairing exception reaches an upgrade, ever — which is why an upgrade
    // that appears later cannot inherit the hole by accident.
    expect(upgradeGate(true)).toBe("serve");
    expect(upgradeGate(false)).toBe("refuse");
  });
});

describe("rejectUnauthorizedAtHandshake", () => {
  it("keeps the TLS refusal for an instance that mounts no pre-auth surface", () => {
    // The relaxation is scoped to the instances that mount the endpoint; an
    // instance with no pairing surface behaves as it did before it existed.
    expect(rejectUnauthorizedAtHandshake(undefined)).toBe(true);
  });

  it("relaxes it only where a pre-auth surface exists", () => {
    expect(rejectUnauthorizedAtHandshake(isPairingPath)).toBe(false);
  });
});

// ── What Search adds to Control's set ──
//
// Control's predicate names the `/v1/pair/` prefix because every route under it
// is the redeem route. Search puts `GET /v1/pair/status` under the same prefix
// and that one is authenticated, so the predicate is an exact path. A prefix
// here would have widened the pre-auth hole by one route without anybody
// deciding to — the thing ADR 0034 D2 exists to prevent.
describe("the pre-auth hole is exactly one route wide", () => {
  it("names the redeem path and nothing else under the pairing prefix", () => {
    expect(isPairingPath("/v1/pair/redeem")).toBe(true);
    expect(isPairingPath("/v1/pair/status")).toBe(false);
    expect(isPairingPath("/v1/pair/")).toBe(false);
    expect(isPairingPath("/v1/pair/redeem/extra")).toBe(false);
    expect(isPairingPath("/v1/pairing/redeem")).toBe(false);
  });

  it("refuses `/v1/pair/status` to a connection that presented no certificate", () => {
    expect(
      clientCertGate({ pathname: "/v1/pair/status", authorized: false, isPreAuthPath: isPairingPath }),
    ).toBe("refuse");
  });
});

// ── The set of paths that answer without a certificate ──
//
// Two, and both are named here so that a third cannot be added without editing
// a test that says what the set is. `isPairingPath` is the pre-auth surface and
// is one route wide; `isOpenPath` is the wider question the server's gate asks,
// and the difference between them is `/v1/health`, which grants nothing.
describe("the open set", () => {
  it("is the redeem route and the health route, and nothing else", () => {
    const open = ["/v1/pair/redeem", "/v1/health"];
    for (const pathname of open) expect(isOpenPath(pathname)).toBe(true);
    for (const pathname of [
      "/v1/pair/status",
      "/v1/capabilities",
      "/v1/kbs",
      "/v1/health/details",
      "/health",
      "/",
    ]) {
      expect(isOpenPath(pathname)).toBe(false);
    }
  });

  it("keeps health out of the pre-auth surface, which still grants a certificate", () => {
    expect(isPairingPath("/v1/health")).toBe(false);
    expect(isOpenPath("/v1/pair/redeem")).toBe(true);
  });

  it("serves both to a connection with no certificate, through the gate", () => {
    for (const pathname of ["/v1/pair/redeem", "/v1/health"]) {
      expect(clientCertGate({ pathname, authorized: false, isPreAuthPath: isOpenPath })).toBe("serve");
    }
    expect(
      clientCertGate({ pathname: "/v1/capabilities", authorized: false, isPreAuthPath: isOpenPath }),
    ).toBe("refuse");
  });
});
