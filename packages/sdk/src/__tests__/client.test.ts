/**
 * @vitest-environment node
 *
 * `SearchClient` against a fake instance.
 *
 * What is being tested is the client's half of the contract and nothing else:
 * which method and path each namespace calls, that the body goes out in the
 * encoding the route reads, that an error body becomes a {@link SearchApiError}
 * carrying the instance's own `code`, and that the event stream yields events
 * and swallows heartbeats. The real instance is exercised by
 * `packages/search/src/__tests__/fixture-suite.rest.test.ts`; a fake one here
 * keeps these assertions about the client rather than about a database.
 *
 * Every canned response is validated against the contract schema on the way
 * out, so a fake that drifts from the wire fails this suite rather than lying
 * in it.
 */

import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SearchClient } from "../client.ts";
import { SearchApiError } from "../errors.ts";
import {
  CapabilitiesSchema,
  DocumentSchema,
  WhoamiSchema,
  HybridQueryResponseSchema,
  IngestResponseSchema,
  KnowledgeBaseSchema,
  ListChunkKeywordsResponseSchema,
  ListKbsResponseSchema,
  SEARCH_FEATURES,
} from "../contracts.ts";

type Seen = {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
};

/** What the fake answers next: a status and a JSON body, or a raw SSE stream. */
type Canned =
  | { status: number; json: unknown }
  | { sse: string[] };

const seen: Seen[] = [];
let canned: Canned = { status: 200, json: {} };

let server: http.Server;
let client: SearchClient;

const KB = {
  id: "kb_1",
  userId: "u_1",
  name: "Handbook",
  description: null,
  tokenCount: 0,
  embeddingModel: "text-embedding-3-small",
  embeddingDimension: 1536,
  chunkingConfig: { maxSize: 1024, minSize: 1, overlap: 200 },
  createdAt: "2026-09-14T00:00:00.000Z",
  updatedAt: "2026-09-14T00:00:00.000Z",
  deletedAt: null,
  workspaceId: "pc_1",
  docCount: 0,
  connectorTypes: [],
};

/** An empty page, for a listing whose rows are not what is being asserted. */
const EMPTY_PAGE = { total: 0, limit: 50, offset: 0, hasMore: false };

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      seen.push({
        method: req.method ?? "GET",
        path: req.url ?? "/",
        headers: req.headers,
        body: Buffer.concat(chunks),
      });
      if ("sse" in canned) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        for (const frame of canned.sse) res.write(frame);
        res.end();
        return;
      }
      const body = JSON.stringify(canned.json);
      res.writeHead(canned.status, {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(body)),
      });
      res.end(body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  client = SearchClient.insecureForTests(`http://127.0.0.1:${port}`, "pc_1");
});

afterAll(async () => {
  await client.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  seen.length = 0;
});

const last = (): Seen => seen[seen.length - 1]!;

describe("the request itself", () => {
  it("sends the paired-client header the insecure mode reads, and asks for JSON", async () => {
    canned = { status: 200, json: { ok: true } };
    await client.health();
    expect(last().headers["x-paired-client"]).toBe("pc_1");
    expect(last().headers["accept"]).toBe("application/json");
  });

  it("puts query parameters on the path and leaves `undefined` off", async () => {
    canned = { status: 200, json: { knowledgeBases: [] } };
    await client.kbs.list({ scope: "archived" });
    expect(last().path).toBe("/v1/kbs?scope=archived");
    await client.kbs.list();
    expect(last().path).toBe("/v1/kbs");
  });

  it("escapes an id rather than letting it add a path segment", async () => {
    canned = { status: 200, json: KB };
    await client.kbs.get("kb/1");
    expect(last().path).toBe("/v1/kbs/kb%2F1");
  });
});

