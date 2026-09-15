/**
 * The profile store.
 *
 * Three things matter here and one of them is a file mode:
 *
 *   1. **Round trip.** What `pair redeem` writes is what `status` reads back.
 *   2. **0600 and 0700, every write.** The file holds this machine's private key
 *      and the certificate it proves itself with. A mode that was right on the
 *      first write and never checked again is a mode that a restore or a
 *      careless `cp` quietly widens.
 *   3. **A corrupt file is "nothing is paired", never a crash.** A CLI that
 *      cannot print `--help` because a JSON file has a stray comma in it is a
 *      CLI nobody can recover with.
 *
 * @vitest-environment node
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decodeRegistrationBlob } from "@actana/search/registration-blob";
import type { SearchRegistrationBlob } from "@actana/search/registration-blob";
import {
  cliConfigPath,
  configDirFor,
  DEFAULT_PROFILE,
  emptyConfig,
  loadProfileBlob,
  readCliConfig,
  removeProfile,
  saveProfile,
  writeCliConfig,
} from "./cli-config.ts";

let home: string;
let configDir: string;

const blob: SearchRegistrationBlob = {
  endpoint: "https://search.internal:7443",
  label: "laptop",
  caCert: "-----BEGIN CERTIFICATE-----\nca\n-----END CERTIFICATE-----",
  clientCert: "-----BEGIN CERTIFICATE-----\nclient\n-----END CERTIFICATE-----",
  clientKey: "-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----",
  bearer: "inert",
};

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "actana-search-cli-"));
  configDir = configDirFor(home);
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe("paths", () => {
  it("puts the file in ~/.actana-search, beside the instance's own state dir default", () => {
    expect(configDir).toBe(path.join(home, ".actana-search"));
    expect(cliConfigPath(configDir)).toBe(path.join(configDir, "cli.json"));
  });
});

describe("saving and loading a profile", () => {
  it("round-trips the blob through base64", () => {
    saveProfile(configDir, DEFAULT_PROFILE, blob, { caFingerprint: "AA:BB" });
    const loaded = loadProfileBlob(configDir);
    expect(loaded?.name).toBe(DEFAULT_PROFILE);
    expect(loaded?.blob).toEqual(blob);
  });

  it("stores the blob encoded rather than as three readable PEMs", () => {
    saveProfile(configDir, DEFAULT_PROFILE, blob);
    const raw = fs.readFileSync(cliConfigPath(configDir), "utf8");
    expect(raw).not.toContain("BEGIN PRIVATE KEY");
    const stored = JSON.parse(raw).profiles[DEFAULT_PROFILE].blob;
    expect(decodeRegistrationBlob(stored)?.clientKey).toBe(blob.clientKey);
  });

  it("makes the newest pairing the default", () => {
    saveProfile(configDir, "first", blob);
    saveProfile(configDir, "second", { ...blob, endpoint: "https://other:7443" });
    expect(readCliConfig(configDir).defaultProfile).toBe("second");
    expect(loadProfileBlob(configDir)?.name).toBe("second");
    // …and a named profile still wins over it.
    expect(loadProfileBlob(configDir, "first")?.blob.endpoint).toBe(blob.endpoint);
  });

  it("keeps the endpoint and label beside the blob, for a listing", () => {
    saveProfile(configDir, DEFAULT_PROFILE, blob, { caFingerprint: "AA:BB" });
    const profile = readCliConfig(configDir).profiles[DEFAULT_PROFILE]!;
    expect(profile.endpoint).toBe(blob.endpoint);
    expect(profile.label).toBe("laptop");
    expect(profile.caFingerprint).toBe("AA:BB");
    expect(profile.pairedAt).toEqual(expect.any(String));
  });

  it("returns null for a profile that is not there", () => {
    expect(loadProfileBlob(configDir, "nope")).toBeNull();
    expect(loadProfileBlob(configDir)).toBeNull();
  });

  it("reads a blob whose endpoint was edited into plaintext as no credential at all", () => {
    // `decodeRegistrationBlob` refuses a non-https endpoint. A downgrade in the
    // file has to read as "nothing is paired", not as "dial this in the clear".
    saveProfile(configDir, DEFAULT_PROFILE, blob);
    const config = readCliConfig(configDir);
    config.profiles[DEFAULT_PROFILE]!.blob = Buffer.from(
      JSON.stringify({ ...blob, endpoint: "http://search.internal:7443" }),
      "utf8",
    ).toString("base64");
    writeCliConfig(configDir, config);
    expect(loadProfileBlob(configDir)).toBeNull();
  });
});

describe("file modes", () => {
  const mode = (p: string) => fs.statSync(p).mode & 0o777;

  it("writes the directory 0700 and the file 0600", () => {
    saveProfile(configDir, DEFAULT_PROFILE, blob);
    expect(mode(configDir)).toBe(0o700);
    expect(mode(cliConfigPath(configDir))).toBe(0o600);
  });

  it("re-tightens a directory and a file that were left wide open", () => {
    saveProfile(configDir, DEFAULT_PROFILE, blob);
    fs.chmodSync(configDir, 0o755);
    fs.chmodSync(cliConfigPath(configDir), 0o644);

    saveProfile(configDir, "again", blob);

    expect(mode(configDir)).toBe(0o700);
    expect(mode(cliConfigPath(configDir))).toBe(0o600);
  });

  it("leaves no temporary file behind", () => {
    saveProfile(configDir, DEFAULT_PROFILE, blob);
    expect(fs.readdirSync(configDir)).toEqual(["cli.json"]);
  });
});

describe("a file that cannot be read", () => {
  it("reads a missing file as an empty configuration", () => {
    expect(readCliConfig(configDir)).toEqual(emptyConfig());
  });

  it("reads corrupt JSON as an empty configuration rather than throwing", () => {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(cliConfigPath(configDir), "{ this is not json");
    expect(readCliConfig(configDir)).toEqual(emptyConfig());
  });

  it("drops a profile whose shape is wrong and keeps the ones that are right", () => {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      cliConfigPath(configDir),
      JSON.stringify({
        version: 1,
        defaultProfile: "good",
        profiles: {
          good: { blob: "x", endpoint: "https://a:1" },
          bad: { endpoint: "https://b:1" },
          alsoBad: "not an object",
        },
      }),
    );
    const config = readCliConfig(configDir);
    expect(Object.keys(config.profiles)).toEqual(["good"]);
    expect(config.defaultProfile).toBe("good");
  });
});

describe("removeProfile", () => {
  it("forgets a profile and moves the default off it", () => {
    saveProfile(configDir, "a", blob);
    saveProfile(configDir, "b", blob);
    expect(readCliConfig(configDir).defaultProfile).toBe("b");

    expect(removeProfile(configDir, "b")).toBe(true);
    const config = readCliConfig(configDir);
    expect(Object.keys(config.profiles)).toEqual(["a"]);
    expect(config.defaultProfile).toBe("a");
  });

  it("says so when there was nothing to forget", () => {
    expect(removeProfile(configDir, "nope")).toBe(false);
  });
});
