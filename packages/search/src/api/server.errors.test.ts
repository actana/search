/**
 * What a refusal looks like on the wire, and what happens to a request that
 * goes wrong outside a handler.
 *
 * Two properties, both of which need a socket rather than a unit:
 *
 *   1. **Every error body validates against `ErrorBodySchema`.** The contract
 *      requires `message` and ADR 0009 D6 says `error` is written beside it
 *      with the same string — and the router's own refusals (`sendRefusal`)
 *      wrote only `{ code, error }`, so a scope refusal, a KB refusal, an
 *      unknown route, a missing certificate and a `core-error` were all bodies
 *      the SDK's own error type does not describe.
 *   2. **Nothing a request does takes the process down.** The router's
 *      `routes.find` walks route predicates outside every try, and the request
 *      listener can only `void` the promise it gets — so a throw there was an
 *      `unhandledRejection`. `/v1/kbs/%E0/query` was one: `matchPath` called
 *      `decodeURIComponent` on it and raised `URIError`.
 *
 * The server runs in the insecure mode with a stubbed store, because what is
 * under test is the router and the refusal writer; the handshake has its own
 * suites (`pairing.e2e.test.ts`, `preauth-gate.test.ts`).
 */

import * as http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ErrorBodySchema } from "@actana/search/contracts";
import type { PairedClient } from "@actana/search-shared/pairing/pairing-code-digest";
import type { PersistedMaterial } from "@actana/search-shared/pairing/material-store";
import { notFound, route } from "./http.ts";
import type { SearchPairingStore } from "../pairing/pairing-store.ts";
import type { PairingRevocations } from "../pairing/pairing-revocation.ts";
import { startSearchServer, type SearchServer } from "./server.ts";

const CLIENT_ID = "pc_errors";

const client = (overrides: Partial<PairedClient> = {}): PairedClient => ({
  id: CLIENT_ID,
  certSerial: "0A1B",
  certFingerprint: "AA:BB",
  certSubject: "CN=studio",
  label: "studio",
  platform: null,
  sessionId: "ps_1",
  pairedAt: 0,
  certNotAfter: 0,
  revokedAt: null,
  scope: "read",
  kbIds: ["kb_allowed"],
  created_by: null,
  tenant_id: null,
  auth_method: null,
  ...overrides,
});

/** Enough of the store for the identity lookup, and nothing else. */
const store = {
  getClient: async (id: string) => (id === CLIENT_ID ? client() : null),
  getSession: async () => null,
  findClientByCertificate: async () => null,
  touchLastSeen: async () => {},
} as unknown as SearchPairingStore;

const revocations = { isRevoked: () => false } as unknown as PairingRevocations;

/** The pairing material is only reached by the pre-auth route, which is not used here. */
const material = {
  caCert: "",
  caKey: "",
  serverCert: "",
  serverKey: "",
  bearerSecret: "not-a-real-secret",
  instanceId: "search-errors-test",
  instanceUuid: "00000000-0000-4000-8000-000000000000",
} as unknown as PersistedMaterial;

let server: SearchServer;
let port: number;

/** One request, with the insecure mode's identity header unless told otherwise. */
function ask(
  path: string,
  options: { client?: string | null; method?: string } = {},
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = {};
  const id = options.client === undefined ? CLIENT_ID : options.client;
  if (id !== null) headers["x-paired-client"] = id;
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path, method: options.method ?? "GET", headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({
            status: res.statusCode ?? 0,
            body: text === "" ? undefined : JSON.parse(text),
          });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

beforeAll(async () => {
  server = await startSearchServer({
    material,
    store,
    revocations,
    port: 0,
    host: "127.0.0.1",
    publicHosts: ["127.0.0.1"],
    devInsecure: true,
    registerRoutes: (router) => {
      // A KB-scoped route, so the router's `kbIdFrom` check runs — and so
      // `matchPath` is called on every pathname that has the right shape,
      // which is what `%E0` reaches.
      router.add(route("POST", "/v1/kbs/:kbId/query", "read", ({ res }) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      }));
      router.add(route("GET", "/v1/kbs/:kbId", "read", () => {
        throw notFound("no knowledge base");
      }));
      // `admin`, held by nobody in this suite: the scope refusal.
      router.add(route("PUT", "/v1/endpoints", "admin", ({ res }) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      }));
      /**
       * A route whose *predicate* throws, which is the shape of the bug rather
       * than a re-run of it: it puts the throw where the router walks the
       * table, outside every try in the request path.
       */
      router.add({
        method: "GET",
        path: (pathname) => {
          if (pathname === "/v1/explode") throw new Error("the route table threw");
          return false;
        },
        scope: "read",
        handle: ({ res }) => {
          res.end();
        },
      });
    },
  });
  port = server.port;
});

afterAll(async () => {
  await server?.close();
});

/** Every refusal body must be the contract's error body. */
function expectErrorBody(body: unknown, code: string): void {
  const parsed = ErrorBodySchema.safeParse(body);
  expect(parsed.success, `not an ErrorBody: ${JSON.stringify(body)}`).toBe(true);
  if (!parsed.success) return;
  expect(parsed.data.code).toBe(code);
  expect(parsed.data.message).not.toBe("");
  // ADR 0009 D6: `error` is the same string, for the pairing surface's older
  // spelling.
  expect(parsed.data.error).toBe(parsed.data.message);
}

describe("every error body is the one the contract describes", () => {
  it("a scope the pairing does not hold", async () => {
    const answer = await ask("/v1/endpoints", { method: "PUT" });
    expect(answer.status).toBe(403);
    expectErrorBody(answer.body, "scope-forbidden");
  });

  it("a knowledge base outside the pairing's allow-list", async () => {
    const answer = await ask("/v1/kbs/kb_other/query", { method: "POST" });
    expect(answer.status).toBe(403);
    expectErrorBody(answer.body, "kb-forbidden");
  });

  it("a route this instance does not have", async () => {
    const answer = await ask("/v1/nothing-here");
    expect(answer.status).toBe(404);
    expectErrorBody(answer.body, "not-found");
  });

  it("no paired client at all", async () => {
    const answer = await ask("/v1/kbs/kb_allowed/query", { client: null, method: "POST" });
    expect(answer.status).toBe(403);
    expectErrorBody(answer.body, "client-certificate-required");
  });

  it("a request that failed outside any handler", async () => {
    const answer = await ask("/v1/explode");
    expect(answer.status).toBe(500);
    expectErrorBody(answer.body, "core-error");
  });

  it("a refusal a handler threw", async () => {
    const answer = await ask("/v1/kbs/kb_allowed");
    expect(answer.status).toBe(404);
    expectErrorBody(answer.body, "not-found");
  });
});

describe("a malformed URL", () => {
  it("is a 404 and the server keeps serving", async () => {
    const answer = await ask("/v1/kbs/%E0/query", { method: "POST" });
    expect(answer.status).toBe(404);
    expectErrorBody(answer.body, "not-found");

    // The point of the test: the process is still here and the next request is
    // answered. Before the fix this was an `unhandledRejection`.
    const after = await ask("/v1/health");
    expect(after.status).toBe(200);
    expect(after.body).toMatchObject({ ok: true });
  });
});