describe("the namespaces", () => {
  it("call the method and path each route is registered at", async () => {
    const calls: Array<[Promise<unknown>, string, string]> = [];
    canned = { status: 200, json: {} };

    const check = async (run: () => Promise<unknown>, method: string, path: string) => {
      await run().catch(() => undefined);
      expect([last().method, last().path.split("?")[0]], `${method} ${path}`).toEqual([
        method,
        path,
      ]);
    };
    void calls;

    await check(() => client.kbs.list(), "GET", "/v1/kbs");
    await check(() => client.kbs.create({ name: "x" }), "POST", "/v1/kbs");
    await check(() => client.kbs.get("kb_1"), "GET", "/v1/kbs/kb_1");
    await check(() => client.kbs.update("kb_1", { name: "y" }), "PATCH", "/v1/kbs/kb_1");
    await check(() => client.kbs.delete("kb_1"), "DELETE", "/v1/kbs/kb_1");
    await check(() => client.kbs.restore("kb_1"), "POST", "/v1/kbs/kb_1/restore");
    await check(() => client.kbs.query("kb_1", { text: "q" }), "POST", "/v1/kbs/kb_1/query");
    await check(
      () => client.kbs.ingest("kb_1", { filename: "a.md", text: "hello" }),
      "POST",
      "/v1/kbs/kb_1/documents",
    );
    await check(() => client.documents.list("kb_1"), "GET", "/v1/kbs/kb_1/documents");
    await check(() => client.documents.get("kb_1", "d_1"), "GET", "/v1/kbs/kb_1/documents/d_1");
    await check(
      () => client.documents.update("kb_1", "d_1", { enabled: false }),
      "PATCH",
      "/v1/kbs/kb_1/documents/d_1",
    );
    await check(
      () => client.documents.delete("kb_1", "d_1"),
      "DELETE",
      "/v1/kbs/kb_1/documents/d_1",
    );
    await check(
      () =>
        client.documents.attachBlob("kb_1", "d_1", {
          file: Buffer.from("x"),
          filename: "a.md",
        }),
      "PUT",
      "/v1/kbs/kb_1/documents/d_1/blob",
    );
    await check(
      () => client.documents.chunks("kb_1", "d_1"),
      "GET",
      "/v1/kbs/kb_1/documents/d_1/chunks",
    );
    await check(
      () => client.documents.updateChunk("kb_1", "d_1", "c_1", { enabled: true }),
      "PATCH",
      "/v1/kbs/kb_1/documents/d_1/chunks/c_1",
    );
    await check(
      () => client.documents.deleteChunk("kb_1", "d_1", "c_1"),
      "DELETE",
      "/v1/kbs/kb_1/documents/d_1/chunks/c_1",
    );
    await check(
      () => client.documents.include("kb_1", "d_1", { included: true }),
      "POST",
      "/v1/kbs/kb_1/documents/d_1/include",
    );
    await check(
      () => client.documents.upsert("kb_1", { filename: "a.md", text: "x" }),
      "POST",
      "/v1/kbs/kb_1/documents/upsert",
    );
    await check(
      () => client.documents.bulk("kb_1", { operation: "disable", documentIds: ["d_1"] }),
      "POST",
      "/v1/kbs/kb_1/documents/bulk",
    );
    await check(
      () => client.chunks.create("kb_1", "d_1", { content: "x" }),
      "POST",
      "/v1/kbs/kb_1/documents/d_1/chunks",
    );
    await check(() => client.chunks.get("kb_1", "c_1"), "GET", "/v1/kbs/kb_1/chunks/c_1");
    await check(
      () => client.chunks.attachKeyword("kb_1", "c_1", { displayLabel: "Leave" }),
      "PUT",
      "/v1/kbs/kb_1/chunks/c_1/keywords",
    );
    await check(
      () => client.chunks.detachKeyword("kb_1", "c_1", "k_1"),
      "DELETE",
      "/v1/kbs/kb_1/chunks/c_1/keywords/k_1",
    );
    await check(
      () => client.chunks.keywords("kb_1", "c_1"),
      "GET",
      "/v1/kbs/kb_1/chunks/c_1/keywords",
    );
    await check(() => client.keywords.list("kb_1"), "GET", "/v1/kbs/kb_1/keywords");
    await check(
      () => client.keywords.put("kb_1", { displayLabel: "Leave" }),
      "PUT",
      "/v1/kbs/kb_1/keywords",
    );
    await check(
      () => client.keywords.delete("kb_1", "k_1"),
      "DELETE",
      "/v1/kbs/kb_1/keywords/k_1",
    );
    await check(
      () => client.keywords.extract("kb_1", { scope: "all" }),
      "POST",
      "/v1/kbs/kb_1/extract-keywords",
    );
    await check(() => client.clusters.list("kb_1"), "GET", "/v1/kbs/kb_1/clusters");
    await check(() => client.clusters.status("kb_1"), "GET", "/v1/kbs/kb_1/clustering-status");
    await check(() => client.clusters.recluster("kb_1"), "POST", "/v1/kbs/kb_1/recluster");
    await check(() => client.tags.definitions("kb_1"), "GET", "/v1/kbs/kb_1/tag-definitions");
    await check(
      () => client.tags.put("kb_1", { definitions: [{ tagSlot: "tag1", displayName: "D", fieldType: "text" }] }),
      "PUT",
      "/v1/kbs/kb_1/tag-definitions",
    );
    await check(
      () => client.tags.delete("kb_1", "t_1"),
      "DELETE",
      "/v1/kbs/kb_1/tag-definitions/t_1",
    );
    await check(() => client.tags.usage("kb_1"), "GET", "/v1/kbs/kb_1/tag-usage");
    await check(
      () => client.tags.nextAvailableSlot("kb_1", "text"),
      "GET",
      "/v1/kbs/kb_1/next-available-slot",
    );
    await check(() => client.endpoints.get(), "GET", "/v1/endpoints");
    await check(
      () => client.endpoints.put({ source: { kind: "local" }, endpoints: [] }),
      "PUT",
      "/v1/endpoints",
    );
    await check(() => client.webhooks.get(), "GET", "/v1/webhooks");
    await check(
      () =>
        client.webhooks.put({
          url: "https://example.invalid/hook",
          secret: "a-secret-long-enough",
          events: ["document.ingested"],
        }),
      "PUT",
      "/v1/webhooks",
    );
    await check(() => client.webhooks.delete(), "DELETE", "/v1/webhooks");
    await check(() => client.capabilities(), "GET", "/v1/capabilities");
    await check(() => client.whoami(), "GET", "/v1/whoami");
    await check(() => client.pairStatus(), "GET", "/v1/pair/status");
  });

  it("unwraps the collection envelopes the routes answer with", async () => {
    canned = { status: 200, json: ListKbsResponseSchema.parse({ knowledgeBases: [KB] }) };
    await expect(client.kbs.list()).resolves.toEqual([KnowledgeBaseSchema.parse(KB)]);

    // `chunks.keywords` is unwrapped the same way `keywords.list` is, and what
    // it hands back is the *link*: `source` and `attachedAt` come off the join
    // row, so they are not in the KB's vocabulary listing at all.
    const link = {
      id: "k_1",
      knowledgeBaseId: "kb_1",
      keyword: "parental-leave",
      displayLabel: "Parental Leave",
      usageCount: 4,
      createdAt: "2026-09-15T00:00:00.000Z",
      updatedAt: "2026-09-15T00:00:00.000Z",
      createdByUserId: null,
      source: "manual" as const,
      attachedAt: "2026-09-15T01:00:00.000Z",
    };
    canned = { status: 200, json: ListChunkKeywordsResponseSchema.parse({ keywords: [link] }) };
    await expect(client.chunks.keywords("kb_1", "c_1")).resolves.toEqual([link]);
  });

  it("answers `kbs.restore` with the knowledge base, renamed or not", async () => {
    // The restore may have had to rename the KB (`generateRestoreName`), so the
    // route answers with the record rather than an acknowledgement and this
    // method's return type is the record.
    const renamed = { ...KB, name: "Handbook_restored", deletedAt: null };
    canned = { status: 200, json: KnowledgeBaseSchema.parse(renamed) };
    await expect(client.kbs.restore("kb_1")).resolves.toMatchObject({
      name: "Handbook_restored",
      deletedAt: null,
    });
    expect(last().body.length).toBe(0);
  });

  it("addresses a chunk by its own id, with no document in the path", async () => {
    /**
     * The whole point of the chunk-by-id family: a caller that holds
     * `{ knowledgeBaseId, chunkId }` — Studio's chunk editor, its `kb_admin`
     * tool — can now say what it means. The document-addressed methods are
     * still there and still take a document.
     */
    canned = { status: 200, json: {} };
    await client.chunks.get("kb/1", "c/1").catch(() => undefined);
    expect(last().path).toBe("/v1/kbs/kb%2F1/chunks/c%2F1");

    await client.keywords
      .attachToChunk("kb_1", "d_1", "c_1", { displayLabel: "Leave" })
      .catch(() => undefined);
    expect(last().path).toBe("/v1/kbs/kb_1/documents/d_1/chunks/c_1/keywords");
    await client.chunks.attachKeyword("kb_1", "c_1", { displayLabel: "Leave" }).catch(() => undefined);
    expect(last().path).toBe("/v1/kbs/kb_1/chunks/c_1/keywords");
    // Same body either way: one handler, two addresses.
    expect(JSON.parse(last().body.toString("utf8"))).toEqual({ displayLabel: "Leave" });
  });

  it("sends `tagFilters` as one JSON parameter and the rest as scalars", async () => {
    /**
     * A tag filter is a list of conditions — operator, second bound, several on
     * one slot — and a query string holds strings, so the SDK encodes the list
     * once rather than flattening it into `tag1=…` and losing the operators.
     * The route JSON-decodes exactly this.
     */
    canned = { status: 200, json: { documents: [], pagination: EMPTY_PAGE } };
    await client.documents.list("kb_1", {
      limit: 25,
      tagFilters: [
        { tagSlot: "tag1", fieldType: "text", operator: "eq", value: "handbook" },
        { tagSlot: "number1", fieldType: "number", operator: "between", value: "1", valueTo: "9" },
      ],
    });
    const query = new URL(last().path, "http://x").searchParams;
    expect(query.get("limit")).toBe("25");
    expect(JSON.parse(query.get("tagFilters")!)).toEqual([
      { tagSlot: "tag1", fieldType: "text", operator: "eq", value: "handbook" },
      { tagSlot: "number1", fieldType: "number", operator: "between", value: "1", valueTo: "9" },
    ]);

    // Absent, it is not on the path at all — not as `undefined`, not as `[]`.
    await client.documents.list("kb_1", { limit: 25 });
    expect(last().path).toBe("/v1/kbs/kb_1/documents?limit=25");
  });
});

