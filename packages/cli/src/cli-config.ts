// `~/.actana-search/cli.json` — the credentials `pair redeem` produced.
//
// One file, one object, one **profile** per instance this machine has paired
// with. A profile is a registration blob and nothing else that matters: the
// endpoint, the CA certificate, this machine's own certificate, and the private
// key that was generated here and never sent (ADR 0003).
//
// **It is a secret file and it is treated as one.** The directory is 0700, the
// file is 0600, and both modes are re-applied on every write rather than
// assumed from the first one — a file restored from a backup, copied by an
// installer, or created by an earlier build is a file whose mode nobody
// checked. `encodeRegistrationBlob` is what goes in, so a blob is one base64
// line rather than three PEMs a careless `cat` scrolls past.
//
// **No key ever reaches this file from `endpoint add`.** A provider key goes to
// the instance, sealed there, and is never written on this side — this file
// holds the credential that talks to an instance, not the credentials the
// instance talks to models with (ADR 0004).
//
// Shaped after Control's `actana-config.ts`: read returns null for missing,
// corrupt or wrong-typed rather than throwing, because all three mean the same
// thing to every caller — nothing is paired here yet.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  decodeRegistrationBlob,
  encodeRegistrationBlob,
  type SearchRegistrationBlob,
} from "@actana/search/registration-blob";

/** The directory the CLI keeps its state in. Mirrors `SEARCH_STATE_DIR`'s default. */
export const DEFAULT_CONFIG_DIR = ".actana-search";

/** The filename inside it. */
export const CLI_CONFIG_FILENAME = "cli.json";

/** The profile used when none is named. */
export const DEFAULT_PROFILE = "default";

/** What one paired instance looks like on disk. */
export type CliProfile = {
  /** The registration blob, base64 as `encodeRegistrationBlob` writes it. */
  blob: string;
  /** The instance's `https://host:port`. Duplicated out of the blob, for listings. */
  endpoint: string;
  /** What this machine called itself when it paired. */
  label?: string;
  /** When the pairing happened, ISO 8601. */
  pairedAt?: string;
  /** The instance's CA fingerprint, as it was confirmed. Display only. */
  caFingerprint?: string;
};

/** The whole file. */
export type CliConfig = {
  version: 1;
  defaultProfile: string;
  profiles: Record<string, CliProfile>;
};

/** An empty configuration — what a machine that has paired with nothing has. */
export function emptyConfig(): CliConfig {
  return { version: 1, defaultProfile: DEFAULT_PROFILE, profiles: {} };
}

/** `~/.actana-search`, or wherever `home` says. */
export function configDirFor(home: string = os.homedir()): string {
  return path.join(home, DEFAULT_CONFIG_DIR);
}

/** Full path to `cli.json` for a config dir. */
export function cliConfigPath(configDir: string): string {
  return path.join(configDir, CLI_CONFIG_FILENAME);
}

/**
 * Read the configuration.
 *
 * Never throws. A missing file, unreadable bytes, non-JSON, or a payload whose
 * shape is wrong all return an empty configuration, because every caller treats
 * all four as "nothing is paired here yet" — and a CLI that refuses to run
 * `--help` because a config file has a stray comma in it is a CLI nobody can
 * recover with.
 */
export function readCliConfig(configDir: string): CliConfig {
  let raw: string;
  try {
    raw = fs.readFileSync(cliConfigPath(configDir), "utf8");
  } catch {
    return emptyConfig();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyConfig();
  }
  if (!parsed || typeof parsed !== "object") return emptyConfig();
  const o = parsed as Record<string, unknown>;
  const profiles: Record<string, CliProfile> = {};
  if (o.profiles && typeof o.profiles === "object") {
    for (const [name, value] of Object.entries(o.profiles as Record<string, unknown>)) {
      if (!value || typeof value !== "object") continue;
      const p = value as Record<string, unknown>;
      if (typeof p.blob !== "string" || typeof p.endpoint !== "string") continue;
      profiles[name] = {
        blob: p.blob,
        endpoint: p.endpoint,
        ...(typeof p.label === "string" ? { label: p.label } : {}),
        ...(typeof p.pairedAt === "string" ? { pairedAt: p.pairedAt } : {}),
        ...(typeof p.caFingerprint === "string" ? { caFingerprint: p.caFingerprint } : {}),
      };
    }
  }
  const defaultProfile =
    typeof o.defaultProfile === "string" && o.defaultProfile ? o.defaultProfile : DEFAULT_PROFILE;
  return { version: 1, defaultProfile, profiles };
}

/**
 * Write the configuration, creating the directory.
 *
 * The write is atomic — a temporary file in the same directory, `chmod`ed
 * before it is renamed into place — so a process killed mid-write leaves the
 * previous credential intact rather than half a JSON document. Renaming within
 * one directory is the only rename POSIX makes atomic, which is why the
 * temporary file is not in `/tmp`.
 */
export function writeCliConfig(configDir: string, config: CliConfig): void {
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  // Re-applied every write: a directory restored from a backup or created by an
  // earlier build is one whose mode nobody checked.
  try {
    fs.chmodSync(configDir, 0o700);
  } catch {
    /* a directory we cannot chmod is one the write below will report on */
  }
  const target = cliConfigPath(configDir);
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, target);
  fs.chmodSync(target, 0o600);
}

/** Store a profile and make it the default. Returns the configuration written. */
export function saveProfile(
  configDir: string,
  name: string,
  blob: SearchRegistrationBlob,
  extra: { caFingerprint?: string; pairedAt?: string } = {},
): CliConfig {
  const config = readCliConfig(configDir);
  config.profiles[name] = {
    blob: encodeRegistrationBlob(blob),
    endpoint: blob.endpoint,
    ...(blob.label ? { label: blob.label } : {}),
    pairedAt: extra.pairedAt ?? new Date().toISOString(),
    ...(extra.caFingerprint ? { caFingerprint: extra.caFingerprint } : {}),
  };
  // The newest pairing becomes the default. An operator who has just paired a
  // machine means to use it; naming `--profile` on the next command as well
  // would be a step that exists only because this line does not.
  config.defaultProfile = name;
  writeCliConfig(configDir, config);
  return config;
}

/** Forget a profile. `false` when there was none by that name. */
export function removeProfile(configDir: string, name: string): boolean {
  const config = readCliConfig(configDir);
  if (!config.profiles[name]) return false;
  delete config.profiles[name];
  if (config.defaultProfile === name) {
    config.defaultProfile = Object.keys(config.profiles)[0] ?? DEFAULT_PROFILE;
  }
  writeCliConfig(configDir, config);
  return true;
}

/** The blob a profile holds, or null when the profile or its blob is unusable. */
export function loadProfileBlob(
  configDir: string,
  name?: string | null,
): { name: string; blob: SearchRegistrationBlob } | null {
  const config = readCliConfig(configDir);
  const profileName = name ?? config.defaultProfile;
  const profile = config.profiles[profileName];
  if (!profile) return null;
  const blob = decodeRegistrationBlob(profile.blob);
  // `decodeRegistrationBlob` refuses a non-`https://` endpoint, so a blob that
  // has been edited into a downgrade reads as no credential at all rather than
  // as one that dials plaintext (ADR 0003).
  if (!blob) return null;
  return { name: profileName, blob };
}
