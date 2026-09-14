// Where Search keeps its identity: the CA, the server certificate and the
// secret the code digest is keyed under.
//
// **Copied from actana/control `packages/shared/src/core-material-store.ts`**
// (ADR 0008), cut to the half Search has: `material.json` under
// `SEARCH_STATE_DIR`, 0600, read at boot, minted on first boot, re-issued when
// the configured public hosts stop matching the certificate's SAN list.
//
// What was dropped, and why: Control's `coreId`/`coreUuid` pair becomes one
// `instanceId` plus one `instanceUuid` with the same split (the id belongs to a
// *set of material* and is re-minted with it; the UUID belongs to the instance
// and survives a re-issue), and the Harness-era CA provenance check goes,
// because Search has no legacy installs to be tolerant of. The identity check
// itself — certificate and key are a pair, leaf was signed by the CA beside it
// — is kept, because the failure it catches is the one whose only other symptom
// is `wrong version number` at a client.
//
// Server process only.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createPrivateKey, randomBytes, randomUUID, X509Certificate } from "node:crypto";
import { generateCertMaterial, issueServerCert } from "./cert-material.ts";

/**
 * The persisted material — everything the instance needs to restart with the
 * same identity (same CA, same certificates, same secret).
 */
export type PersistedMaterial = {
  /** PEM-encoded self-signed CA cert. */
  caCert: string;
  /** PEM-encoded CA private key. */
  caKey: string;
  /** PEM-encoded server cert presented in the mTLS handshake. */
  serverCert: string;
  /** PEM-encoded server private key. */
  serverKey: string;
  /** PEM-encoded bootstrap client cert. Issued to this instance, for its own
   *  tests and for an operator who needs a certificate before pairing works. */
  clientCert: string;
  /** PEM-encoded bootstrap client private key. */
  clientKey: string;
  /** HMAC secret. Keys the pairing code digest, and signs the inert bearer. */
  bearerSecret: string;
  /** The id embedded in the bearer. Re-minted with the material. */
  instanceId: string;
  /** The instance's stable identifier, minted once and never replaced. */
  instanceUuid: string;
  /** The public hosts `serverCert`'s SAN list was signed for, in order. */
  serverHosts: string[];
};

/** The filename inside the state dir. */
export const MATERIAL_FILENAME = "material.json";

/** `SEARCH_STATE_DIR`, or `~/.actana-search`. */
export function defaultStateDir(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  const configured = (env.SEARCH_STATE_DIR ?? "").trim();
  return configured.length > 0 ? configured : path.join(home, ".actana-search");
}

/** The full path to the material file for a given state dir. */
export function materialFilePath(stateDir: string): string {
  return path.join(stateDir, MATERIAL_FILENAME);
}

/** Best-effort chmod to owner-only. No-op on non-POSIX filesystems. */
function restrictPermissions(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) fs.chmodSync(filePath, 0o600);
  } catch {
    /* best effort */
  }
}

/**
 * Mint a brand-new identity: a fresh CA, fresh certificates, a fresh secret,
 * all valid for every host in `publicHosts`.
 *
 * Everything a paired client pinned is replaced, so whoever calls this is
 * choosing to lock every one of them out until it re-pairs. The boot path calls
 * it only when there is nothing to reuse.
 */
export async function mintFreshMaterial(
  publicHosts: readonly string[],
): Promise<PersistedMaterial> {
  const generated = await generateCertMaterial({ hosts: publicHosts });
  return {
    caCert: generated.ca.cert,
    caKey: generated.ca.key,
    serverCert: generated.server.cert,
    serverKey: generated.server.key,
    clientCert: generated.client.cert,
    clientKey: generated.client.key,
    bearerSecret: randomBytes(32).toString("hex"),
    instanceId: `search_${randomBytes(8).toString("hex")}`,
    instanceUuid: randomUUID(),
    serverHosts: [...publicHosts],
  };
}

/**
 * What `material`'s server cert says about `hosts`: signed for exactly these,
 * signed for a different list, or written before the record existed.
 *
 * **In order**, because the first entry is the primary: it is the common name
 * and the endpoint a pairing hands back, so a list that was reordered is an
 * instance whose clients are being sent somewhere else.
 */
export function checkServerCertHost(
  material: PersistedMaterial,
  hosts: readonly string[],
): "covered" | "moved" | "unrecorded" {
  if (material.serverHosts.length === 0) return "unrecorded";
  if (material.serverHosts.length !== hosts.length) return "moved";
  return material.serverHosts.every((host, i) => host === hosts[i]) ? "covered" : "moved";
}

/**
 * Sign a fresh server cert for `publicHosts` against the material's own CA,
 * keeping everything else byte-for-byte.
 *
 * The CA key, the secret, the ids and the bootstrap client cert all survive the
 * spread below, so a client paired before the move still validates this
 * instance against the CA it pinned — where a re-mint would lock it out for
 * what is usually a typo'd environment variable.
 */
export async function reissueServerCert(
  material: PersistedMaterial,
  publicHosts: readonly string[],
  notBefore?: Date,
): Promise<PersistedMaterial> {
  const server = await issueServerCert({
    ca: { cert: material.caCert, key: material.caKey },
    hosts: publicHosts,
    // The caller's clock, not this module's: the renewal decision and the
    // validity window it produces have to be taken against the same one, or a
    // test that walks a certificate to the edge of its life re-signs it to
    // exactly the date it already had.
    ...(notBefore === undefined ? {} : { notBefore }),
  });
  return { ...material, serverCert: server.cert, serverKey: server.key, serverHosts: [...publicHosts] };
}