describe("ingest", () => {
  it("sends text as JSON", async () => {
    canned = {
      status: 202,
      json: IngestResponseSchema.parse({ documentId: "d_1", processingStatus: "pending" }),
    };
    await client.kbs.ingest("kb_1", { filename: "a.md", text: "hello" });
    expect(last().headers["content-type"]).toBe("application/json");
    expect(JSON.parse(last().body.toString("utf8"))).toEqual({
      filename: "a.md",
      text: "hello",
    });
  });

  it("sends bytes as a multipart body the route can read", async () => {
    canned = {
      status: 202,
      json: IngestResponseSchema.parse({ documentId: "d_2", processingStatus: "pending" }),
    };
    const bytes = Buffer.from("# Parental leave\r\n\r\nSix weeks.\r\n", "utf8");
    await client.kbs.ingest("kb_1", {
      filename: "handbook.md",
      mimeType: "text/markdown",
      file: bytes,
      metadata: { category: "handbook" },
      tags: { tag1: "handbook" },
    });

    const contentType = String(last().headers["content-type"]);
    expect(contentType).toMatch(/^multipart\/form-data; boundary=----actana-search-[0-9a-f]{32}$/);
    const raw = last().body.toString("binary");
    const boundary = contentType.split("boundary=")[1]!;
    // One file part, and every field part it was given.
    expect(raw).toContain(
      `content-disposition: form-data; name="file"; filename="handbook.md"`,
    );
    expect(raw).toContain("content-type: text/markdown");
    expect(raw).toContain(`content-disposition: form-data; name="filename"`);
    expect(raw).toContain(`content-disposition: form-data; name="tag1"`);
    expect(raw).toContain('{"category":"handbook"}');
    // The bytes survive verbatim, CRLFs included, and the envelope is closed.
    expect(last().body.includes(bytes)).toBe(true);
    expect(raw.endsWith(`--${boundary}--\r\n`)).toBe(true);
  });

  it("gives the boundary a fresh value per request", async () => {
    canned = {
      status: 202,
      json: IngestResponseSchema.parse({ documentId: "d_3", processingStatus: "pending" }),
    };
    await client.kbs.ingest("kb_1", { filename: "a.md", file: Buffer.from("x") });
    const first = String(last().headers["content-type"]);
    await client.kbs.ingest("kb_1", { filename: "a.md", file: Buffer.from("x") });
    expect(String(last().headers["content-type"])).not.toBe(first);
  });
});

