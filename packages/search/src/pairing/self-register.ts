// The instance's identity at boot: load it, or mint it, or re-sign it.
//
// **Copied in role from actana/control's `core-first-run.ts` /
// `core-self-register.ts` pair** (ADR 0008), cut to what Search has. Control
// has two processes over one material file and a blob registry to write itself
// into; Search has one process and a state directory, so what is left is the
// decision those files exist to make:
//
//   * **Material on disk is reused.** Minting fresh material replaces the CA,
//     which unpairs every client that ever pinned it. That is never done
//     implicitly.
//   * **Material that cannot serve TLS refuses the boot.** A certificate and
//     key that are not a pair, or a leaf the CA beside it did not sign, fails
//     at the handshake with nothing said about why — `wrong version number` at
//     a client, for a problem about an identity.
//   * **A changed `SEARCH_PUBLIC_HOST` re-signs the server certificate against
//     the same CA**, rather than minting a new identity. Everything a paired
//     client pinned survives the move; the alternative locks every one of them
//     out for what is usually a typo'd environment variable.
//   * **So does a server certificate about to expire.** Leaves are good for a
//     year and nothing else re-signs them, so an instance left running — or
//     restarted on a schedule that never coincided with a host change — would
//     one day present an expired certificate and fail every handshake at once,
//     with no warning and no operator action that looks related. Re-signing
//     inside the last thirty days costs one RSA signature at boot and keeps the
//     CA, so nothing paired notices.
//
// The CA fingerprint this returns is what an operator reads out beside a
// pairing code, and what `pairWithSearch` compares before it sends one.

import { X509Certificate } from "node:crypto";
import { createLogger } from "@actana/search-shared/log";
import { certFingerprintSha256 } from "@actana/search-shared/pairing/cert-material";
import {
  checkMaterialIdentity,
  checkServerCertHost,
  loadMaterial,
  materialFilePath,
  mintFreshMaterial,
  persistMaterial,
  reissueServerCert,
  type PersistedMaterial,
} from "@actana/search-shared/pairing/material-store";

const logger = createLogger("pairing.material");

export type EnsureMaterialOptions = {
  /** `SEARCH_STATE_DIR`, already resolved. */
  stateDir: string;
  /** The addresses clients dial. The first is the primary. */
  publicHosts: readonly string[];
  /** Injectable clock, so the expiry window can be walked without a year. */
  now?: number;
};

export type EnsuredMaterial = {
  material: PersistedMaterial;
  /** Colon-separated upper-case SHA-256 of the CA. Read out beside a code. */
  caFingerprint: string;
  /** What this boot did: reused, re-signed, or minted a whole new identity. */
  outcome: "loaded" | "reissued" | "minted";
  /** Why it re-signed, when it did. For the log line and for the test. */
  reason?: "moved" | "unrecorded" | "expiring";
};

/**
 * How close to its expiry a server certificate is re-signed at boot.
 *
 * Thirty days is the window every ACME client uses for the same decision, and
 * for the same reason: long enough that an instance restarted monthly renews
 * without being asked, short enough that it is not re-signing on every boot.
 */
export const REISSUE_WITHIN_MS = 30 * 24 * 60 * 60 * 1000;

/** Is this certificate inside {@link REISSUE_WITHIN_MS} of its expiry? */
export function expiresSoon(certPem: string, now: number = Date.now()): boolean {
  try {
    const notAfter = new Date(new X509Certificate(certPem).validTo).getTime();
    // An unparseable date reads as "not soon": `checkMaterialIdentity` has
    // already refused material whose certificate cannot be parsed at all, so a
    // date this cannot read is a certificate this build does not understand,
    // and re-signing on a misreading would replace a working leaf every boot.
    return Number.isFinite(notAfter) && notAfter - now < REISSUE_WITHIN_MS;
  } catch {
    return false;
  }
}

/**
 * Load the instance's material, minting or re-signing as needed.
 *
 * Throws when what is on disk cannot be served — see the header. A boot that
 * refuses here is a boot an operator can fix; one that proceeds is an outage
 * whose only symptom is at the other end of a TLS handshake.
 */
export async function ensureMaterial(opts: EnsureMaterialOptions): Promise<EnsuredMaterial> {
  const hosts = opts.publicHosts.map((h) => h.trim()).filter((h) => h.length > 0);
  const existing = loadMaterial(opts.stateDir);

  if (!existing) {
    const material = await mintFreshMaterial(hosts);
    persistMaterial(opts.stateDir, material);
    logger.info("Minted a fresh identity", {
      stateDir: opts.stateDir,
      file: materialFilePath(opts.stateDir),
      hosts,
    });
    return { material, caFingerprint: certFingerprintSha256(material.caCert), outcome: "minted" };
  }

  const issue = checkMaterialIdentity(existing);
  if (issue?.severity === "unusable") {
    throw new Error(`${materialFilePath(opts.stateDir)} cannot be served: ${issue.message}`);
  }
  if (issue) logger.warn(issue.message, { file: materialFilePath(opts.stateDir) });

  const now = opts.now ?? Date.now();
  const coverage = checkServerCertHost(existing, hosts);
  const expiring = expiresSoon(existing.serverCert, now);
  if (coverage === "covered" && !expiring) {
    return { material: existing, caFingerprint: certFingerprintSha256(existing.caCert), outcome: "loaded" };
  }

  const reason = coverage === "covered" ? "expiring" : coverage;
  const reissued = await reissueServerCert(existing, hosts, new Date(now));
  persistMaterial(opts.stateDir, reissued);
  logger.info("Re-signed the server certificate against the same CA", {
    reason,
    was: existing.serverHosts,
    now: hosts,
  });
  return {
    material: reissued,
    caFingerprint: certFingerprintSha256(reissued.caCert),
    outcome: "reissued",
    reason,
  };
}
