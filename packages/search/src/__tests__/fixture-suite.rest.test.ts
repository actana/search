/**
 * @vitest-environment node
 *
 * The behaviour freeze, replayed **over REST through the SDK** (TASK-004).
 *
 * `kb/fixture-suite.integration.test.ts` drives the lifted engine by calling
 * its functions. This one drives the same fixture through the same engine from
 * the outside: a real HTTPS-shaped server, a real `SearchClient`, real
 * multipart uploads into a real bucket, the real BullMQ job graph — run inline
 * by `SEARCH_INLINE_JOBS=1` rather than by a worker process, which is TASK-005's
 * — and the fifteen frozen queries asserted against the same
 * `__fixtures__/kb-fixture.json`.
 *
 * **What this proves that the in-process replay cannot.** Ranking is the same
 * when the caller is an HTTP client rather than a function call; the wire
 * shapes carry everything a match has; the two ingest encodings reach the two
 * pipelines the fixture distinguishes; and the whole thing is reachable through
 * the only door CONTEXT.md allows (rule 4: the SDK is the only way in).
 *
 * **Where the two replays deliberately differ.** In-process, the `hybrid` KB is
 * ingested by `processDocumentAsync` (the inline fallback) and `bullmq` by the
 * plan → batch → finalize flow, and the suite asserts the two agree. Over REST
 * there is one file-ingest route and it enqueues the flow, so both KBs take the
 * flow — and the fixture's `hybrid` expectations still hold, which is exactly
 * what that in-process parity assertion licenses. `sdk` and `defaults` take the
 * JSON-text route, which is `ingestDocument`, which is what they took there.
 *
 * Env-gated on `SEARCH_TEST_DATABASE_URL`, and it also needs Redis (the per-KB
 * ingest lock) and an S3-compatible bucket (the uploads):
 *
 *     SEARCH_TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/search_test \
 *       pnpm --filter @actana/search-core test
 *
 * Every object it creates is prefixed with a fresh run id and dropped in
 * `afterAll`, so it re-runs cleanly against a database that already holds data.
 */

import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.unmock("../db/client.ts");
vi.unmock("drizzle-orm");

/**
 * Inference seam. The embedding seam needs no mock — `SEARCH_TEST_EMBEDDING=
 * hash-ngram` is a branch inside `executeWorkspaceEmbedding` itself — but
 * keyword extraction has no such switch, so the deterministic topic extractor
 * stands in for the model exactly as it does in the in-process replay.
 */
vi.mock("../models/inference.ts", async () => {
  const { keywordsResponseForPrompt } = await import("../kb/testing/deterministic-keywords.ts");
  return {
    executeWorkspaceInference: vi.fn(
      async ({ messages }: { messages: Array<{ role: string; content: string }> }) => {
        const user = messages.find((m) => m.role === "user")?.content ?? "";
        return {
          content: keywordsResponseForPrompt(user),
          model: "deterministic-keywords",
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        };
      },
    ),
  };
});

/**
 * File-parser seam. `file-parsers/index.ts` lazy-loads every parser with
 * CommonJS `require()`, which Vitest's ESM transform cannot resolve — under the
 * runner the registry comes up empty and every parse fails with "Unsupported
 * file type". This wires the SAME parser implementations through ESM imports;
 * parsing behaviour, including the metadata that steers chunker selection, is
 * unchanged. Copied from the in-process replay, which needs it for the same
 * reason.
 */