describe("attachBlob", () => {
  /** A document row the fake answers the attach with. */
  const DOCUMENT = {
    id: "d_1",
    knowledgeBaseId: "kb_1",
    filename: "handbook.md",
    fileUrl: "/api/files/serve/s3/kb%2F1758000000000-abcd1234-handbook.md",
    fileSize: 12,
    mimeType: "text/markdown",
    chunkCount: 6,
    processedChunks: 6,
    tokenCount: 900,
    characterCount: 3182,
    processingStatus: "completed" as const,
    processingStartedAt: "2026-09-14T00:00:00.000Z",
    processingCompletedAt: "2026-09-14T00:00:01.000Z",
    processingError: null,
    enabled: true,
    includedInKb: true,
    keywordStatus: "extracted",
    uploadedAt: "2026-09-14T00:00:00.000Z",
    deletedAt: null,
    connectorId: null,
    sourceUrl: null,
    tag1: null,
    tag2: null,
    tag3: null,
    tag4: null,
    tag5: null,
    tag6: null,
    tag7: null,
    number1: null,
    number2: null,
    number3: null,
    number4: null,
    number5: null,
    date1: null,
    date2: null,
    boolean1: null,
    boolean2: null,
    boolean3: null,
  };

  it("sends three parts and answers with the document, not an acknowledgement", async () => {
    canned = { status: 200, json: DocumentSchema.parse(DOCUMENT) };
    const bytes = Buffer.from("# Leave\r\n\r\nSix.\r\n", "utf8");
    const answer = await client.documents.attachBlob("kb_1", "d_1", {
      file: bytes,
      filename: "handbook.md",
      mimeType: "text/markdown",
    });

    const contentType = String(last().headers["content-type"]);
    expect(contentType).toMatch(/^multipart\/form-data; boundary=----actana-search-[0-9a-f]{32}$/);
    const raw = last().body.toString("binary");
    expect(raw).toContain(
      `content-disposition: form-data; name="file"; filename="handbook.md"`,
    );
    expect(raw).toContain("content-type: text/markdown");
    expect(raw).toContain(`content-disposition: form-data; name="filename"`);
    expect(raw).toContain(`content-disposition: form-data; name="mimeType"`);
    // The bytes go over verbatim, CRLFs and all — this is a copy, not a parse.
    expect(last().body.includes(bytes)).toBe(true);
    // Nothing that belongs to the row: the document exists and is not being
    // re-described. No `documentId`, no tags, no `includedInKb`, no `metadata`.
    expect(raw).not.toContain(`name="documentId"`);
    expect(raw).not.toContain(`name="includedInKb"`);
    expect(raw).not.toContain(`name="metadata"`);
    expect(raw).not.toContain(`name="tag1"`);

    // What comes back is the document, so a caller sees the new `fileUrl` and
    // that `processingStatus` and `chunkCount` did not move.
    expect(DocumentSchema.safeParse(answer).success).toBe(true);
    expect(answer).toMatchObject({
      fileUrl: DOCUMENT.fileUrl,
      processingStatus: "completed",
      chunkCount: 6,
    });
  });

  it("escapes both ids, so neither can add a path segment", async () => {
    canned = { status: 200, json: {} };
    await client.documents
      .attachBlob("kb/1", "d/1", { file: Buffer.from("x"), filename: "a.md" })
      .catch(() => undefined);
    expect(last().path).toBe("/v1/kbs/kb%2F1/documents/d%2F1/blob");
  });
});

