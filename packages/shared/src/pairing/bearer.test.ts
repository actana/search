// The bearer is minted and never read (see `bearer.ts`), and the verifier is
// kept so the copy can be checked against itself.
import { describe, expect, it } from "vitest";
import { signBearer, verifyBearer } from "./bearer.ts";

const SECRET = "0123456789abcdef";
const NOW = 1_700_000_000_000;

describe("the bearer a redemption hands back", () => {
  it("round-trips its claims", () => {
    const token = signBearer(
      { instanceId: "search_abc", exp: NOW + 1000, iss: "search:search_abc", sub: "pair:0a1b", aud: "uuid", jti: "j1" },
      SECRET,
    );
    expect(verifyBearer(token, SECRET, { now: NOW })).toEqual({
      ok: true,
      instanceId: "search_abc",
      exp: NOW + 1000,
      iss: "search:search_abc",
      sub: "pair:0a1b",
      aud: "uuid",
      jti: "j1",
    });
  });

  it("leaves absent claims out of the payload rather than writing them null", () => {
    const token = signBearer({ instanceId: "search_abc", exp: NOW + 1000 }, SECRET);
    const payload = JSON.parse(Buffer.from(token.split(".")[0]!, "base64url").toString("utf8"));
    expect(Object.keys(payload).sort()).toEqual(["exp", "instanceId"]);
  });

  it("refuses a signature made with another secret", () => {
    const token = signBearer({ instanceId: "search_abc", exp: NOW + 1000 }, SECRET);
    expect(verifyBearer(token, "another-secret", { now: NOW })).toEqual({
      ok: false,
      reason: "bad-signature",
    });
  });

  it("is live exactly at its expiry and dead one millisecond later", () => {
    const token = signBearer({ instanceId: "search_abc", exp: NOW }, SECRET);
    expect(verifyBearer(token, SECRET, { now: NOW }).ok).toBe(true);
    expect(verifyBearer(token, SECRET, { now: NOW + 1 })).toEqual({ ok: false, reason: "expired" });
  });

  it("refuses anything that is not two base64url parts", () => {
    for (const junk of ["", ".", "onlyonepart", "a."]) {
      expect(verifyBearer(junk, SECRET, { now: NOW })).toEqual({ ok: false, reason: "malformed" });
    }
  });
});