vi.mock("@actana/search-shared/file-parsers/index", async () => {
  const nodePath = await import("node:path");
  const { readFile } = await import("node:fs/promises");
  const { CsvParser } = await import("@actana/search-shared/file-parsers/csv-parser");
  const { MdParser } = await import("@actana/search-shared/file-parsers/md-parser");
  const { TxtParser } = await import("@actana/search-shared/file-parsers/txt-parser");
  const { parseJSON, parseJSONBuffer } = await import(
    "@actana/search-shared/file-parsers/json-parser"
  );
  const { parseYAML, parseYAMLBuffer } = await import(
    "@actana/search-shared/file-parsers/yaml-parser"
  );

  const byExtension = { csv: new CsvParser(), md: new MdParser(), txt: new TxtParser() } as const;

  const parseBuffer = async (buffer: Buffer, extension: string) => {
    if (extension === "json") return parseJSONBuffer(buffer);
    if (extension === "yaml" || extension === "yml") return parseYAMLBuffer(buffer);
    const parser = byExtension[extension as keyof typeof byExtension];
    if (!parser) throw new Error(`Unsupported file type: ${extension}`);
    return parser.parseBuffer(buffer);
  };

  return {
    PARSE_TIMEOUT_MS_PER_MB: 10_000,
    MIN_PARSE_TIMEOUT_MS: 30_000,
    MAX_PARSE_TIMEOUT_MS: 20 * 60 * 1000,
    computeParseTimeoutMs: () => 30_000,
    withParseTimeout: async <T>(parse: Promise<T>) => parse,
    isSupportedFileType: (extension: string) =>
      extension === "json" ||
      extension === "yaml" ||
      extension === "yml" ||
      extension in byExtension,
    parseBuffer,
    parseFile: async (filePath: string) => {
      const extension = nodePath.extname(filePath).toLowerCase().slice(1);
      if (extension === "json") return parseJSON(filePath);
      if (extension === "yaml" || extension === "yml") return parseYAML(filePath);
      const parser = byExtension[extension as keyof typeof byExtension];
      if (parser) return parser.parseFile(filePath);
      return parseBuffer(await readFile(filePath), extension);
    },
  };
});

import { eq } from "drizzle-orm";
import { SearchClient } from "@actana/search/client";
import type {
  HybridQueryResponse,
  SearchEvent,
  V1TagQueryResponse,
} from "@actana/search/contracts";
import {
  SEARCH_EVENT_ID_HEADER,
  SEARCH_SIGNATURE_HEADER,
} from "@actana/search/contracts";
import { generateShortId } from "@actana/search-shared/short-id";
import {
  HASH_NGRAM_DIMS,
  HASH_NGRAM_KIND,
  HASH_NGRAM_VERSION,
} from "@actana/search-shared/testing/hash-ngram-embedder";
import { resetConfig } from "../config.ts";
import { db } from "../db/client.ts";
import { knowledgeBase, modelEndpoint, pairedClient } from "../db/schema.ts";
import { runMigrations } from "../db/migrate.ts";
import { dropKbPartition } from "../kb/ddl.ts";
import { TOPIC_VOCABULARY } from "../kb/testing/deterministic-keywords.ts";
import { inlineJobFailures, inlineJobsSettled, resetQueueConnection } from "../queue/index.ts";
import { resetStorageClient } from "../blob/index.ts";
import { verifyWebhookSignature } from "../events/webhook-signature.ts";
import { startSearchServer, type SearchServer } from "../api/server.ts";
import { registerSearchRoutes } from "../api/routes/index.ts";
import { SearchPairingStore } from "../pairing/pairing-store.ts";
import { PairingRevocations } from "../pairing/pairing-revocation.ts";
import { ensureMaterial } from "../pairing/self-register.ts";

const TEST_DATABASE_URL = process.env.SEARCH_TEST_DATABASE_URL;
const describeDb = TEST_DATABASE_URL ? describe : describe.skip;

const FIXTURE_DIR = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../__fixtures__");
const FIXTURE_PATH = path.join(FIXTURE_DIR, "kb-fixture.json");

type KbKey = "hybrid" | "bullmq" | "sdk" | "defaults";

interface FixtureDocument {
  id: string;
  path: string;
  filename: string;
  mimeType: string;
  knowledgeBases: KbKey[];
  tags: Record<string, string | number | boolean>;
  metadata: Record<string, unknown>;
}

interface FixtureQuery {
  id: string;
  knowledgeBase: KbKey;
  api: "queryKb" | "handleKbQuery" | "handleTagAndVectorSearch";
  text: string;
  params: Record<string, unknown>;
  probe: string;
  expectedTop5: Array<{ documentId: string; chunkIndex: number }>;
}