describe("whoami()", () => {
  it("answers the paired client id, the scopes it holds, and the schema version", async () => {
    /**
     * The call Studio's migration needs. `capabilities()` carries no client id
     * and the registration blob has none either, so before this route the id
     * had to come from an operator on a command line.
     */
    canned = {
      status: 200,
      json: WhoamiSchema.parse({
        clientId: "pc_1",
        label: "actanastudio",
        scopes: ["read", "write", "admin"],
        createdAt: "2026-09-15T00:00:00.000Z",
        serialNumber: "0a1b2c3d",
        schemaVersion: 2,
      }),
    };
    const me = await client.whoami();
    expect(last().method).toBe("GET");
    expect(last().path).toBe("/v1/whoami");
    expect(last().body.length).toBe(0);
    expect(me.clientId).toBe("pc_1");
    // Expanded, so a caller asks rather than re-implements the rank.
    expect(me.scopes).toEqual(["read", "write", "admin"]);
    expect(me.schemaVersion).toBe(2);
  });
});

describe("errors", () => {
  it("throws the instance's own code, status and detail", async () => {
    canned = {
      status: 400,
      json: {
        code: "validation-failed",
        message: "the request does not match the contract",
        detail: { issues: [{ path: ["text"], message: "Required" }] },
      },
    };
    const failure = await client.kbs
      .query("kb_1", { text: "q" })
      .then(() => null)
      .catch((err: unknown) => err as SearchApiError);
    expect(failure).toBeInstanceOf(SearchApiError);
    expect(failure).toMatchObject({ code: "validation-failed", status: 400 });
    expect(failure!.detail).toEqual({ issues: [{ path: ["text"], message: "Required" }] });
  });

  it("falls back to `http-<status>` when the body names no code", async () => {
    canned = { status: 502, json: { oops: true } };
    await expect(client.kbs.list()).rejects.toMatchObject({
      code: "http-502",
      status: 502,
    });
  });

  it("reports `unreachable` with status 0 when nothing answered", async () => {
    const nowhere = SearchClient.insecureForTests("http://127.0.0.1:1", "pc_1");
    try {
      await expect(nowhere.health()).rejects.toMatchObject({
        code: "unreachable",
        status: 0,
      });
    } finally {
      await nowhere.close();
    }
  });
});

