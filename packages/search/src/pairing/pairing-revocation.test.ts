// Carried from actana/control's `core-pairing-revocation.test.ts` (ADR 0008),
// with the unreadable-file cases rewritten as an unreadable database — the
// same fail-closed rule (ADR 0034 D10) over a different store.
import { describe, expect, it, vi } from "vitest";
import { clientCertGate, upgradeGate } from "./preauth-gate.ts";
import { isPairingPath } from "./pairing-wiring.ts";
import {
  certSerialFromBearerSubject,
  normaliseCertSerial,
  PairingRevocations,
  pairingBearerSubject,
  startPairingRevocationSweep,
  type RevokedClientsPort,
} from "./pairing-revocation.ts";

/** A store that answers with a list, or throws — the two moods that matter. */
function store(initial: string[] | Error): RevokedClientsPort & { set(next: string[] | Error): void } {
  let state: string[] | Error = initial;
  return {
    set: (next) => {
      state = next;
    },
    revokedCertSerials: async () => {
      if (state instanceof Error) throw state;
      return state;
    },
  };
}

describe("the bearer subject a pairing speaks for", () => {
  it("round-trips", () => {
    expect(certSerialFromBearerSubject(pairingBearerSubject("0a1b"))).toBe("0a1b");
  });

  it("reads a bearer with no pairing subject as naming no pairing", () => {
    expect(certSerialFromBearerSubject(undefined)).toBeNull();
    expect(certSerialFromBearerSubject("something-else")).toBeNull();
    expect(certSerialFromBearerSubject("pair:")).toBeNull();
  });
});

describe("one spelling of a serial", () => {
  it("folds case, separators and leading zeros", () => {
    expect(normaliseCertSerial("0a:1b")).toBe("A1B");
    expect(normaliseCertSerial("00A1B")).toBe("A1B");
    expect(normaliseCertSerial("a1b")).toBe("A1B");
  });

  it("does not fold a serial away to nothing", () => {
    expect(normaliseCertSerial("00")).toBe("0");
  });
});

describe("the revoked set", () => {
  it("is empty until something is revoked", async () => {
    const revocations = new PairingRevocations(store([]));
    await revocations.refresh();
    expect(revocations.isRevoked("0a1b")).toBe(false);
  });

  it("holds a serial once its row is stamped", async () => {
    const revocations = new PairingRevocations(store(["0a1b"]));
    await revocations.refresh();
    expect(revocations.isRevoked("0a1b")).toBe(true);
  });

  it("matches however the serial is spelled", async () => {
    const revocations = new PairingRevocations(store(["0a1b"]));
    await revocations.refresh();
    expect(revocations.isRevoked("0A:1B")).toBe(true);
    expect(revocations.isRevoked("00A1B")).toBe(true);
  });

  it("reports each serial once, so a sweep acts on it once", async () => {
    const backing = store(["0a1b"]);
    const revocations = new PairingRevocations(backing);
    expect(await revocations.refresh()).toEqual({ ok: true, revoked: ["0a1b"] });
    expect(await revocations.refresh()).toEqual({ ok: true, revoked: [] });
  });

  it("finds a pairing revoked through its bearer's subject", async () => {
    const revocations = new PairingRevocations(store(["0a1b"]));
    await revocations.refresh();
    expect(revocations.isBearerSubjectRevoked(pairingBearerSubject("0a1b"))).toBe(true);
  });

  it("revokes everything when the store cannot be read", async () => {
    const revocations = new PairingRevocations(store(new Error("connection refused")));
    const result = await revocations.refresh();
    expect(result.ok).toBe(false);
    expect(revocations.isFailClosed()).toBe(true);
    expect(revocations.isRevoked("a-serial-nobody-revoked")).toBe(true);
  });

  it("fails closed at boot, where there is no last time to fall back on", async () => {
    const revocations = new PairingRevocations(store(new Error("no such table")));
    expect(revocations.isRevoked("0a1b")).toBe(false); // nothing asked yet
    await revocations.refresh();
    expect(revocations.isRevoked("0a1b")).toBe(true);
  });

  it("stops failing closed once the store is readable again", async () => {
    const backing = store(new Error("down"));
    const revocations = new PairingRevocations(backing);
    await revocations.refresh();
    expect(revocations.isFailClosed()).toBe(true);
    backing.set([]);
    await revocations.refresh();
    expect(revocations.isFailClosed()).toBe(false);
    expect(revocations.isRevoked("0a1b")).toBe(false);
  });

  it("leaves a bearer that names no pairing alone, even while failing closed", async () => {
    const revocations = new PairingRevocations(store(new Error("down")));
    await revocations.refresh();
    expect(revocations.isBearerSubjectRevoked("not-a-pairing-subject")).toBe(false);
  });

  it("says nothing about a connection with no certificate at all", async () => {
    const revocations = new PairingRevocations(store(new Error("down")));
    await revocations.refresh();
    // The pre-auth route is the door out of an unreadable store; answering
    // `true` here would close it.
    expect(revocations.isRevoked(null)).toBe(false);
    expect(revocations.isRevoked(undefined)).toBe(false);
  });
});

