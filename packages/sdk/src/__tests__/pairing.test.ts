// The client half of pairing, carried from actana/control's
// `core-pairing.test.ts` (ADR 0008). The parts that need a server are in
// `packages/search/src/__tests__/pairing.e2e.test.ts`, against a real one;
// what is here is everything that fails before a socket is opened, which is
// where most of the security argument lives — a code that is never sent cannot
// be intercepted.
import { describe, expect, it } from "vitest";
import { X509Certificate } from "node:crypto";
import {
  DEFAULT_PAIRING_TIMEOUT_MS,
  SearchPairingError,
  fingerprintOf,
  pairWithSearch,
  parseFingerprint,
  parsePairingTicket,
  parseSearchAddress,
} from "../pairing.ts";
import { generateClientCsr } from "../pairing-csr.ts";

describe("the ticket a human carries", () => {
  it("reads `<sessionId>:<XXXX-XXXX>` as one token", () => {
    expect(parsePairingTicket("ps_1:ABCD-EFGH")).toEqual({ sessionId: "ps_1", code: "ABCD-EFGH" });
  });

  it("takes the session id beside the code when it is passed that way", () => {
    expect(parsePairingTicket("ABCD-EFGH", "ps_1")).toEqual({ sessionId: "ps_1", code: "ABCD-EFGH" });
  });

  it("accepts the code without the hyphen, in any case, with stray whitespace", () => {
    expect(parsePairingTicket(" abcdefgh ", "ps_1").code).toBe("ABCD-EFGH");
  });

  it("refuses two session ids that disagree rather than picking a winner", () => {
    expect(() => parsePairingTicket("ps_1:ABCD-EFGH", "ps_2")).toThrow(SearchPairingError);
  });

  it("refuses a code with no session — there is nothing for it to name", () => {
    expect(() => parsePairingTicket("ABCD-EFGH")).toThrowError(/pairing session/);
  });

  it("refuses a code that could not be right whatever the alphabet is", () => {
    for (const code of ["ABC-DEFG", "ABCDEFGHI", "ABCD-EF!H"]) {
      expect(() => parsePairingTicket(code, "ps_1")).toThrow(SearchPairingError);
    }
  });
});

describe("the address", () => {
  it("reads `host:port`, defaulting the scheme to https", () => {
    expect(parseSearchAddress("search.internal:7443")).toEqual({
      host: "search.internal",
      port: 7443,
      httpsOrigin: "https://search.internal:7443",
    });
  });

  it("reads an explicit `https://`", () => {
    expect(parseSearchAddress("https://search.internal:7443").port).toBe(7443);
  });

  it("reads a `wss://` a Core-shaped paste would carry", () => {
    expect(parseSearchAddress("wss://search.internal:7443").httpsOrigin).toBe(
      "https://search.internal:7443",
    );
  });

  it("refuses a plaintext port — there is no certificate on one to check", () => {
    for (const address of ["http://search.internal:7443", "ws://search.internal:7443"]) {
      const err = grab(() => parseSearchAddress(address));
      expect(err.failure).toBe("bad-address");
    }
  });

  it("refuses an empty address and a scheme it does not know", () => {
    expect(grab(() => parseSearchAddress("")).failure).toBe("bad-address");
    expect(grab(() => parseSearchAddress("ftp://search.internal")).failure).toBe("bad-address");
  });
});

describe("the fingerprint", () => {
  it("normalises every form a human copies into the conventional one", () => {
    const canonical = parseFingerprint(
      "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99",
    );
    expect(parseFingerprint(canonical.replace(/:/g, "").toLowerCase())).toBe(canonical);
    expect(parseFingerprint(`sha256:${canonical}`)).toBe(canonical);
    expect(parseFingerprint(`  ${canonical}  `)).toBe(canonical);
  });

  it("refuses anything that is not 32 bytes of hex", () => {
    for (const input of ["", "AA:BB", "zz".repeat(32)]) {
      expect(grab(() => parseFingerprint(input)).failure).toBe("bad-fingerprint");
    }
  });

  it("is the colon-separated upper-case SHA-256 every other tool prints", () => {
    const der = Uint8Array.from([1, 2, 3, 4]);
    const fingerprint = fingerprintOf(der);
    expect(fingerprint).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  });
});

describe("a pairing that never reaches a socket", () => {
  it("fails on the ticket before it dials, so a typo costs no attempt", async () => {
    await expect(
      pairWithSearch({ address: "search.invalid:7443", code: "nonsense" }),
    ).rejects.toMatchObject({ failure: "bad-code" });
  });

  it("fails on the address before it dials", async () => {
    await expect(
      pairWithSearch({ address: "http://search.invalid:7443", code: "ps_1:ABCD-EFGH" }),
    ).rejects.toMatchObject({ failure: "bad-address" });
  });

  it("reports an unreachable address rather than hanging", async () => {
    await expect(
      pairWithSearch({
        address: "127.0.0.1:1",
        code: "ps_1:ABCD-EFGH",
        expectedCaFingerprint: "AA".repeat(32),
        timeoutMs: 2_000,
      }),
    ).rejects.toMatchObject({ failure: "unreachable" });
  });

  it("has a timeout a caller can see", () => {
    expect(DEFAULT_PAIRING_TIMEOUT_MS).toBe(15_000);
  });
});

describe("the CSR this client mints", () => {
  it("hands back the private key and never embeds it in the request", async () => {
    const { csrPem, privateKeyPem } = await generateClientCsr("actanastudio");
    expect(csrPem).toMatch(/-----BEGIN CERTIFICATE REQUEST-----/);
    expect(csrPem).not.toContain("PRIVATE KEY");
    expect(privateKeyPem).toMatch(/-----BEGIN PRIVATE KEY-----/);
  });

  it("names the machine that asked, cleaned of X.509 structure characters", async () => {
    const { csrPem } = await generateClientCsr("my laptop, CN=root");
    // Parsed by the same library the server parses it with, which is the only
    // check that matters: a CSR this encoder got wrong fails to parse there.
    // `@peculiar/x509` is a **devDependency** of this package and stays one —
    // the hand-written encoder in `pairing-csr.ts` exists precisely so that the
    // published dependency list stays `undici` and `zod`.
    const { Pkcs10CertificateRequest } = await import("@peculiar/x509");
    const csr = new Pkcs10CertificateRequest(csrPem);
    expect(csr.subject).not.toContain("CN=root");
    expect(await csr.verify()).toBe(true);
  });

  it("is not a certificate — it is a request for one", async () => {
    const { csrPem } = await generateClientCsr("laptop");
    expect(() => new X509Certificate(csrPem)).toThrow();
  });
});

/** Run `fn` and return the `SearchPairingError` it threw. */
function grab(fn: () => unknown): SearchPairingError {
  try {
    fn();
  } catch (err) {
    if (err instanceof SearchPairingError) return err;
    throw err;
  }
  throw new Error("expected a SearchPairingError");
}
