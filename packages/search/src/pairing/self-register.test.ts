// The instance's identity at boot: reused, re-signed, or minted.
//
// The case a review asked for is the third state below: a server leaf is good
// for a year and nothing else re-signs it, so an instance that is never moved
// would one day present an expired certificate and fail every handshake at once
// — with no warning and no operator action that looks related.
import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { X509Certificate } from "node:crypto";
import {
  loadMaterial,
  persistMaterial,
  type PersistedMaterial,
} from "@actana/search-shared/pairing/material-store";
import { generateCertMaterial, issueServerCert } from "@actana/search-shared/pairing/cert-material";
import { REISSUE_WITHIN_MS, ensureMaterial, expiresSoon } from "./self-register.ts";

const dirs: string[] = [];

function stateDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "search-material-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** Material whose server leaf is valid for `days`, against a real CA. */
async function materialValidFor(days: number): Promise<PersistedMaterial> {
  const generated = await generateCertMaterial({ hosts: ["localhost"], days: 3650 });
  const server = await issueServerCert({
    ca: { cert: generated.ca.cert, key: generated.ca.key },
    hosts: ["localhost"],
    days,
  });
  return {
    caCert: generated.ca.cert,
    caKey: generated.ca.key,
    serverCert: server.cert,
    serverKey: server.key,
    clientCert: generated.client.cert,
    clientKey: generated.client.key,
    bearerSecret: "a".repeat(64),
    instanceId: "search_test",
    instanceUuid: "11111111-1111-4111-8111-111111111111",
    serverHosts: ["localhost"],
  };
}

describe("expiresSoon", () => {
  it("is false for a leaf with most of its year left", async () => {
    const material = await materialValidFor(365);
    expect(expiresSoon(material.serverCert)).toBe(false);
  });

  it("is true inside the last thirty days", async () => {
    const material = await materialValidFor(365);
    const notAfter = new Date(new X509Certificate(material.serverCert).validTo).getTime();
    expect(expiresSoon(material.serverCert, notAfter - REISSUE_WITHIN_MS + 1_000)).toBe(true);
  });

  it("is false for something it cannot read, rather than re-signing every boot", () => {
    expect(expiresSoon("not a certificate")).toBe(false);
    expect(expiresSoon("")).toBe(false);
  });
});

describe("ensureMaterial", () => {
  it("mints an identity on the first boot and writes it down", async () => {
    const dir = stateDir();
    const ensured = await ensureMaterial({ stateDir: dir, publicHosts: ["localhost"] });
    expect(ensured.outcome).toBe("minted");
    expect(ensured.caFingerprint).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    expect(loadMaterial(dir)?.caCert).toBe(ensured.material.caCert);
  });

  it("reuses what is on disk — minting again would unpair every client", async () => {
    const dir = stateDir();
    const first = await ensureMaterial({ stateDir: dir, publicHosts: ["localhost"] });
    const second = await ensureMaterial({ stateDir: dir, publicHosts: ["localhost"] });
    expect(second.outcome).toBe("loaded");
    expect(second.material.caCert).toBe(first.material.caCert);
    expect(second.material.serverCert).toBe(first.material.serverCert);
  });

  it("re-signs against the same CA when the public host changes", async () => {
    const dir = stateDir();
    const first = await ensureMaterial({ stateDir: dir, publicHosts: ["localhost"] });
    const moved = await ensureMaterial({ stateDir: dir, publicHosts: ["search.internal"] });
    expect(moved.outcome).toBe("reissued");
    expect(moved.reason).toBe("moved");
    // The CA survives, which is the whole point: a client that pinned it does
    // not have to re-pair because an environment variable changed.
    expect(moved.material.caCert).toBe(first.material.caCert);
    expect(moved.material.serverCert).not.toBe(first.material.serverCert);
  });

  it("re-signs inside the last thirty days of the leaf, without being moved", async () => {
    const dir = stateDir();
    const material = await materialValidFor(365);
    persistMaterial(dir, material);
    const notAfter = new Date(new X509Certificate(material.serverCert).validTo).getTime();

    const renewed = await ensureMaterial({
      stateDir: dir,
      publicHosts: ["localhost"],
      now: notAfter - REISSUE_WITHIN_MS + 1_000,
    });
    expect(renewed.outcome).toBe("reissued");
    expect(renewed.reason).toBe("expiring");
    expect(renewed.material.caCert).toBe(material.caCert);
    expect(renewed.material.serverCert).not.toBe(material.serverCert);
    // And the new leaf is good for another year from now, not from then.
    const renewedNotAfter = new Date(
      new X509Certificate(renewed.material.serverCert).validTo,
    ).getTime();
    expect(renewedNotAfter).toBeGreaterThan(notAfter);
    // Written down, so the next boot loads it rather than re-signing again.
    expect(loadMaterial(dir)?.serverCert).toBe(renewed.material.serverCert);
  });

  it("leaves a leaf alone the day before the window opens", async () => {
    const dir = stateDir();
    const material = await materialValidFor(365);
    persistMaterial(dir, material);
    const notAfter = new Date(new X509Certificate(material.serverCert).validTo).getTime();
    const renewed = await ensureMaterial({
      stateDir: dir,
      publicHosts: ["localhost"],
      now: notAfter - REISSUE_WITHIN_MS - 24 * 60 * 60 * 1000,
    });
    expect(renewed.outcome).toBe("loaded");
  });

  it("refuses to boot on material that could never complete a handshake", async () => {
    const dir = stateDir();
    const material = await materialValidFor(365);
    const other = await materialValidFor(365);
    // A server certificate and a key that are not a pair: TLS would fail at the
    // handshake with nothing said about why, and the operator's first news
    // would be `wrong version number` from a client.
    persistMaterial(dir, { ...material, serverKey: other.serverKey });
    await expect(ensureMaterial({ stateDir: dir, publicHosts: ["localhost"] })).rejects.toThrowError(
      /cannot be served/,
    );
  });
});
