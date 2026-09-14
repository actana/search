// The registration blob is a storage codec and nothing else (ADR 0034 D8).
//
// Carried from actana/control's `registration-blob.test.ts`, with the one
// difference this copy has: the endpoint a Search blob carries is `https://`,
// because Search has no WebSocket to downgrade.
import { describe, expect, it } from "vitest";
import {
  decodeRegistrationBlob,
  encodeRegistrationBlob,
  type SearchRegistrationBlob,
} from "./registration-blob.ts";

const blob: SearchRegistrationBlob = {
  endpoint: "https://search.example:7443",
  label: "actanastudio",
  caCert: "-----BEGIN CERTIFICATE-----\nca\n-----END CERTIFICATE-----\n",
  clientCert: "-----BEGIN CERTIFICATE-----\nleaf\n-----END CERTIFICATE-----\n",
  clientKey: "-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----\n",
  bearer: "payload.signature",
};

describe("the registration blob", () => {
  it("round-trips every field", () => {
    expect(decodeRegistrationBlob(encodeRegistrationBlob(blob))).toEqual(blob);
  });

  it("tolerates the trailing newline a file would have", () => {
    expect(decodeRegistrationBlob(`${encodeRegistrationBlob(blob)}\n`)).toEqual(blob);
  });

  it("reads a missing label as the empty string rather than refusing", () => {
    const { label: _label, ...rest } = blob;
    const decoded = decodeRegistrationBlob(encodeRegistrationBlob(rest as SearchRegistrationBlob));
    expect(decoded?.label).toBe("");
  });

  it("refuses a plain-HTTP endpoint, which is a downgrade and not a configuration", () => {
    const downgraded = { ...blob, endpoint: "http://search.example:7443" };
    expect(decodeRegistrationBlob(encodeRegistrationBlob(downgraded))).toBeNull();
  });

  it("refuses a `wss://` endpoint — that is a Core's credential, not this one", () => {
    const core = { ...blob, endpoint: "wss://core.example:7420" };
    expect(decodeRegistrationBlob(encodeRegistrationBlob(core))).toBeNull();
  });

  it("refuses a blob with a field missing", () => {
    const { clientKey: _key, ...rest } = blob;
    const encoded = Buffer.from(JSON.stringify(rest), "utf8").toString("base64");
    expect(decodeRegistrationBlob(encoded)).toBeNull();
  });

  it("refuses junk rather than throwing", () => {
    for (const junk of ["", "   ", "not base64 at all !!", Buffer.from("{").toString("base64")]) {
      expect(decodeRegistrationBlob(junk)).toBeNull();
    }
  });
});