describe("events()", () => {
  it("yields one event per frame and swallows the heartbeats", async () => {
    const one = {
      id: "evt_1",
      event: "document.ingested",
      occurredAt: "2026-09-14T00:00:00.000Z",
      kbId: "kb_1",
      documentId: "d_1",
      chunkCount: 6,
    };
    const two = { ...one, id: "evt_2", event: "clusters.retrained" };
    canned = {
      sse: [
        ": open\n\n",
        `event: document.ingested\ndata: ${JSON.stringify(one)}\n\n`,
        ": heartbeat\n\n",
        `event: clusters.retrained\ndata: ${JSON.stringify(two)}\n\n`,
      ],
    };

    const got: unknown[] = [];
    for await (const event of client.events()) got.push(event);
    expect(got).toEqual([one, two]);
    expect(last().path).toBe("/v1/events");
    expect(last().headers["accept"]).toBe("text/event-stream");
    expect(last().headers["x-paired-client"]).toBe("pc_1");
  });

  it("reassembles a frame that arrived in pieces", async () => {
    const one = {
      id: "evt_3",
      event: "document.failed",
      occurredAt: "2026-09-14T00:00:00.000Z",
      kbId: "kb_1",
      error: "boom",
    };
    const frame = `event: document.failed\ndata: ${JSON.stringify(one)}\n\n`;
    canned = { sse: [frame.slice(0, 20), frame.slice(20)] };
    const got: unknown[] = [];
    for await (const event of client.events()) got.push(event);
    expect(got).toEqual([one]);
  });

  it("throws the instance's refusal rather than hanging on a closed stream", async () => {
    canned = { status: 403, json: { code: "scope-forbidden", message: "nope" } };
    await expect(async () => {
      for await (const _event of client.events()) void _event;
    }).rejects.toMatchObject({ code: "scope-forbidden", status: 403 });
  });
});