/** Persist material, creating the directory it names. 0600 — it holds keys. */
export function persistMaterial(stateDir: string, material: PersistedMaterial): void {
  const filePath = materialFilePath(stateDir);
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, JSON.stringify(material, null, 2), { encoding: "utf8", mode: 0o600 });
  restrictPermissions(filePath);
}

/**
 * Load material from a state dir. Returns `null` for a missing file, corrupt
 * JSON, or a payload missing required fields — the caller treats null as
 * "mint fresh material" (first boot).
 */
export function loadMaterial(stateDir: string): PersistedMaterial | null {
  let raw: string;
  try {
    raw = fs.readFileSync(materialFilePath(stateDir), "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const o = parsed as Record<string, unknown>;
  if (
    typeof o.caCert !== "string" ||
    typeof o.caKey !== "string" ||
    typeof o.serverCert !== "string" ||
    typeof o.serverKey !== "string" ||
    typeof o.clientCert !== "string" ||
    typeof o.clientKey !== "string" ||
    typeof o.bearerSecret !== "string" ||
    typeof o.instanceId !== "string"
  ) {
    return null;
  }
  const storedUuid = typeof o.instanceUuid === "string" ? o.instanceUuid : "";
  return {
    caCert: o.caCert,
    caKey: o.caKey,
    serverCert: o.serverCert,
    serverKey: o.serverKey,
    clientCert: o.clientCert,
    clientKey: o.clientKey,
    bearerSecret: o.bearerSecret,
    instanceId: o.instanceId,
    instanceUuid: storedUuid === "" ? randomUUID() : storedUuid,
    serverHosts: readServerHosts(o),
  };
}

/** The common name on every CA this service mints. */
export const SEARCH_CA_COMMON_NAME = "actana-search-ca";

/**
 * What is wrong with a material file, and how wrong.
 *
 * `unusable` — no configuration can make this serve TLS: the certificate and
 * the key are not a pair, or the leaf was not signed by the CA beside it. The
 * boot refuses. `foreign` — it works, it is simply not ours; reported and kept.
 */
export type MaterialIdentityIssue = {
  severity: "unusable" | "foreign";
  message: string;
};

const REMEDY =
  "Delete the material file under SEARCH_STATE_DIR and restart, which mints this " +
  "instance a fresh identity — every paired client then re-pairs with a new code.";

/**
 * Whether this material is an identity the instance can actually serve.
 *
 * `loadMaterial` type-checks eight strings, which is the difference between a
 * file and JSON — not between an identity and a broken one. Material that could
 * never complete a handshake would otherwise load, be presented, and reach an
 * operator as `wrong version number` from a client: a message about a wire
 * protocol, for a problem about an identity.
 */
export function checkMaterialIdentity(material: PersistedMaterial): MaterialIdentityIssue | null {
  const unusable = (message: string): MaterialIdentityIssue => ({
    severity: "unusable",
    message: `${message} ${REMEDY}`,
  });

  let ca: X509Certificate;
  try {
    ca = new X509Certificate(material.caCert);
  } catch {
    return unusable("`caCert` is not a certificate this instance can parse.");
  }

  let server: X509Certificate;
  try {
    server = new X509Certificate(material.serverCert);
  } catch {
    return unusable("`serverCert` is not a certificate this instance can parse.");
  }

  // `verify` and deliberately not `checkIssued`: the latter compares names, and
  // every CA this service mints carries the *same* name — so two instances'
  // files shuffled together would pass it while chaining to different keys.
  let issuedByThisCa: boolean;
  try {
    issuedByThisCa = server.verify(ca.publicKey);
  } catch {
    issuedByThisCa = false;
  }
  if (!issuedByThisCa) {
    return unusable(
      "The server certificate in this material was not issued by the CA beside it, so no " +
        "client that pins the CA can validate it.",
    );
  }

  try {
    if (!server.checkPrivateKey(createPrivateKey(material.serverKey))) {
      return unusable(
        "The server certificate and `serverKey` in this material are not a pair. TLS would " +
          "fail at the handshake with nothing said about why.",
      );
    }
  } catch {
    return unusable("`serverKey` is not a private key this instance can parse.");
  }

  const issuer = /^CN=(.*)$/m.exec(ca.subject)?.[1]?.trim() ?? "";
  if (issuer !== SEARCH_CA_COMMON_NAME) {
    return {
      severity: "foreign",
      message:
        `This instance's identity was minted by \`${issuer || "(no common name)"}\`, which no ` +
        "version of this service has minted. It is kept and served as it is: the certificates " +
        "hang together, and a client that pinned that CA still validates.",
    };
  }
  return null;
}

/** The recorded SAN hosts. Anything that is not a string is dropped. */
function readServerHosts(o: Record<string, unknown>): string[] {
  if (!Array.isArray(o.serverHosts)) return [];
  return o.serverHosts
    .filter((host): host is string => typeof host === "string")
    .map((host) => host.trim())
    .filter((host) => host.length > 0);
}
