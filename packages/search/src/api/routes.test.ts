// The KB half of a pairing's grant (ADR 0003).
//
// The scope half is a rank comparison and is asserted beside it; this is the
// half that was *stored and never read* until a review said so. It is here as a
// pure function, and the server calls it in two places — from `kbIdFrom` before
// a handler runs, and from `allowsKb` on the context for a route whose KB is in
// a body — so that a KB-scoped route added in TASK-004 is enforced by being
// registered rather than by its author remembering.
import { describe, expect, it } from "vitest";
import type { PairedClient } from "@actana/search-shared/pairing/pairing-code-digest";
import { clientAllowsKb } from "./routes.ts";
import { scopeAllows } from "./server.ts";

const client = (overrides: Partial<PairedClient> = {}): PairedClient => ({
  id: "pc_1",
  certSerial: "0A1B",
  certFingerprint: "AA:BB",
  certSubject: "CN=studio",
  label: "studio",
  platform: null,
  sessionId: "ps_1",
  pairedAt: 0,
  certNotAfter: 0,
  revokedAt: null,
  scope: "admin",
  kbIds: null,
  created_by: null,
  tenant_id: null,
  auth_method: null,
  ...overrides,
});

describe("the KB grant", () => {
  it("covers every KB when the pairing named none", () => {
    expect(clientAllowsKb(client({ kbIds: null }), "kb_anything")).toBe(true);
    expect(clientAllowsKb(client({ kbIds: [] }), "kb_anything")).toBe(true);
  });

  it("covers exactly the KBs the pairing named", () => {
    const listed = client({ kbIds: ["kb_a", "kb_b"] });
    expect(clientAllowsKb(listed, "kb_a")).toBe(true);
    expect(clientAllowsKb(listed, "kb_b")).toBe(true);
    expect(clientAllowsKb(listed, "kb_c")).toBe(false);
  });

  it("does not match a KB id by prefix, or by anything but equality", () => {
    const listed = client({ kbIds: ["kb_a"] });
    expect(clientAllowsKb(listed, "kb_a2")).toBe(false);
    expect(clientAllowsKb(listed, "KB_A")).toBe(false);
    expect(clientAllowsKb(listed, "")).toBe(false);
  });

  it("answers no when there is no client — an open route has nothing to ask", () => {
    expect(clientAllowsKb(null, "kb_a")).toBe(false);
  });
});

describe("the scope grant", () => {
  it("ranks admin over write over read", () => {
    expect(scopeAllows("admin", "write")).toBe(true);
    expect(scopeAllows("admin", "read")).toBe(true);
    expect(scopeAllows("write", "read")).toBe(true);
    expect(scopeAllows("write", "admin")).toBe(false);
    expect(scopeAllows("read", "write")).toBe(false);
  });

  it("refuses a scope it does not recognise rather than ranking it", () => {
    expect(scopeAllows("superuser", "read")).toBe(false);
    expect(scopeAllows("", "read")).toBe(false);
  });
});