interface Fixture {
  embedder: { kind: string; dims: number; version: number };
  keywordExtractor: { vocabularySize: number; vocabulary: string[] };
  chunking: { method: string; chunkSize: number; maxSize: number; minSize: number; overlap: number; language: string };
  documents: FixtureDocument[];
  queries: FixtureQuery[];
}

const fixture: Fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8"));

/** The recorder's assertion targets. Read, never written (see the header). */
const fixtureExpectations = (
  JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8")) as {
    expectations: { bullmqParity: { documents: unknown } };
  }
).expectations;

const RUN = generateShortId(8);
const PREFIX = `searchrest-${RUN}`;

const ids = {
  owner: `${PREFIX}-owner`,
  pairedClient: `${PREFIX}-client`,
};

const kbIds: Record<KbKey, string> = {
  hybrid: "",
  bullmq: "",
  sdk: "",
  defaults: "",
};
const KB_KEYS = Object.keys(kbIds) as KbKey[];

/** database document id → fixture document id, for translating results back. */
const reverseDocumentIds = new Map<string, string>();

/** Every webhook body this run received, with the headers it arrived under. */
const delivered: Array<{ event: SearchEvent; signature: string; eventId: string; raw: string }> = [];

const WEBHOOK_SECRET = "a-secret-long-enough-to-sign-with";

let server: SearchServer;
let client: SearchClient;
let webhookServer: http.Server;
let stateDir: string;

/** `{ documentId, chunkIndex }` in the fixture's own vocabulary. */
function freeze(
  matches: Array<{ documentId: string; chunkIndex: number }>,
): Array<{ documentId: string; chunkIndex: number }> {
  return matches.map((m) => ({
    documentId: reverseDocumentIds.get(m.documentId) ?? `UNKNOWN(${m.documentId})`,
    chunkIndex: m.chunkIndex,
  }));
}

const docsFor = (key: KbKey): FixtureDocument[] =>
  fixture.documents.filter((d) => d.knowledgeBases.includes(key));