describe("the contracts the fake answers with", () => {
  it("are the contracts, so a drifting fake fails here", async () => {
    canned = {
      status: 200,
      json: CapabilitiesSchema.parse({
        protocol: 1,
        schemaVersion: 2,
        features: [...SEARCH_FEATURES],
        publicHost: "localhost",
      }),
    };
    const capabilities = await client.capabilities();
    expect(CapabilitiesSchema.safeParse(capabilities).success).toBe(true);

    canned = {
      status: 200,
      json: HybridQueryResponseSchema.parse({
        mode: "hybrid",
        matches: [
          {
            id: "c_1",
            documentId: "d_1",
            chunkIndex: 0,
            content: "Six weeks.",
            metadata: { category: "handbook" },
            score: 0.9,
            semanticScore: 0.8,
            keywordScore: 1,
          },
        ],
        usage: {
          embed: { promptTokens: 7, totalTokens: 7 },
          keywords: { promptTokens: 0, totalTokens: 0 },
        },
      }),
    };
    const answer = await client.kbs.query("kb_1", { text: "parental leave" });
    expect(HybridQueryResponseSchema.safeParse(answer).success).toBe(true);

    canned = {
      status: 200,
      json: DocumentSchema.parse({
        id: "d_1",
        knowledgeBaseId: "kb_1",
        filename: "handbook.md",
        fileUrl: "/api/files/serve/s3/kb%2F1-handbook.md",
        fileSize: 3182,
        mimeType: "text/markdown",
        chunkCount: 6,
        processedChunks: 6,
        tokenCount: 900,
        characterCount: 3182,
        processingStatus: "completed",
        processingStartedAt: "2026-09-14T00:00:00.000Z",
        processingCompletedAt: "2026-09-14T00:00:01.000Z",
        processingError: null,
        enabled: true,
        includedInKb: true,
        keywordStatus: "extracted",
        uploadedAt: "2026-09-14T00:00:00.000Z",
        deletedAt: null,
        connectorId: null,
        sourceUrl: null,
        tag1: "handbook",
        tag2: "people",
        tag3: null,
        tag4: null,
        tag5: null,
        tag6: null,
        tag7: null,
        number1: 2026,
        number2: null,
        number3: null,
        number4: null,
        number5: null,
        date1: null,
        date2: null,
        boolean1: true,
        boolean2: null,
        boolean3: null,
      }),
    };
    const document = await client.documents.get("kb_1", "d_1");
    expect(DocumentSchema.safeParse(document).success).toBe(true);
  });
});