describe("the sweep", () => {
  it("seeds the set at boot without reporting anything to close", async () => {
    const revocations = new PairingRevocations(store(["0a1b"]));
    const onRevoked = vi.fn();
    const sweep = startPairingRevocationSweep({ revocations, onRevoked, intervalMs: 5 });
    await vi.waitFor(() => expect(revocations.isRevoked("0a1b")).toBe(true));
    expect(onRevoked).not.toHaveBeenCalled();
    sweep.stop();
  });

  it("reports a revocation that lands under a running service", async () => {
    const backing = store([]);
    const revocations = new PairingRevocations(backing);
    const onRevoked = vi.fn();
    const sweep = startPairingRevocationSweep({ revocations, onRevoked, intervalMs: 5 });
    backing.set(["0a1b"]);
    await vi.waitFor(() => expect(onRevoked).toHaveBeenCalled());
    expect(revocations.isRevoked("0a1b")).toBe(true);
    sweep.stop();
  });

  it("calls back when the store becomes unreadable, and only on the crossing", async () => {
    const backing = store([]);
    const revocations = new PairingRevocations(backing);
    const onRevoked = vi.fn();
    const sweep = startPairingRevocationSweep({ revocations, onRevoked, intervalMs: 5 });
    backing.set(new Error("down"));
    await vi.waitFor(() => expect(onRevoked).toHaveBeenCalledTimes(1));
    const after = onRevoked.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(onRevoked.mock.calls.length).toBe(after);
    sweep.stop();
  });

  it("stops when the service does", async () => {
    const backing = store([]);
    const revocations = new PairingRevocations(backing);
    const onRevoked = vi.fn();
    const sweep = startPairingRevocationSweep({ revocations, onRevoked, intervalMs: 5 });
    await new Promise((resolve) => setTimeout(resolve, 15));
    sweep.stop();
    backing.set(["0a1b"]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(onRevoked).not.toHaveBeenCalled();
  });
});

describe("the client-certificate gate, with revocation", () => {
  it("refuses a revoked certificate even though the handshake accepted it", () => {
    expect(clientCertGate({ pathname: "/v1/kbs", authorized: true, revoked: true })).toBe("refuse");
  });

  it("still serves an unrevoked one", () => {
    expect(clientCertGate({ pathname: "/v1/kbs", authorized: true, revoked: false })).toBe("serve");
  });

  it("gives revocation no pre-auth exception", () => {
    expect(
      clientCertGate({
        pathname: "/v1/pair/redeem",
        authorized: true,
        revoked: true,
        isPreAuthPath: isPairingPath,
      }),
    ).toBe("refuse");
  });

  it("is unchanged for every instance that has revoked nothing", () => {
    expect(clientCertGate({ pathname: "/v1/kbs", authorized: true })).toBe("serve");
  });
});

describe("the upgrade gate, with revocation", () => {
  it("refuses a revoked certificate", () => {
    expect(upgradeGate(true, true)).toBe("refuse");
  });

  it("is unchanged otherwise", () => {
    expect(upgradeGate(true)).toBe("serve");
    expect(upgradeGate(false)).toBe("refuse");
  });
});