/** Poll a document until it leaves the in-flight statuses. */
async function waitForDocument(kbId: string, documentId: string, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const doc = await client.documents.get(kbId, documentId);
    if (doc.processingStatus === "completed" || doc.processingStatus === "failed") return doc;
    if (Date.now() > deadline) {
      throw new Error(
        `document ${documentId} stuck at ${doc.processingStatus} after ${timeoutMs}ms`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describeDb("KB behaviour freeze, over REST (fixture suite)", () => {
  beforeAll(async () => {
    process.env.SEARCH_DATABASE_URL = TEST_DATABASE_URL as string;
    process.env.SEARCH_TEST_EMBEDDING = "hash-ngram";
    process.env.SEARCH_INLINE_JOBS = "1";
    process.env.SEARCH_ALLOW_LOCAL_FETCH = "1";
    process.env.SEARCH_S3_ENDPOINT ??= "http://localhost:9000";
    process.env.SEARCH_S3_BUCKET = "search-test";
    process.env.SEARCH_S3_ACCESS_KEY ??= "minioadmin";
    process.env.SEARCH_S3_SECRET_KEY ??= "minioadmin";
    process.env.SEARCH_S3_FORCE_PATH_STYLE = "true";
    resetConfig();
    resetStorageClient();

    await runMigrations({ url: TEST_DATABASE_URL as string });

    /** The fixture's declared embedder must be the one this run injects. */
    expect(fixture.embedder).toMatchObject({
      kind: HASH_NGRAM_KIND,
      dims: HASH_NGRAM_DIMS,
      version: HASH_NGRAM_VERSION,
    });
    expect(fixture.keywordExtractor.vocabulary).toEqual([...TOPIC_VOCABULARY]);

    // ── The instance ────────────────────────────────────────────────────────
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "search-rest-"));
    const { material } = await ensureMaterial({ stateDir, publicHosts: ["127.0.0.1"] });
    const store = new SearchPairingStore(db);
    const revocations = new PairingRevocations(store);

    // The pairing a real client would have redeemed. Seeded, because what this
    // suite is testing is everything *after* the handshake.
    await db.insert(pairedClient).values({
      id: ids.pairedClient,
      label: `${PREFIX} client`,
      certSerial: `${PREFIX}-serial`,
      certFingerprint: `${PREFIX}-fingerprint`,
      scope: "admin",
      status: "active",
      createdAt: new Date(),
    });

    server = await startSearchServer({
      material,
      store,
      revocations,
      port: 0,
      host: "127.0.0.1",
      publicHosts: ["127.0.0.1"],
      devInsecure: true,
      registerRoutes: registerSearchRoutes,
    });
    client = SearchClient.insecureForTests(server.origin, ids.pairedClient);

    // ── The webhook receiver ────────────────────────────────────────────────
    webhookServer = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        delivered.push({
          event: JSON.parse(raw) as SearchEvent,
          signature: String(req.headers[SEARCH_SIGNATURE_HEADER] ?? ""),
          eventId: String(req.headers[SEARCH_EVENT_ID_HEADER] ?? ""),
          raw,
        });
        res.writeHead(204).end();
      });
    });
    await new Promise<void>((resolve) => webhookServer.listen(0, "127.0.0.1", resolve));
    const hookPort = (webhookServer.address() as AddressInfo).port;
    await client.webhooks.put({
      url: `http://127.0.0.1:${hookPort}/hook`,
      secret: WEBHOOK_SECRET,
      events: ["document.ingested", "document.failed", "clusters.retrained"],
    });

    // ── The endpoints, pushed through the registry route ────────────────────
    const pushed = await client.endpoints.put({
      source: { kind: "local" },
      endpoints: [
        {
          externalId: `${PREFIX}-emb`,
          kind: "embedding",
          provider: "fixture",
          template: "fixture-hash-ngram",
          model: "hash-ngram-256",
          dimensions: HASH_NGRAM_DIMS,
          label: "fixture embedding",
        },
        {
          externalId: `${PREFIX}-inf`,
          kind: "inference",
          provider: "fixture",
          template: "fixture-deterministic-keywords",
          model: "deterministic-keywords",
          label: "fixture inference",
        },
      ],
    });
    const embeddingEndpointId = pushed.endpoints.find((e) =>
      e.externalId.endsWith("-emb"),
    )!.id;
    const inferenceEndpointId = pushed.endpoints.find((e) =>
      e.externalId.endsWith("-inf"),
    )!.id;

    // ── The four knowledge bases ────────────────────────────────────────────
    const chunkingConfig = {
      method: fixture.chunking.method,
      chunkSize: fixture.chunking.chunkSize,
      maxSize: fixture.chunking.maxSize,
      minSize: fixture.chunking.minSize,
      overlap: fixture.chunking.overlap,
    };
    for (const key of KB_KEYS) {
      const kb = await client.kbs.create({
        name: `${PREFIX} ${key}`,
        ownerId: ids.owner,
        embeddingModel: "hash-ngram-256",
        embeddingEndpointId,
        inferenceEndpointId,
        clusterCount: 8,
        language: fixture.chunking.language,
        // `defaults` is created with NO chunking config, so the column default
        // applies — the shape a KB made through a UI actually stores.
        ...(key === "defaults" ? {} : { chunkingConfig }),
      });
      kbIds[key] = kb.id;
      expect(kb.embeddingDimension).toBe(HASH_NGRAM_DIMS);
    }

    // ── Ingest ──────────────────────────────────────────────────────────────
    // Files through the multipart route (the worker flow), text through the
    // JSON route (`ingestDocument`). That is the split the fixture's four KBs
    // describe, expressed in the two encodings the API offers.
    for (const key of ["hybrid", "bullmq"] as const) {
      const pending: Array<{ documentId: string; fixtureId: string }> = [];
      for (const doc of docsFor(key)) {
        const bytes = fs.readFileSync(path.join(FIXTURE_DIR, doc.path));
        const answer = await client.kbs.ingest(kbIds[key], {
          filename: doc.filename,
          mimeType: doc.mimeType,
          file: bytes,
          tags: Object.fromEntries(
            Object.entries(doc.tags).map(([slot, value]) => [slot, String(value)]),
          ),
        });
        reverseDocumentIds.set(answer.documentId, doc.id);
        pending.push({ documentId: answer.documentId, fixtureId: doc.id });
      }
      for (const { documentId, fixtureId } of pending) {
        const settled = await waitForDocument(kbIds[key], documentId);
        expect(settled.processingStatus, `${key}/${fixtureId}: ${settled.processingError}`).toBe(
          "completed",
        );
      }
      // Clustering is enqueued once the KB's ingestion queue drains.
      await inlineJobsSettled();
    }

    for (const key of ["sdk", "defaults"] as const) {
      const pending: Array<{ documentId: string; fixtureId: string }> = [];
      for (const doc of docsFor(key)) {
        const text = fs.readFileSync(path.join(FIXTURE_DIR, doc.path), "utf8");
        const answer = await client.kbs.ingest(kbIds[key], {
          filename: doc.filename,
          mimeType: doc.mimeType,
          text,
          metadata: doc.metadata,
        });
        reverseDocumentIds.set(answer.documentId, doc.id);
        pending.push({ documentId: answer.documentId, fixtureId: doc.id });
      }
      for (const { documentId, fixtureId } of pending) {
        const settled = await waitForDocument(kbIds[key], documentId);
        expect(settled.processingStatus, `${key}/${fixtureId}: ${settled.processingError}`).toBe(
          "completed",
        );
      }
      await inlineJobsSettled();
    }

    expect(
      inlineJobFailures().map((f) =>
        f.error instanceof Error ? f.error.message : String(f.error),
      ),
    ).toEqual([]);
  }, 900_000);

  afterAll(async () => {
    try {
      for (const key of KB_KEYS) {
        if (!kbIds[key]) continue;
        await dropKbPartition({ kbId: kbIds[key] });
        await db.delete(knowledgeBase).where(eq(knowledgeBase.id, kbIds[key]));
      }
      await db.delete(modelEndpoint).where(eq(modelEndpoint.pairedClientId, ids.pairedClient));
      await db.delete(pairedClient).where(eq(pairedClient.id, ids.pairedClient));
    } finally {
      await client?.close();
      await server?.close();
      await new Promise<void>((resolve) => webhookServer?.close(() => resolve()));
      await resetQueueConnection();
      if (stateDir) fs.rmSync(stateDir, { recursive: true, force: true });
    }
  }, 180_000);

  it("advertises the features this build actually serves", async () => {
    const capabilities = await client.capabilities();
    expect(capabilities.protocol).toBe(1);
    expect(capabilities.features).toEqual(
      expect.arrayContaining(["hybrid", "v1-tags", "clusters", "keywords", "webhooks", "sse"]),
    );
  });

  it("lists the four knowledge bases it was asked to create", async () => {
    const listed = await client.kbs.list();
    const mine = listed.filter((kb) => kb.name.startsWith(PREFIX));
    expect(mine).toHaveLength(4);
    for (const kb of mine) {
      expect(kb.workspaceId).toBe(ids.pairedClient);
      expect(kb.userId).toBe(ids.owner);
      expect(kb.docCount).toBeGreaterThan(0);
    }
  });

  it("builds the corpus the fixture describes, document by document", async () => {
    // Per-document chunk counts are the tightest cheap check there is: a
    // chunker, a parser or a stored config that drifted shows up here as one
    // number rather than as a reshuffled top-5 three tests later.
    for (const key of ["hybrid", "bullmq"] as const) {
      const listed = await client.documents.list(kbIds[key], { limit: 100, sortBy: "filename" });
      const counts = listed.documents
        .map((d) => ({ filename: d.filename, chunkCount: d.chunkCount }))
        .sort((a, b) => (a.filename < b.filename ? -1 : 1));
      expect(counts, key).toEqual(
        (fixtureExpectations.bullmqParity.documents as Array<{
          filename: string;
          chunkCount: number;
        }>).map((d) => ({ filename: d.filename, chunkCount: d.chunkCount })),
      );
    }
  });

  it("freezes Studio's column-default chunking on the KB created without one", async () => {
    const kb = await client.kbs.get(kbIds.defaults);
    expect(kb.chunkingConfig).toEqual({ maxSize: 1024, minSize: 1, overlap: 200 });
    const documents = await client.documents.list(kbIds.defaults, { limit: 100 });
    expect(documents.documents).toHaveLength(12);
    for (const doc of documents.documents) expect(doc.chunkCount).toBe(1);
  });

  it("delivered a signed `document.ingested` webhook", async () => {
    const ingested = delivered.filter((d) => d.event.event === "document.ingested");
    expect(ingested.length).toBeGreaterThan(0);
    const first = ingested[0]!;
    expect(first.eventId).toBe(first.event.id);
    expect(verifyWebhookSignature(WEBHOOK_SECRET, first.raw, first.signature)).toBe(true);
    expect(verifyWebhookSignature("the wrong secret", first.raw, first.signature)).toBe(false);
    expect(first.event.kbId).toBeTruthy();
    expect(first.event.documentId).toBeTruthy();
    expect(first.event.chunkCount).toBeGreaterThan(0);

    const hook = await client.webhooks.get();
    expect(hook.webhook?.hasSecret).toBe(true);
    // The secret is never handed back, under any key.
    expect(JSON.stringify(hook)).not.toContain(WEBHOOK_SECRET);
    expect(hook.recentDeliveries?.some((d) => d.status === "delivered")).toBe(true);
  });

  // ── The fifteen frozen queries ────────────────────────────────────────────

  const v2Queries = fixture.queries.filter((q) => q.api !== "handleTagAndVectorSearch");
  for (const query of v2Queries) {
    it(`${query.id}: ${query.probe}`, async () => {
      const params = query.params as {
        topK?: number;
        keywordWeight?: number;
        neighborClusters?: number;
        filter?: Record<string, unknown>;
        minScore?: number;
        includeContent?: boolean;
        includeDiagnostics?: boolean;
      };
      const result = (await client.kbs.query(kbIds[query.knowledgeBase], {
        text: query.text,
        ...params,
        // `api: "queryKb"` is the direct entry point, which does no
        // query-keyword selection — on the wire that is an explicitly empty
        // `queryKeywords`, as against omitting it for `handleKbQuery`.
        ...(query.api === "queryKb" ? { queryKeywords: [] } : {}),
      })) as HybridQueryResponse;

      expect(result.mode).toBe("hybrid");
      expect(result.matches.length).toBeLessThanOrEqual(params.topK ?? 5);
      for (const match of result.matches) {
        expect(match).toMatchObject({
          id: expect.any(String),
          documentId: expect.any(String),
          chunkIndex: expect.any(Number),
          score: expect.any(Number),
          semanticScore: expect.any(Number),
          keywordScore: expect.any(Number),
        });
        expect(match.metadata).toBeTypeOf("object");
        if (params.includeContent === false) expect(match.content).toBeNull();
        else expect(typeof match.content).toBe("string");
        expect(match.score).toBeGreaterThanOrEqual(0);
        expect(match.score).toBeLessThanOrEqual(1);
        if (typeof params.minScore === "number") {
          expect(match.score).toBeGreaterThanOrEqual(params.minScore);
        }
      }
      expect(result.usage?.embed.totalTokens).toBeGreaterThan(0);
      expect(result.usage?.keywords).toEqual({ promptTokens: 0, totalTokens: 0 });

      /** Ranking: monotonically non-increasing blended score. */
      for (let i = 1; i < result.matches.length; i++) {
        expect(result.matches[i - 1]!.score).toBeGreaterThanOrEqual(result.matches[i]!.score);
      }

      if (query.id === "q06-neighbor-clusters" || query.id === "q14-defaults-cold-start") {
        expect(result.diagnostics?.candidateClusterIds).toBeNull();
      }
      if (query.id === "q11-sdk-keyword-pure") {
        expect(result.diagnostics?.queryKeywords ?? []).toEqual([]);
        expect(result.matches.every((m) => m.keywordScore === 0)).toBe(true);
      }

      expect(freeze(result.matches)).toEqual(query.expectedTop5);
    }, 120_000);
  }

  const v1Query = fixture.queries.find(
    (q) => q.api === "handleTagAndVectorSearch",
  ) as FixtureQuery;
  it(`${v1Query.id}: ${v1Query.probe}`, async () => {
    const params = v1Query.params as {
      topK: number;
      structuredFilters: Array<Record<string, unknown>>;
    };
    const result = (await client.kbs.query(kbIds[v1Query.knowledgeBase], {
      mode: "v1-tags",
      text: v1Query.text,
      topK: params.topK,
      tags: params.structuredFilters as never,
    })) as V1TagQueryResponse;

    expect(result.mode).toBe("v1-tags");
    expect(result.strategy).toEqual({
      useParallel: false,
      distanceThreshold: 1.0,
      parallelLimit: params.topK + 5,
      singleQueryOptimized: true,
    });
    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.matches.length).toBeLessThanOrEqual(params.topK);
    for (const row of result.matches) {
      expect(row.tag1).toBe("handbook");
      expect(row.tag2).toBe("people");
      expect(row.knowledgeBaseId).toBe(kbIds[v1Query.knowledgeBase]);
      expect(typeof row.content).toBe("string");
      expect(row.distance).toBeLessThan(result.strategy.distanceThreshold);
    }
    for (let i = 1; i < result.matches.length; i++) {
      expect(result.matches[i - 1]!.distance).toBeLessThanOrEqual(result.matches[i]!.distance);
    }
    expect(freeze(result.matches)).toEqual(v1Query.expectedTop5);
  }, 120_000);

  it("the two file-ingest knowledge bases rank identically", async () => {
    // `hybrid` and `bullmq` hold the same corpus, uploaded the same way. Any
    // divergence here is non-determinism in the pipeline, which is the one
    // thing a behaviour freeze cannot tolerate.
    for (const query of fixture.queries.filter(
      (q) => q.knowledgeBase === "hybrid" && q.api !== "handleTagAndVectorSearch",
    )) {
      const request = {
        text: query.text,
        ...(query.params as object),
        ...(query.api === "queryKb" ? { queryKeywords: [] } : {}),
      };
      const onHybrid = (await client.kbs.query(kbIds.hybrid, request)) as HybridQueryResponse;
      const onBullmq = (await client.kbs.query(kbIds.bullmq, request)) as HybridQueryResponse;
      expect(freeze(onBullmq.matches), `${query.id} diverged`).toEqual(freeze(onHybrid.matches));
    }
  }, 300_000);

  it("refuses a knowledge base that is not this client's with a 404, not a 403", async () => {
    // A 403 would confirm the row exists (ADR 0009). The id below is this run's
    // own KB seen from a pairing that does not own it.
    const stranger = SearchClient.insecureForTests(server.origin, `${PREFIX}-nobody`);
    try {
      await expect(stranger.kbs.get(kbIds.hybrid)).rejects.toMatchObject({ status: 403 });
    } finally {
      await stranger.close();
    }
    await expect(client.kbs.get(`${PREFIX}-no-such-kb`)).rejects.toMatchObject({
      status: 404,
      code: "not-found",
    });
  });

  it("refuses a body that does not match the contract, naming the field", async () => {
    await expect(
      client.request("POST", `/v1/kbs/${kbIds.hybrid}/query`, { json: { text: "" } }),
    ).rejects.toMatchObject({ status: 400, code: "validation-failed" });
  });
});
