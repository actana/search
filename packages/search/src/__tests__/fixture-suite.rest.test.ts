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
  ChunkSchema,
  DocumentSchema,
  ListChunkKeywordsResponseSchema,
  ListDocumentsResponseSchema,
  SEARCH_EVENT_ID_HEADER,
  SEARCH_SIGNATURE_HEADER,
  WhoamiSchema,
} from "@actana/search/contracts";
import { generateShortId } from "@actana/search-shared/short-id";
import {
  HASH_NGRAM_DIMS,
  HASH_NGRAM_KIND,
  HASH_NGRAM_VERSION,
} from "@actana/search-shared/testing/hash-ngram-embedder";
import { resetConfig } from "../config.ts";
import { db } from "../db/client.ts";
import { document, knowledgeBase, modelEndpoint, pairedClient } from "../db/schema.ts";
import { runMigrations } from "../db/migrate.ts";
import { dropKbPartition } from "../kb/ddl.ts";
import { resolveKbEmbeddingEndpoint } from "../kb/provider-context.ts";
import { executeWorkspaceEmbedding } from "../models/embedding.ts";
import { getQueryStrategy, handleVectorOnlySearch } from "../v1/knowledge-search-utils.ts";
import { TOPIC_VOCABULARY } from "../kb/testing/deterministic-keywords.ts";
import { inlineJobFailures, inlineJobsSettled, resetQueueConnection } from "../queue/index.ts";
import { onSearchEvent } from "../events/emitter.ts";
import { resetAnnouncedEvents, runSearchJob } from "../jobs/run.ts";
import {
  downloadFile,
  isInternalFileUrl,
  parseInternalFileUrl,
  resetStorageClient,
} from "../blob/index.ts";
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
  /** A second, real paired client. Every "not yours" assertion needs one. */
  ownerB: `${PREFIX}-owner-b`,
  pairedClientB: `${PREFIX}-client-b`,
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
/** The second paired client, for the refusals that need somebody else. */
let clientB: SearchClient;
let webhookServer: http.Server;
let stateDir: string;

/** This run's endpoint ids, per client: the ownership checks compare them. */
const endpointIds = { embedding: "", inference: "", embeddingB: "" };

/**
 * KBs outside the frozen four, dropped the same way in `afterAll`.
 *
 * The four fixture KBs hold a corpus this suite asserts document-for-document,
 * so the tests that *write* — a document id of the caller's choosing, an
 * excluded upload — use a KB of their own. Named without `PREFIX` so the
 * "lists the four knowledge bases" assertion still counts four.
 */
const extraKbIds: string[] = [];
/** Client A's scratch KB. */
let sandboxKbId = "";
/** Client B's own KB — what B is allowed to see, beside what it is not. */
let clientBKbId = "";
/** A completed document in {@link sandboxKbId}. */
let sandboxDocumentId = "";

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

/**
 * A `multipart/form-data` body by hand, for the parts the SDK does not send.
 *
 * `client.kbs.ingest` builds a well-formed form out of a typed input; a test
 * that wants a *malformed* part — `metadata: "not json"` — has to write the
 * form itself. The SDK encodes whatever `FormData` it is handed.
 */
function multipartForm(parts: { file: Buffer; filename: string } & Record<string, unknown>): FormData {
  const form = new FormData();
  const { file, filename, ...rest } = parts;
  form.append("file", new Blob([new Uint8Array(file)], { type: "text/markdown" }), filename);
  form.append("filename", filename);
  for (const [key, value] of Object.entries(rest)) {
    if (value !== undefined) form.append(key, String(value));
  }
  return form;
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

    /** The second one. Same kind of row, no KB allow-list, `admin` scope: so
     * every refusal it collects below is about *ownership* and nothing else. */
    await db.insert(pairedClient).values({
      id: ids.pairedClientB,
      label: `${PREFIX} client b`,
      certSerial: `${PREFIX}-serial-b`,
      certFingerprint: `${PREFIX}-fingerprint-b`,
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
    clientB = SearchClient.insecureForTests(server.origin, ids.pairedClientB);

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
    endpointIds.embedding = embeddingEndpointId;
    endpointIds.inference = inferenceEndpointId;

    // Client B's own endpoint. It has one so that "B may bind its own and not
    // A's" is two assertions rather than one.
    const pushedB = await clientB.endpoints.put({
      source: { kind: "local" },
      endpoints: [
        {
          externalId: `${PREFIX}-emb-b`,
          kind: "embedding",
          provider: "fixture",
          template: "fixture-hash-ngram",
          model: "hash-ngram-256",
          dimensions: HASH_NGRAM_DIMS,
          label: "fixture embedding (client b)",
        },
      ],
    });
    endpointIds.embeddingB = pushedB.endpoints[0]!.id;

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

    // ── The two KBs outside the freeze ─────────────────────────────────────
    // A scratch KB for the tests that write, and client B's own, so that "not
    // yours" can be asserted against a client that has something of its own.
    const sandbox = await client.kbs.create({
      name: `zz-sandbox-${RUN}`,
      ownerId: ids.owner,
      embeddingModel: "hash-ngram-256",
      embeddingEndpointId: endpointIds.embedding,
      inferenceEndpointId: endpointIds.inference,
      clusterCount: 8,
      language: "english",
    });
    sandboxKbId = sandbox.id;
    extraKbIds.push(sandboxKbId);

    const kbForB = await clientB.kbs.create({
      name: `zz-clientb-${RUN}`,
      ownerId: ids.ownerB,
      embeddingModel: "hash-ngram-256",
      embeddingEndpointId: endpointIds.embeddingB,
      clusterCount: 8,
      language: "english",
    });
    clientBKbId = kbForB.id;
    extraKbIds.push(clientBKbId);

    const sandboxDoc = await client.kbs.ingest(sandboxKbId, {
      filename: "sandbox-seed.md",
      mimeType: "text/markdown",
      text: "# Sandbox\n\nA document the write tests can point at.\n",
    });
    sandboxDocumentId = sandboxDoc.documentId;
    expect((await waitForDocument(sandboxKbId, sandboxDocumentId)).processingStatus).toBe(
      "completed",
    );
    await inlineJobsSettled();

    expect(
      inlineJobFailures().map((f) =>
        f.error instanceof Error ? f.error.message : String(f.error),
      ),
    ).toEqual([]);
  }, 900_000);

  afterAll(async () => {
    try {
      for (const kbId of [...KB_KEYS.map((key) => kbIds[key]), ...extraKbIds]) {
        if (!kbId) continue;
        await dropKbPartition({ kbId });
        await db.delete(knowledgeBase).where(eq(knowledgeBase.id, kbId));
      }
      for (const clientId of [ids.pairedClient, ids.pairedClientB]) {
        await db.delete(modelEndpoint).where(eq(modelEndpoint.pairedClientId, clientId));
        await db.delete(pairedClient).where(eq(pairedClient.id, clientId));
      }
    } finally {
      await client?.close();
      await clientB?.close();
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
    // Present on this path — it is the one the threshold ran on — and the
    // `toEqual` above is what proves it; `!` is that assertion, not a guess.
    const ranThreshold = result.strategy.distanceThreshold!;
    for (const row of result.matches) {
      expect(row.tag1).toBe("handbook");
      expect(row.tag2).toBe("people");
      expect(row.knowledgeBaseId).toBe(kbIds[v1Query.knowledgeBase]);
      expect(typeof row.content).toBe("string");
      expect(row.distance).toBeLessThan(ranThreshold);
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

  it("refuses a caller that is no paired client at all with a 403, and an unknown KB with a 404", async () => {
    /**
     * Two refusals that are *not* the ownership one, under an accurate title.
     *
     * `${PREFIX}-nobody` has no `paired_client` row, so it never gets an
     * identity and the router answers `403 client-certificate-required` — which
     * is the certificate gate, not ADR 0009 D5. This test used to claim it was
     * the "404, not 403" case; the test below is that case.
     */
    const stranger = SearchClient.insecureForTests(server.origin, `${PREFIX}-nobody`);
    try {
      await expect(stranger.kbs.get(kbIds.hybrid)).rejects.toMatchObject({
        status: 403,
        code: "client-certificate-required",
      });
    } finally {
      await stranger.close();
    }
    await expect(client.kbs.get(`${PREFIX}-no-such-kb`)).rejects.toMatchObject({
      status: 404,
      code: "not-found",
    });
  });

  it("refuses another paired client's knowledge base with a 404 on every route that names it", async () => {
    // The ADR 0009 D5 case, and it needs a *real* second client: a 403 here
    // would confirm that the id names something, which is what makes an id
    // space worth walking. Client B is paired, scoped `admin`, and has a KB of
    // its own — so the only thing wrong with these requests is whose KB it is.
    const foreign = kbIds.hybrid;
    const notFound = { status: 404, code: "not-found" };

    await expect(clientB.kbs.get(foreign)).rejects.toMatchObject(notFound);
    await expect(clientB.kbs.update(foreign, { name: `stolen-${RUN}` })).rejects.toMatchObject(
      notFound,
    );
    await expect(clientB.kbs.query(foreign, { text: "parental leave" })).rejects.toMatchObject(
      notFound,
    );
    await expect(clientB.documents.list(foreign)).rejects.toMatchObject(notFound);
    await expect(clientB.keywords.list(foreign)).rejects.toMatchObject(notFound);
    await expect(clientB.clusters.list(foreign)).rejects.toMatchObject(notFound);
    await expect(clientB.tags.definitions(foreign)).rejects.toMatchObject(notFound);
    await expect(clientB.keywords.extract(foreign, { scope: "all" })).rejects.toMatchObject(
      notFound,
    );
    await expect(clientB.kbs.delete(foreign)).rejects.toMatchObject(notFound);

    // And the KB is untouched, which is the other half of "404": a refusal that
    // had already written something would be a 404 with a side effect.
    expect((await client.kbs.get(foreign)).name).toBe(`${PREFIX} hybrid`);

    // B's own KB answers on the same routes, so none of the above is B being
    // refused for some other reason.
    expect((await clientB.kbs.get(clientBKbId)).id).toBe(clientBKbId);
    expect((await clientB.documents.list(clientBKbId)).documents).toEqual([]);
  });

  it("refuses a model endpoint that is not this client's, on create and on patch", async () => {
    /**
     * The frozen service looks an endpoint up by id with no owner predicate and
     * never looks the inference one up at all, so without the route's check
     * client B could bind its own KB to client A's sealed provider key and have
     * this instance spend it. 404 rather than 403: the id must not be confirmed
     * to exist (ADR 0009 D5).
     */
    await expect(
      clientB.kbs.create({
        name: `zz-theft-${RUN}`,
        embeddingModel: "hash-ngram-256",
        embeddingEndpointId: endpointIds.embedding,
      }),
    ).rejects.toMatchObject({ status: 404, code: "not-found" });

    await expect(
      clientB.kbs.create({
        name: `zz-theft-inference-${RUN}`,
        embeddingModel: "hash-ngram-256",
        embeddingEndpointId: endpointIds.embeddingB,
        inferenceEndpointId: endpointIds.inference,
      }),
    ).rejects.toMatchObject({ status: 404, code: "not-found" });

    await expect(
      clientB.kbs.update(clientBKbId, { inferenceEndpointId: endpointIds.inference }),
    ).rejects.toMatchObject({ status: 404, code: "not-found" });

    // Nothing was bound, and B's own id still is.
    const kb = await clientB.kbs.get(clientBKbId);
    expect(kb.inferenceEndpointId).toBeNull();
    expect(kb.embeddingEndpointId).toBe(endpointIds.embeddingB);
  });

  it("refuses an endpoint `baseUrl` the SSRF guard refuses", async () => {
    // `baseUrl` is fetched (`models/embedding.ts` posts to it), so it goes
    // through the same guard as `resolverUrl`. The link-local address is the
    // one that matters: it is where a cloud instance keeps its credentials.
    const declaration = {
      externalId: `${PREFIX}-emb-ssrf`,
      kind: "embedding" as const,
      provider: "fixture",
      template: "fixture-hash-ngram",
      model: "hash-ngram-256",
      dimensions: HASH_NGRAM_DIMS,
      label: "fixture embedding (ssrf)",
    };
    for (const baseUrl of [
      "https://169.254.169.254/latest/meta-data",
      "https://10.0.0.5/v1",
      "http://example.com/v1",
    ]) {
      await expect(
        clientB.endpoints.put({
          source: { kind: "local" },
          endpoints: [{ ...declaration, baseUrl }],
        }),
      ).rejects.toMatchObject({ status: 400, code: "bad-request" });
    }

    // Refused before anything was written: B still has exactly the endpoint it
    // declared in `beforeAll`, and the failed pushes did not reconcile it away.
    const listed = await clientB.endpoints.get();
    expect(listed.endpoints.map((e) => e.id)).toEqual([endpointIds.embeddingB]);
  });

  it("honours `includedInKb: false` on a multipart ingest", async () => {
    // The multipart contract carries `includedInKb` and the SDK sends it; the
    // route used to ignore it and chunk the document anyway.
    const answer = await client.kbs.ingest(sandboxKbId, {
      filename: "excluded.md",
      mimeType: "text/markdown",
      file: Buffer.from("# Zanzibarian telemetry\n\nA phrase nothing else uses.\n", "utf8"),
      includedInKb: false,
    });
    await inlineJobsSettled();

    const doc = await client.documents.get(sandboxKbId, answer.documentId);
    expect(doc.includedInKb).toBe(false);
    expect(doc.chunkCount).toBe(0);

    // And it is not in the corpus: the phrase is unique to it.
    const result = (await client.kbs.query(sandboxKbId, {
      text: "Zanzibarian telemetry",
      topK: 10,
      queryKeywords: [],
    })) as HybridQueryResponse;
    expect(result.matches.map((m) => m.documentId)).not.toContain(answer.documentId);
  });

  it("refuses a `metadata` form part that is not a JSON object", async () => {
    await expect(
      client.request("POST", `/v1/kbs/${sandboxKbId}/documents`, {
        multipart: multipartForm({
          file: Buffer.from("hello", "utf8"),
          filename: "bad-metadata.md",
          metadata: "not json at all",
        }),
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      client.request("POST", `/v1/kbs/${sandboxKbId}/documents`, {
        multipart: multipartForm({
          file: Buffer.from("hello", "utf8"),
          filename: "bad-included.md",
          includedInKb: "perhaps",
        }),
      }),
    ).rejects.toMatchObject({ status: 400, code: "bad-request" });
  });

  it("keeps the caller's own `documentId`, in both encodings", async () => {
    // Studio's wrapper (TASK-009) ingests rows whose ids its callers already
    // hold: the ids have to be the same either side of the wire.
    const jsonId = `${PREFIX}-mine-json`;
    const jsonAnswer = await client.kbs.ingest(sandboxKbId, {
      filename: "mine-json.md",
      mimeType: "text/markdown",
      text: "# Mine\n\nWith an id I chose.\n",
      documentId: jsonId,
    });
    expect(jsonAnswer.documentId).toBe(jsonId);
    expect((await waitForDocument(sandboxKbId, jsonId)).processingStatus).toBe("completed");

    const fileId = `${PREFIX}-mine-multipart`;
    const fileAnswer = await client.kbs.ingest(sandboxKbId, {
      filename: "mine-file.md",
      mimeType: "text/markdown",
      file: Buffer.from("# Mine too\n\nUploaded with an id I chose.\n", "utf8"),
      documentId: fileId,
    });
    expect(fileAnswer.documentId).toBe(fileId);
    expect((await waitForDocument(sandboxKbId, fileId)).processingStatus).toBe("completed");
    await inlineJobsSettled();
  });

  it("treats the same `documentId` in the same KB as an idempotent re-ingest", async () => {
    const id = `${PREFIX}-idempotent`;
    const first = await client.kbs.ingest(sandboxKbId, {
      filename: "idempotent.md",
      mimeType: "text/markdown",
      text: "# Twice\n\nPosted twice, one row.\n",
      documentId: id,
    });
    expect(first.documentId).toBe(id);
    await waitForDocument(sandboxKbId, id);
    await inlineJobsSettled();

    const before = await client.documents.list(sandboxKbId, { limit: 200 });
    const second = await client.kbs.ingest(sandboxKbId, {
      filename: "idempotent.md",
      mimeType: "text/markdown",
      text: "# Twice\n\nPosted twice, one row.\n",
      documentId: id,
    });
    // The existing document's status, and no second row.
    expect(second.documentId).toBe(id);
    expect(second.processingStatus).toBe("completed");
    const after = await client.documents.list(sandboxKbId, { limit: 200 });
    expect(after.documents.filter((d) => d.id === id)).toHaveLength(1);
    expect(after.documents).toHaveLength(before.documents.length);
    await inlineJobsSettled();
  });

  it("refuses a `documentId` that is taken in another knowledge base", async () => {
    // `document.id` is the primary key across every KB on the instance, so
    // honouring the id would be an overwrite or an ingest into somebody else's
    // KB. 409, and it says nothing about whose.
    await expect(
      client.kbs.ingest(kbIds.sdk, {
        filename: "collision.md",
        mimeType: "text/markdown",
        text: "# Collision\n",
        documentId: sandboxDocumentId,
      }),
    ).rejects.toMatchObject({ status: 409, code: "conflict" });

    await expect(
      client.kbs.ingest(kbIds.sdk, {
        filename: "collision-file.md",
        mimeType: "text/markdown",
        file: Buffer.from("# Collision\n", "utf8"),
        documentId: sandboxDocumentId,
      }),
    ).rejects.toMatchObject({ status: 409, code: "conflict" });

    // Across clients too: B cannot claim an id A is using.
    await expect(
      clientB.kbs.ingest(clientBKbId, {
        filename: "collision-b.md",
        mimeType: "text/markdown",
        text: "# Collision\n",
        documentId: sandboxDocumentId,
      }),
    ).rejects.toMatchObject({ status: 409, code: "conflict" });

    // And A's document is what it was.
    expect((await client.documents.get(sandboxKbId, sandboxDocumentId)).filename).toBe(
      "sandbox-seed.md",
    );
  });

  it("refuses `extract-keywords` for a document that is not in the named KB", async () => {
    // The job it enqueues carries `{ documentId, knowledgeBaseId }`, and a job's
    // announcement reads the document row and publishes to *that row's* owner —
    // so an unchecked `documentId` was a way onto another client's event stream.
    await expect(
      clientB.keywords.extract(clientBKbId, { scope: "document", documentId: sandboxDocumentId }),
    ).rejects.toMatchObject({ status: 404, code: "not-found" });

    // Same client, wrong KB: also refused, because the pair is what is checked.
    await expect(
      client.keywords.extract(kbIds.sdk, { scope: "document", documentId: sandboxDocumentId }),
    ).rejects.toMatchObject({ status: 404, code: "not-found" });

    // And the honest pair is accepted, so the refusals are about the pair and
    // not about the route.
    expect(
      await client.keywords.extract(sandboxKbId, {
        scope: "document",
        documentId: sandboxDocumentId,
      }),
    ).toEqual({ documents: 1 });
    await inlineJobsSettled();
  });

  it("does not announce a document's event on the strength of another KB's payload", async () => {
    /**
     * The other side of the same hole. `announce` reads the document row by id
     * and publishes to that row's owner, so a payload naming somebody else's KB
     * would have produced a real `document.ingested` on this client's stream.
     *
     * The emitter is the observation point rather than the webhook: event ids
     * are deterministic and the delivery ledger's unique index turns a second
     * POST of the same event into a no-op, so a webhook cannot see a re-announce
     * at all.
     */
    const seen: SearchEvent[] = [];
    const off = onSearchEvent(ids.pairedClient, (event) => seen.push(event));
    try {
      // Calibration: the honest pair does announce, so the negative below is a
      // negative and not a broken harness.
      resetAnnouncedEvents();
      await runSearchJob({
        type: "kb-keywords-extract",
        payload: { documentId: sandboxDocumentId, knowledgeBaseId: sandboxKbId },
      });
      expect(seen.filter((e) => e.documentId === sandboxDocumentId)).toHaveLength(1);

      // The same document, named under client B's KB: nothing is published.
      seen.length = 0;
      resetAnnouncedEvents();
      await runSearchJob({
        type: "kb-keywords-extract",
        payload: { documentId: sandboxDocumentId, knowledgeBaseId: clientBKbId },
      });
      expect(seen).toEqual([]);
    } finally {
      off();
      resetAnnouncedEvents();
      await inlineJobsSettled();
    }
  }, 120_000);

  it("refuses a body that does not match the contract, naming the field", async () => {
    await expect(
      client.request("POST", `/v1/kbs/${kbIds.hybrid}/query`, { json: { text: "" } }),
    ).rejects.toMatchObject({ status: 400, code: "validation-failed" });
  });

  // ── The contract additions Studio asked for (TASK-004b) ───────────────────
  //
  // Each one is a request Studio makes today and this wire could not express,
  // so each test is the request itself rather than a field's presence. They
  // run over the frozen corpus and the scratch KB, and none of them touches
  // the fifteen queries above.

  it("runs a tag-only v1 search, and embeds nothing at all to do it", async () => {
    /**
     * `handleTagOnlySearch` — the one v1 shape that ranks by nothing: it filters
     * by tag and answers with what survives. Studio's tag filters have always
     * called it and `text` used to be mandatory, so this whole class of query
     * stayed behind (TASK-009, contract change 1).
     *
     * **`usage.embed` at zero is the assertion**, not a detail: a route that
     * quietly embedded something — the tag values, the empty string — would
     * answer with a vector-ranked result set and a non-zero token count. The
     * distances are `0` for the same reason: there is no vector to be far from.
     */
    const tags = (v1Query.params as { structuredFilters: Array<Record<string, unknown>> })
      .structuredFilters;
    const result = (await client.kbs.query(kbIds[v1Query.knowledgeBase], {
      mode: "v1-tags",
      topK: 25,
      tags: tags as never,
    })) as V1TagQueryResponse;

    expect(result.mode).toBe("v1-tags");
    expect(result.usage?.embed).toEqual({ promptTokens: 0, totalTokens: 0 });
    expect(result.matches.length).toBeGreaterThan(0);
    for (const row of result.matches) {
      expect(row.tag1).toBe("handbook");
      expect(row.tag2).toBe("people");
      expect(row.distance).toBe(0);
    }

    /**
     * And `strategy` says so: **no `distanceThreshold`**, because nothing was
     * thresholded. Echoing the `1.0` `getQueryStrategy` computes — or a value
     * the caller stated — would report a threshold that never ran, on the one
     * path where no row was kept or dropped for its distance.
     */
    expect(result.strategy.distanceThreshold).toBeUndefined();
    expect(result.strategy).toEqual({
      useParallel: false,
      parallelLimit: 25 + 5,
      singleQueryOptimized: true,
    });
    // Stating one does not bring it back: there is still nothing to threshold.
    expect(
      (
        (await client.kbs.query(kbIds[v1Query.knowledgeBase], {
          mode: "v1-tags",
          topK: 25,
          tags: tags as never,
          distanceThreshold: 0.5,
        })) as V1TagQueryResponse
      ).strategy.distanceThreshold,
    ).toBeUndefined();

    // It is the same *set* the tag filter selects, so the tag+vector search
    // over the same filters can only be a subset of it — the vector step
    // narrows and orders, it never adds a row the filter excluded.
    const ranked = (await client.kbs.query(kbIds[v1Query.knowledgeBase], {
      mode: "v1-tags",
      text: v1Query.text,
      topK: 25,
      tags: tags as never,
    })) as V1TagQueryResponse;
    const tagOnlyIds = new Set(result.matches.map((m) => m.id));
    for (const row of ranked.matches) expect(tagOnlyIds.has(row.id)).toBe(true);
    expect(ranked.usage?.embed.totalTokens).toBeGreaterThan(0);
  }, 120_000);

  it("runs the vector-only v1 search, and gets the lifted function's own rows", async () => {
    /**
     * **`text` and no tags is Studio's ordinary wired v1 search.** Its own
     * `handleVectorOnlySearch` is what a query with no tag filters reaches, and
     * over the seam it sends `{ text, topK }` and nothing else — so this is the
     * v1 request a wired workspace makes most often.
     *
     * It used to be a `500`. The route sent every request that had `text` to
     * `handleTagAndVectorSearch`, with `structuredFilters: []`, and that
     * function's first line is a guard — "Tag filters are required for tag and
     * vector search" — a plain `Error`, so a `core-error` on the wire.
     *
     * The assertion is **row for row against the lifted function itself**,
     * called in process with the arguments the route hands it. The frozen
     * fixture corpus has no vector-only v1 query to compare against (q01–q15
     * are the two v2 engines and one tag+vector search), so the in-process call
     * *is* the oracle — which is the same kind of evidence the fixture is, one
     * step closer in.
     */
    const kbId = kbIds[v1Query.knowledgeBase];
    const topK = 10;
    const text = v1Query.text;

    const overRest = (await client.kbs.query(kbId, {
      mode: "v1-tags",
      text,
      topK,
    })) as V1TagQueryResponse;

    const endpoint = await resolveKbEmbeddingEndpoint(endpointIds.embedding);
    const embedded = await executeWorkspaceEmbedding({ endpoint, input: text });
    const inProcess = await handleVectorOnlySearch({
      knowledgeBaseIds: [kbId],
      topK,
      queryVector: `[${embedded.embeddings[0]!.join(",")}]`,
      distanceThreshold: getQueryStrategy(1, topK).distanceThreshold,
    });

    expect(overRest.mode).toBe("v1-tags");
    expect(overRest.matches.length).toBeGreaterThan(0);
    expect(overRest.matches.map((m) => m.id)).toEqual(inProcess.map((r) => r.id));
    expect(overRest.matches.map((m) => m.distance)).toEqual(
      inProcess.map((r) => Number(r.distance)),
    );
    // It embedded, unlike the tag-only path, and it thresholded — unlike it too.
    expect(overRest.usage?.embed.totalTokens).toBeGreaterThan(0);
    expect(overRest.strategy.distanceThreshold).toBe(1.0);
    for (let i = 1; i < overRest.matches.length; i++) {
      expect(overRest.matches[i - 1]!.distance).toBeLessThanOrEqual(
        overRest.matches[i]!.distance,
      );
    }

    // Not tag-filtered: it reaches rows the tag filter of the frozen v1 query
    // excludes, which is the difference between the two engines.
    const filtered = (await client.kbs.query(kbId, {
      mode: "v1-tags",
      text,
      topK,
      tags: (v1Query.params as { structuredFilters: Array<Record<string, unknown>> })
        .structuredFilters as never,
    })) as V1TagQueryResponse;
    const filteredIds = new Set(filtered.matches.map((m) => m.id));
    expect(overRest.matches.some((m) => !filteredIds.has(m.id))).toBe(true);

    // And a stated threshold still applies on this path.
    const tight = (await client.kbs.query(kbId, {
      mode: "v1-tags",
      text,
      topK,
      distanceThreshold: 0.000001,
    })) as V1TagQueryResponse;
    expect(tight.strategy.distanceThreshold).toBe(0.000001);
    expect(tight.matches).toEqual([]);
  }, 120_000);

  it("refuses a `distanceThreshold` of 0, which the frozen guard reads as absent", async () => {
    /**
     * `handleVectorOnlySearch` and `handleTagAndVectorSearch` both test their
     * threshold with `!distanceThreshold` — "was one given?" — so a stated `0`
     * is indistinguishable there from one left out and the guard throws, which
     * on this wire was a `500` on a request the contract had accepted. `.gt(0)`
     * is where that belongs: the engine is frozen (ADR 0005) and the honest
     * answer is a `400` on the field.
     */
    for (const body of [
      { mode: "v1-tags", text: "parental leave", topK: 5, distanceThreshold: 0 },
      {
        mode: "v1-tags",
        text: "parental leave",
        topK: 5,
        distanceThreshold: 0,
        tags: [{ tagSlot: "tag1", fieldType: "text", operator: "eq", value: "handbook" }],
      },
    ]) {
      await expect(
        client.request("POST", `/v1/kbs/${kbIds.hybrid}/query`, { json: body }),
      ).rejects.toMatchObject({ status: 400, code: "validation-failed" });
    }
    // The smallest thing above it is still accepted, so the bound moved rather
    // than the field going away.
    expect(
      (
        (await client.kbs.query(kbIds.hybrid, {
          mode: "v1-tags",
          text: "parental leave",
          topK: 5,
          distanceThreshold: 0.000001,
        })) as V1TagQueryResponse
      ).strategy.distanceThreshold,
    ).toBe(0.000001);
  }, 120_000);

  it("keeps `text` required everywhere a query still embeds", async () => {
    // Optional for the tag-only search and nowhere else: a hybrid query and a
    // tag-less v1 query both embed, and a request with nothing to embed and
    // nothing to filter by is not a search.
    for (const body of [
      { topK: 5 },
      { mode: "hybrid", tags: [{ tagSlot: "tag1", fieldType: "text", operator: "eq", value: "handbook" }] },
      { mode: "v1-tags" },
      { mode: "v1-tags", tags: [] },
      { mode: "v1-tags", tags: [{ tagSlot: "tag1", fieldType: "text", operator: "eq", value: "handbook" }], text: "" },
    ]) {
      await expect(
        client.request("POST", `/v1/kbs/${kbIds.hybrid}/query`, { json: body }),
      ).rejects.toMatchObject({ status: 400, code: "validation-failed" });
    }
  });

  it("applies the `distanceThreshold` the caller stated, and reports that one back", async () => {
    /**
     * Studio computes the threshold once for a whole multi-KB call — `0.8`
     * above three KBs — and then asks each KB separately, so an instance left
     * to infer it from the one KB in front of it always says `1.0` and the
     * multi-KB call could not be reproduced (TASK-009, contract change 2).
     *
     * Asserted by its effect rather than by the echo: an impossibly tight
     * threshold empties a result set that the default fills.
     */
    const tags = (v1Query.params as { structuredFilters: Array<Record<string, unknown>> })
      .structuredFilters;
    const ask = async (distanceThreshold?: number) =>
      (await client.kbs.query(kbIds[v1Query.knowledgeBase], {
        mode: "v1-tags",
        text: v1Query.text,
        topK: 10,
        tags: tags as never,
        ...(distanceThreshold === undefined ? {} : { distanceThreshold }),
      })) as V1TagQueryResponse;

    const inferred = await ask();
    expect(inferred.strategy.distanceThreshold).toBe(1.0);
    expect(inferred.matches.length).toBeGreaterThan(0);

    const tight = await ask(0.000001);
    expect(tight.strategy.distanceThreshold).toBe(0.000001);
    expect(tight.matches).toEqual([]);

    // Studio's own multi-KB value, which has to be *statable* whatever this
    // instance would have computed for one KB.
    const studios = await ask(0.8);
    expect(studios.strategy.distanceThreshold).toBe(0.8);
    for (const row of studios.matches) expect(row.distance).toBeLessThan(0.8);
    expect(studios.matches.length).toBeLessThanOrEqual(inferred.matches.length);
  }, 120_000);

  it("refuses a `distanceThreshold` on the hybrid path, which has no distance", async () => {
    // Refused rather than accepted and dropped: a threshold that was silently
    // ignored looks exactly like one that was applied.
    for (const body of [
      { text: "parental leave", distanceThreshold: 0.8 },
      { mode: "hybrid", text: "parental leave", distanceThreshold: 0.8 },
    ]) {
      await expect(
        client.request("POST", `/v1/kbs/${kbIds.hybrid}/query`, { json: body }),
      ).rejects.toMatchObject({ status: 400, code: "validation-failed" });
    }
  });

  it("accepts a `topK` of 100, which is what Studio's own routes accept", async () => {
    // Against a ceiling of 50 a `topK` in between came back short, and fanning
    // out at 50 per KB is a different result set for a single-KB search
    // (TASK-009, contract change 3).
    const result = (await client.kbs.query(kbIds.hybrid, {
      text: "parental leave",
      topK: 100,
      queryKeywords: [],
    })) as HybridQueryResponse;
    expect(result.mode).toBe("hybrid");
    expect(result.matches.length).toBeGreaterThan(5);
    expect(result.matches.length).toBeLessThanOrEqual(100);

    // 101 is still a 400, so the ceiling moved rather than went away.
    await expect(
      client.request("POST", `/v1/kbs/${kbIds.hybrid}/query`, {
        json: { text: "parental leave", topK: 101 },
      }),
    ).rejects.toMatchObject({ status: 400, code: "validation-failed" });
  }, 120_000);

  it("stages the tag parts of a multipart ingest, exactly as the JSON body's `tags` does", async () => {
    /**
     * The parts were reaching the row already; what the contract change buys is
     * that they are *declared*, validated and typed — the SDK's `tags` is the
     * form's tag parts by construction rather than by coincidence.
     *
     * So the assertion is the two encodings against each other: the same
     * seventeen values, once as a nested `tags` object and once as flat form
     * parts, have to land on the row identically — including `date1`, whose
     * exact instant is whatever the shared parser makes of `2026-09-15` and is
     * not this route's business to decide.
     */
    const tags = {
      tag1: "handbook",
      tag7: "people",
      number1: "42",
      date1: "2026-09-15",
      boolean1: "true",
    };
    const answer = await client.kbs.ingest(sandboxKbId, {
      filename: "tagged-multipart.md",
      mimeType: "text/markdown",
      file: Buffer.from("# Tagged\n\nUploaded with every kind of slot.\n", "utf8"),
      tags,
    });
    const doc = await waitForDocument(sandboxKbId, answer.documentId);
    expect(doc.processingStatus).toBe("completed");
    expect(doc).toMatchObject({
      tag1: "handbook",
      tag7: "people",
      number1: 42,
      boolean1: true,
    });
    expect(doc.date1).not.toBeNull();

    const viaJson = await client.kbs.ingest(sandboxKbId, {
      filename: "tagged-json.md",
      mimeType: "text/markdown",
      text: "# Tagged\n\nThe same slots, as a nested object.\n",
      tags,
    });
    const jsonDoc = await waitForDocument(sandboxKbId, viaJson.documentId);
    const slots = (d: typeof doc) => ({
      tag1: d.tag1,
      tag2: d.tag2,
      tag3: d.tag3,
      tag4: d.tag4,
      tag5: d.tag5,
      tag6: d.tag6,
      tag7: d.tag7,
      number1: d.number1,
      number2: d.number2,
      date1: d.date1,
      date2: d.date2,
      boolean1: d.boolean1,
      boolean2: d.boolean2,
    });
    expect(slots(doc)).toEqual(slots(jsonDoc));
    await inlineJobsSettled();

    // A tag part that is not a string cannot be sent by a form; a part that is
    // not a slot is dropped rather than staged.
    const stray = await client.request<{ documentId: string }>(
      "POST",
      `/v1/kbs/${sandboxKbId}/documents`,
      {
        multipart: multipartForm({
          file: Buffer.from("# Stray\n", "utf8"),
          filename: "stray-part.md",
          tag8: "nowhere",
        }),
      },
    );
    await waitForDocument(sandboxKbId, stray.documentId);
    await inlineJobsSettled();
    expect((await client.documents.get(sandboxKbId, stray.documentId)).tag1).toBeNull();
  }, 180_000);

  it("answers with `chunkCount` as soon as the row carries one, and never waits for it", async () => {
    /**
     * `ingestDocument` returns a chunk count and `kb_add_file` surfaces it as a
     * block output, so a wire with no field for it reports `0` — right for the
     * asynchronous path and wrong for the synchronous one (TASK-009, contract
     * change 5).
     *
     * **Absent on the first `202`, and that is the contract.** Ingest is
     * asynchronous — even the inline runner is a FIFO with a consumer, not a
     * function call — so at the moment this route answers there is no count to
     * report, and reporting `0` would be a claim about the document rather than
     * about what is known. The count is there the moment the row carries one,
     * which is what the idempotent re-ingest below reads back.
     */
    const answer = await client.kbs.ingest(sandboxKbId, {
      filename: "counted.md",
      mimeType: "text/markdown",
      text: "# Counted\n\nA document whose chunks are counted after the answer.\n",
    });
    expect(answer.chunkCount).toBeUndefined();
    const settled = await waitForDocument(sandboxKbId, answer.documentId);
    expect(settled.chunkCount).toBeGreaterThan(0);
    await inlineJobsSettled();

    // The idempotent re-ingest answers with the count the row now carries —
    // the one Studio's synchronous caller needs and used to have to guess at.
    const again = await client.kbs.ingest(sandboxKbId, {
      filename: "counted.md",
      mimeType: "text/markdown",
      text: "# Counted\n\nA document whose chunks are counted after the answer.\n",
      documentId: answer.documentId,
    });
    expect(again).toEqual({
      documentId: answer.documentId,
      processingStatus: "completed",
      chunkCount: settled.chunkCount,
    });

    // Absent rather than `0` for a document that has no chunks and never will:
    // "not known" and "no chunks" are different claims, and an upload the
    // caller excluded from the KB is the second one.
    const excluded = await client.kbs.ingest(sandboxKbId, {
      filename: "uncounted.md",
      mimeType: "text/markdown",
      file: Buffer.from("# Uncounted\n", "utf8"),
      includedInKb: false,
    });
    expect(excluded.chunkCount).toBeUndefined();
    await inlineJobsSettled();
  }, 180_000);

  it("filters a document listing by tag, with the operators the engine has", async () => {
    // A tag-filtered listing kept the Drizzle body on every workspace, because
    // the wire's tag filtering lived only on the query route (TASK-009,
    // contract change 6).
    const mine = await client.kbs.ingest(sandboxKbId, {
      filename: "tag-filtered.md",
      mimeType: "text/markdown",
      file: Buffer.from("# Filtered\n\nFound by its tags.\n", "utf8"),
      tags: { tag1: "runbook", tag2: "platform", number1: "7" },
    });
    await waitForDocument(sandboxKbId, mine.documentId);
    await inlineJobsSettled();

    const all = await client.documents.list(sandboxKbId, { limit: 200 });
    expect(all.documents.length).toBeGreaterThan(1);

    const byTag = await client.documents.list(sandboxKbId, {
      limit: 200,
      tagFilters: [{ tagSlot: "tag1", fieldType: "text", operator: "eq", value: "runbook" }],
    });
    expect(byTag.documents.map((d) => d.id)).toEqual([mine.documentId]);
    /**
     * `total` is a **number**, with no `Number(…)` around it. The lifted
     * `getDocuments` hands `COUNT(*)` back as the string Postgres sent, on
     * every listing filtered or not, and the route now casts it — so the
     * answer satisfies the `ListDocumentsResponseSchema` it is defined by,
     * which is the assertion below and which it did not use to.
     */
    expect(byTag.pagination.total).toBe(1);
    const raw = await client.request("GET", `/v1/kbs/${sandboxKbId}/documents`, {
      query: { limit: "200" },
    });
    const parsed = ListDocumentsResponseSchema.parse(raw);
    expect(parsed.pagination.total).toBe(parsed.pagination.total | 0);
    expect(parsed.documents.length).toBe(parsed.documents.length | 0);

    // Two slots are ANDed, `between` reads `valueTo`, and a filter that matches
    // nothing answers with nothing rather than with everything — which is what
    // a dropped condition would have done.
    expect(
      (
        await client.documents.list(sandboxKbId, {
          limit: 200,
          tagFilters: [
            { tagSlot: "tag1", fieldType: "text", operator: "starts_with", value: "run" },
            { tagSlot: "number1", fieldType: "number", operator: "between", value: "1", valueTo: "9" },
          ],
        })
      ).documents.map((d) => d.id),
    ).toEqual([mine.documentId]);
    expect(
      (
        await client.documents.list(sandboxKbId, {
          limit: 200,
          tagFilters: [{ tagSlot: "tag1", fieldType: "text", operator: "eq", value: "nothing" }],
        })
      ).documents,
    ).toEqual([]);

    // A slot the engine would drop, and a parameter that is not JSON, are both
    // refused rather than answered with the unfiltered list.
    for (const bad of ["not json at all", JSON.stringify([{ tagSlot: "tag8", fieldType: "text", operator: "eq", value: "x" }])]) {
      await expect(
        client.request("GET", `/v1/kbs/${sandboxKbId}/documents`, { query: { tagFilters: bad } }),
      ).rejects.toMatchObject({ status: 400, code: "validation-failed" });
    }

    /**
     * **And so is every other field of a condition**, for the same reason the
     * slot is: `buildTagFilterCondition` answers a condition it cannot build
     * with `undefined`, an undefined condition is dropped, and a dropped
     * condition answers a *filtered* listing with the *unfiltered* one — which
     * a caller cannot tell from the rows. The slot/`fieldType` mismatch is
     * worse still: `number1` read as text reaches Postgres as a text
     * comparison against an integer column, which is a type error and a `500`.
     *
     * Each of these used to be answered with every document in the KB (or, for
     * the third, with a `500`); each is a `400` naming the field now.
     */
    for (const condition of [
      // No such operator anywhere in the engine.
      { tagSlot: "tag1", fieldType: "text", operator: "regex", value: "run" },
      { tagSlot: "tag1", fieldType: "text", operator: "in", value: "run" },
      // A real operator, on a type whose branch does not implement it.
      { tagSlot: "tag1", fieldType: "text", operator: "gt", value: "run" },
      { tagSlot: "boolean1", fieldType: "boolean", operator: "contains", value: "true" },
      { tagSlot: "number1", fieldType: "number", operator: "starts_with", value: "7" },
      // The slot's prefix is its type, and this one disagrees with it.
      { tagSlot: "number1", fieldType: "text", operator: "eq", value: "7" },
      { tagSlot: "tag1", fieldType: "number", operator: "eq", value: "7" },
      { tagSlot: "date1", fieldType: "text", operator: "eq", value: "2026-09-15" },
      // `between` is a range and the engine drops one with no upper bound.
      { tagSlot: "number1", fieldType: "number", operator: "between", value: "1" },
      { tagSlot: "date1", fieldType: "date", operator: "between", value: "2026-01-01" },
    ]) {
      await expect(
        client.request("GET", `/v1/kbs/${sandboxKbId}/documents`, {
          query: { tagFilters: JSON.stringify([condition]) },
        }),
      ).rejects.toMatchObject({ status: 400, code: "validation-failed" });
    }

    // The matching combinations still work, on every column type the KB has.
    expect(
      (
        await client.documents.list(sandboxKbId, {
          limit: 200,
          tagFilters: [
            { tagSlot: "tag2", fieldType: "text", operator: "ends_with", value: "form" },
            { tagSlot: "number1", fieldType: "number", operator: "gte", value: "7" },
          ],
        })
      ).documents.map((d) => d.id),
    ).toEqual([mine.documentId]);
  }, 180_000);

  it("restores an archived knowledge base, under a free name", async () => {
    /**
     * The other half of the soft delete. On a wired workspace a restore brought
     * back everything Studio owns and left the Search-side KB archived, because
     * there was no route (TASK-009, contract change 7).
     *
     * The rename is the reason the route answers with the record: the lifted
     * `restoreKnowledgeBase` un-archives under `generateRestoreName`, so a KB
     * whose name was taken while it was archived comes back as `…_restored`.
     */
    const name = `zz-restore-${RUN}`;
    const original = await client.kbs.create({
      name,
      ownerId: ids.owner,
      embeddingModel: "hash-ngram-256",
      embeddingEndpointId: endpointIds.embedding,
      clusterCount: 8,
    });
    extraKbIds.push(original.id);
    const seeded = await client.kbs.ingest(original.id, {
      filename: "restore-me.md",
      mimeType: "text/markdown",
      text: "# Restore me\n\nArchived and brought back.\n",
    });
    await waitForDocument(original.id, seeded.documentId);
    await inlineJobsSettled();

    await client.kbs.delete(original.id);
    // Archived is gone as far as every other route is concerned.
    await expect(client.kbs.get(original.id)).rejects.toMatchObject({ status: 404 });
    expect((await client.kbs.list()).map((kb) => kb.id)).not.toContain(original.id);
    expect((await client.kbs.list({ scope: "archived" })).map((kb) => kb.id)).toContain(
      original.id,
    );

    const restored = await client.kbs.restore(original.id);
    expect(restored).toMatchObject({ id: original.id, name, deletedAt: null });
    // And it is readable again, documents and all: the restore un-archived the
    // rows the delete archived.
    expect((await client.kbs.get(original.id)).docCount).toBe(1);
    expect((await client.documents.list(original.id)).documents.map((d) => d.id)).toEqual([
      seeded.documentId,
    ]);

    // Archive it again and take its name, so the restore has to find a free one.
    await client.kbs.delete(original.id);
    const squatter = await client.kbs.create({
      name,
      ownerId: ids.owner,
      embeddingModel: "hash-ngram-256",
      embeddingEndpointId: endpointIds.embedding,
      clusterCount: 8,
    });
    extraKbIds.push(squatter.id);
    const renamed = await client.kbs.restore(original.id);
    expect(renamed).toMatchObject({ id: original.id, name: `${name}_restored`, deletedAt: null });
    expect((await client.kbs.get(squatter.id)).name).toBe(name);
  }, 180_000);

  it("refuses a restore of a foreign KB, an unknown one, and one that is not archived", async () => {
    // Ownership first, and the refusal is the same `404` as every other KB
    // route: somebody else's KB and a KB that never existed are one answer
    // (ADR 0009 D5). `requireKbIncludingArchived` is the only reader of an
    // archived row, and it checks `paired_client_id` exactly as `requireKb`
    // does.
    await expect(clientB.kbs.restore(kbIds.hybrid)).rejects.toMatchObject({
      status: 404,
      code: "not-found",
    });
    await expect(client.kbs.restore(`${PREFIX}-no-such-kb`)).rejects.toMatchObject({
      status: 404,
      code: "not-found",
    });
    // Live, so there is nothing to un-archive.
    await expect(client.kbs.restore(sandboxKbId)).rejects.toMatchObject({
      status: 409,
      code: "conflict",
    });

    // And a foreign restore wrote nothing: the KB it named is untouched.
    expect((await client.kbs.get(kbIds.hybrid)).deletedAt).toBeNull();
  });

  it("writes a chunk by hand: embedded, appended, and inheriting its document's tags", async () => {
    /**
     * Studio's chunk editor adds one (`POST /api/knowledge/[id]/documents/
     * [documentId]/chunks`) and there was nothing on the wire for it, so the
     * action refused on a wired workspace (TASK-009's second round, change 9).
     *
     * Four things are the lifted `createChunk`'s and all four are asserted:
     * the content is **embedded** (so the chunk is findable by a query for a
     * phrase only it contains), it lands at the next `chunkIndex`, it inherits
     * the document's tag values, and the document's three counters go up by
     * what it added.
     *
     * **A file ingest, and that matters.** `createChunk` writes the shared
     * `embedding` table — it is v1 code (ADR 0005) — and the text path
     * (`ingestDocument`) writes only the KB's partition, so a text-ingested
     * document has no rows there to append after and no rows there to be found
     * beside. The file pipeline writes both, which is why the chunk editor's
     * documents are file-ingested ones and why the query below is the v1 path.
     */
    const doc = await client.kbs.ingest(sandboxKbId, {
      filename: "hand-written.md",
      mimeType: "text/markdown",
      file: Buffer.from(
        "# Hand written\n\nThe document a chunk is added to by hand.\n",
        "utf8",
      ),
      tags: { tag1: "runbook", tag3: "manual", number2: "3" },
    });
    const before = await waitForDocument(sandboxKbId, doc.documentId);
    expect(before.processingStatus).toBe("completed");
    await inlineJobsSettled();

    const content =
      "Quetzal provisioning is reviewed every Thursday by the platform duty officer.";
    const chunk = await client.chunks.create(sandboxKbId, doc.documentId, { content });
    expect(chunk).toMatchObject({
      // The document the route was addressed at, off the chunk rather than
      // assumed by the caller.
      documentId: doc.documentId,
      chunkIndex: before.chunkCount,
      content,
      contentLength: content.length,
      enabled: true,
      startOffset: 0,
      endOffset: content.length,
      // Inherited from the document, which is why the route reads the row.
      tag1: "runbook",
      tag3: "manual",
    });
    expect(chunk.tokenCount).toBeGreaterThan(0);

    const after = await client.documents.get(sandboxKbId, doc.documentId);
    expect(after.chunkCount).toBe(before.chunkCount + 1);
    expect(after.tokenCount).toBe(before.tokenCount + chunk.tokenCount);
    expect(after.characterCount).toBe(before.characterCount + content.length);

    // It was embedded, not merely stored: the v1 path ranks the shared table by
    // cosine distance, and a row with no vector cannot come back from it.
    const found = (await client.kbs.query(sandboxKbId, {
      mode: "v1-tags",
      text: "quetzal provisioning review",
      topK: 20,
      tags: [{ tagSlot: "tag1", fieldType: "text", operator: "eq", value: "runbook" }] as never,
    })) as V1TagQueryResponse;
    expect(found.matches.map((m) => m.id)).toContain(chunk.id);

    // The next one lands after it, and `enabled: false` is honoured.
    const second = await client.chunks.create(sandboxKbId, doc.documentId, {
      content: "A second hand-written chunk.",
      enabled: false,
    });
    expect(second.chunkIndex).toBe(chunk.chunkIndex + 1);
    expect(second.enabled).toBe(false);

    // Every route that answers with a chunk carries `documentId`, and the
    // response satisfies its own schema with the field required.
    const page = await client.documents.chunks(sandboxKbId, doc.documentId, { limit: 500 });
    expect(page.chunks.map((c) => c.documentId)).toEqual(page.chunks.map(() => doc.documentId));
    for (const row of page.chunks) expect(ChunkSchema.parse(row)).toEqual(row);
    const patched = await client.documents.updateChunk(
      sandboxKbId,
      doc.documentId,
      second.id,
      { enabled: true },
    );
    expect(patched.documentId).toBe(doc.documentId);

    // Somebody else's KB, and a document that is not in this one: 404 either
    // way, and the refusal is the KB's rather than the chunk writer's.
    await expect(
      clientB.chunks.create(sandboxKbId, doc.documentId, { content: "not mine" }),
    ).rejects.toMatchObject({ status: 404, code: "not-found" });
    await expect(
      client.chunks.create(kbIds.sdk, doc.documentId, { content: "wrong kb" }),
    ).rejects.toMatchObject({ status: 404, code: "not-found" });
    await expect(
      client.request("POST", `/v1/kbs/${sandboxKbId}/documents/${doc.documentId}/chunks`, {
        json: { content: "" },
      }),
    ).rejects.toMatchObject({ status: 400, code: "validation-failed" });
    await inlineJobsSettled();
  }, 180_000);

  it("reads a chunk by its own id, and hangs a keyword off it the same way", async () => {
    /**
     * A chunk id is unique across the instance and Studio's chunk surfaces hold
     * `{ knowledgeBaseId, chunkId }` and nothing else, so on the
     * document-addressed routes alone the manual keyword overlay had no
     * document id to send and refused (TASK-009's second round, change 10).
     *
     * File-ingested for the same reason as the chunk writer above: the chunk
     * routes read the shared `embedding` table, which the text path does not
     * write.
     */
    const doc = await client.kbs.ingest(sandboxKbId, {
      filename: "chunk-by-id.md",
      mimeType: "text/markdown",
      file: Buffer.from("# Chunk by id\n\nAddressed without its document.\n", "utf8"),
    });
    expect((await waitForDocument(sandboxKbId, doc.documentId)).processingStatus).toBe("completed");
    await inlineJobsSettled();
    const listed = await client.documents.chunks(sandboxKbId, doc.documentId, { limit: 1 });
    const chunkId = listed.chunks[0]!.id;

    const byId = await client.chunks.get(sandboxKbId, chunkId);
    expect(byId).toEqual(listed.chunks[0]);
    // The one route with no document in its path still says which document the
    // chunk is in — read off the `embedding` row, not stamped on by the caller
    // (TASK-009c, contract request 12).
    expect(byId.documentId).toBe(doc.documentId);

    // Somebody else's KB, and a chunk that is in a different KB of this
    // client's: 404 both times, and it says nothing about whose chunk it is.
    await expect(clientB.chunks.get(sandboxKbId, chunkId)).rejects.toMatchObject({
      status: 404,
      code: "not-found",
    });
    await expect(client.chunks.get(kbIds.sdk, chunkId)).rejects.toMatchObject({
      status: 404,
      code: "not-found",
    });

    // Attach by chunk id, then read the keyword back off the chunk's KB.
    const attached = await client.chunks.attachKeyword(sandboxKbId, chunkId, {
      displayLabel: "Provisioning",
    });
    expect(attached).toMatchObject({ chunkId, attached: true });
    expect(attached.keyword.keyword).toBe("provisioning");
    expect((await client.keywords.list(sandboxKbId)).map((k) => k.id)).toContain(
      attached.keyword.id,
    );

    // `POST` is the same handler as `PUT` — Studio's own route is a POST — and
    // the attach is create-or-return, so the second one reports `attached:
    // false` rather than failing.
    const again = await client.request<{ chunkId: string; attached: boolean }>(
      "POST",
      `/v1/kbs/${sandboxKbId}/chunks/${chunkId}/keywords`,
      { json: { kbKeywordId: attached.keyword.id } },
    );
    expect(again).toMatchObject({ chunkId, attached: false });

    // And the detach, by chunk id.
    expect(await client.chunks.detachKeyword(sandboxKbId, chunkId, attached.keyword.id)).toEqual({
      id: attached.keyword.id,
      deleted: true,
    });
    await expect(
      clientB.chunks.detachKeyword(sandboxKbId, chunkId, attached.keyword.id),
    ).rejects.toMatchObject({ status: 404, code: "not-found" });

    // The body's rule is the contract's, on this addressing too.
    await expect(
      client.request("PUT", `/v1/kbs/${sandboxKbId}/chunks/${chunkId}/keywords`, {
        json: { kbKeywordId: attached.keyword.id, displayLabel: "Both" },
      }),
    ).rejects.toMatchObject({ status: 400, code: "validation-failed" });
  }, 180_000);

  it("lists one chunk's keyword links, and says which of them a person made", async () => {
    /**
     * The last surface that refused on a wired workspace (TASK-009c, contract
     * request 10's read half). `keywords.list` answers the KB's *vocabulary*
     * with a usage count across the whole KB; this answers which of those rows
     * carry **this chunk**, and with each one the `source` and `attachedAt` off
     * the join — so a listing that were `keywords.list` filtered could not tell
     * a link the extractor made from one a person made.
     *
     * A file ingest again: the chunk routes read the shared `embedding` table
     * and the text path does not write it. The ingest also enqueues
     * `kb-keywords-extract`, so once the inline jobs settle this document's
     * chunks carry the extractor's `llm` links — which is what makes the
     * `manual` attach below distinguishable rather than merely present.
     */
    const doc = await client.kbs.ingest(sandboxKbId, {
      filename: "chunk-keyword-links.md",
      mimeType: "text/markdown",
      file: Buffer.from(
        "# Parental leave\n\nParental leave is six weeks at full pay, and the " +
          "security review of every expense runbook is quarterly.\n",
        "utf8",
      ),
    });
    expect((await waitForDocument(sandboxKbId, doc.documentId)).processingStatus).toBe("completed");
    await inlineJobsSettled();

    const page = await client.documents.chunks(sandboxKbId, doc.documentId, { limit: 500 });
    expect(page.chunks.length).toBeGreaterThan(0);

    // Whichever chunk the extractor reached — the deterministic extractor picks
    // from `TOPIC_VOCABULARY`, and which chunk carries which topic is the
    // engine's business, so the test finds one rather than naming one.
    let chunkId = "";
    let links: Awaited<ReturnType<typeof client.chunks.keywords>> = [];
    for (const chunk of page.chunks) {
      const answer = await client.chunks.keywords(sandboxKbId, chunk.id);
      if (answer.length > 0) {
        chunkId = chunk.id;
        links = answer;
        break;
      }
    }
    expect(chunkId).not.toBe("");

    // The response is its own contract's, and every link is the extractor's.
    expect(ListChunkKeywordsResponseSchema.parse({ keywords: links }).keywords).toEqual(links);
    expect(links.map((l) => l.source)).toEqual(links.map(() => "llm"));

    // The keyword half is the vocabulary's own row, field for field — this is
    // the KB's keyword *plus* the join, not a second shape for the same thing.
    const vocabulary = new Map(
      (await client.keywords.list(sandboxKbId, { limit: 500 })).map((k) => [k.id, k]),
    );
    for (const link of links) {
      expect(link.knowledgeBaseId).toBe(sandboxKbId);
      const { source: _source, attachedAt, ...keyword } = link;
      expect(keyword).toEqual(vocabulary.get(link.id));
      // The link's own timestamp is a real one, and it is read from the join
      // row rather than from the keyword.
      expect(Number.isNaN(Date.parse(attachedAt))).toBe(false);
      expect(link.usageCount).toBeGreaterThan(0);
    }
    // Ordered by the canonical form, which is what the route promises.
    expect(links.map((l) => l.keyword)).toEqual([...links.map((l) => l.keyword)].sort());

    // A keyword attached by hand joins the same listing, reporting `manual` —
    // the one thing the vocabulary listing cannot say about a chunk.
    const attached = await client.chunks.attachKeyword(sandboxKbId, chunkId, {
      // One token: `normalizeKeyword` takes a word or a hyphenated pair, and
      // refuses anything else with a `400` — which the attach test next door
      // asserts and this one is not re-asserting.
      displayLabel: "Quetzal",
    });
    expect(attached.attached).toBe(true);
    const withManual = await client.chunks.keywords(sandboxKbId, chunkId);
    expect(withManual).toHaveLength(links.length + 1);
    const manual = withManual.find((l) => l.id === attached.keyword.id);
    expect(manual).toMatchObject({
      keyword: "quetzal",
      displayLabel: "Quetzal",
      source: "manual",
      knowledgeBaseId: sandboxKbId,
    });
    // The extractor's links are untouched by the attach: `source` is per link.
    expect(withManual.filter((l) => l.source === "llm").map((l) => l.id).sort()).toEqual(
      links.map((l) => l.id).sort(),
    );

    // And the detach takes it out of the listing, which is how a caller sees
    // that this read and those two writes are about the same rows.
    await client.chunks.detachKeyword(sandboxKbId, chunkId, attached.keyword.id);
    expect((await client.chunks.keywords(sandboxKbId, chunkId)).map((l) => l.id)).not.toContain(
      attached.keyword.id,
    );

    // A chunk with no links at all is an empty listing, not a 404: a
    // hand-written chunk is one no extraction has seen.
    const fresh = await client.chunks.create(sandboxKbId, doc.documentId, {
      content: "A chunk written by hand, which no extractor has read.",
    });
    expect(await client.chunks.keywords(sandboxKbId, fresh.id)).toEqual([]);

    // Scoped exactly as `chunks.get` is. Another client's read of this chunk,
    // and this client's read of it under the wrong KB, are both 404 — and
    // neither answer says whose chunk it is (ADR 0009 D5).
    await expect(clientB.chunks.keywords(sandboxKbId, chunkId)).rejects.toMatchObject({
      status: 404,
      code: "not-found",
    });
    await expect(client.chunks.keywords(kbIds.sdk, chunkId)).rejects.toMatchObject({
      status: 404,
      code: "not-found",
    });
    await expect(
      client.chunks.keywords(sandboxKbId, "c_does_not_exist"),
    ).rejects.toMatchObject({ status: 404, code: "not-found" });
    await inlineJobsSettled();
  }, 180_000);

  it("refuses a chunk edit a KB has nothing to re-embed with, as the create does", async () => {
    /**
     * **Editing a chunk's `content` re-embeds it** — that is the lifted
     * behaviour and it is not a flag — so a KB with no embedding endpoint has
     * nothing to do the edit with. `POST …/chunks` already said so as a `400`;
     * the `PATCH` did not map the same engine error at all and answered `500`,
     * so the same condition had two answers on two routes that embed and the
     * one a caller could fix itself was the one that looked like our fault.
     *
     * The sentence is the **wire's** own. The engine's ends "Set one in the KB
     * settings.", which is Studio's UI telling a person where to click; there
     * is no settings page on this surface, so a paired client is told the two
     * calls that fix it instead.
     */
    const kb = await client.kbs.create({
      name: `zz-noembed-${RUN}`,
      ownerId: ids.owner,
      embeddingModel: "hash-ngram-256",
      embeddingEndpointId: endpointIds.embedding,
      clusterCount: 8,
    });
    extraKbIds.push(kb.id);
    // A file ingest: the chunk routes are v1 code over the shared `embedding`
    // table, which the file pipeline writes and the `text` path does not.
    const doc = await client.kbs.ingest(kb.id, {
      filename: "unembeddable.md",
      mimeType: "text/markdown",
      file: Buffer.from("# Unembeddable\n\nA chunk to try to edit.\n", "utf8"),
    });
    await waitForDocument(kb.id, doc.documentId);
    await inlineJobsSettled();
    const listed = await client.documents.chunks(kb.id, doc.documentId);
    const chunkId = listed.chunks[0]!.id;

    // Now take the endpoint away. No wire route unbinds one — a KB keeps the
    // endpoint it was created with — so this is the column, directly.
    await db
      .update(knowledgeBase)
      .set({ embeddingEndpointId: null })
      .where(eq(knowledgeBase.id, kb.id));

    // Thunks, not promises: two rejections made up front and handled one at a
    // time is an unhandled rejection for as long as the first `await` takes.
    for (const attempt of [
      () =>
        client.request(
          "PATCH",
          `/v1/kbs/${kb.id}/documents/${doc.documentId}/chunks/${chunkId}`,
          { json: { content: "Edited, and so in need of a new vector." } },
        ),
      () =>
        client.request("POST", `/v1/kbs/${kb.id}/documents/${doc.documentId}/chunks`, {
          json: { content: "Written by hand, and so in need of a vector." },
        }),
    ]) {
      const refused = attempt();
      await expect(refused).rejects.toMatchObject({ status: 400, code: "bad-request" });
      await expect(refused).rejects.toSatisfy(
        (err: { message: string }) =>
          err.message.includes("PUT /v1/endpoints") && !err.message.includes("KB settings"),
      );
    }

    // Give it back, so the KB tears down the way every other one does.
    await db
      .update(knowledgeBase)
      .set({ embeddingEndpointId: endpointIds.embedding })
      .where(eq(knowledgeBase.id, kb.id));
    await inlineJobsSettled();
  }, 180_000);

  it("enables, disables and deletes documents in bulk — by id, and by filter", async () => {
    /**
     * Studio's two bulk paths were N requests for N documents on a wired
     * workspace, and the by-filter one was additionally capped by the listing's
     * `limit` of 500 (TASK-009's second round, change 11).
     *
     * In a KB of its own, because `enabled` is what the query path reads and a
     * bulk disable over the frozen corpus would change what every other test
     * sees.
     */
    const kb = await client.kbs.create({
      name: `zz-bulk-${RUN}`,
      ownerId: ids.owner,
      embeddingModel: "hash-ngram-256",
      embeddingEndpointId: endpointIds.embedding,
      clusterCount: 8,
    });
    extraKbIds.push(kb.id);
    const documentIds: string[] = [];
    for (const n of [1, 2, 3]) {
      const answer = await client.kbs.ingest(kb.id, {
        filename: `bulk-${n}.md`,
        mimeType: "text/markdown",
        text: `# Bulk ${n}\n\nOne of three documents a bulk call acts on.\n`,
      });
      await waitForDocument(kb.id, answer.documentId);
      documentIds.push(answer.documentId);
    }
    await inlineJobsSettled();
    const idsOf = async (enabledFilter: "all" | "enabled" | "disabled") =>
      (await client.documents.list(kb.id, { limit: 200, enabledFilter })).documents
        .map((d) => d.id)
        .sort();

    // By id.
    expect(
      await client.documents.bulk(kb.id, {
        operation: "disable",
        documentIds: documentIds.slice(0, 2),
      }),
    ).toEqual({ affected: 2 });
    expect(await idsOf("disabled")).toEqual(documentIds.slice(0, 2).sort());
    expect(await idsOf("enabled")).toEqual([documentIds[2]]);

    // By filter: everything, whatever each document's current state is.
    expect(
      await client.documents.bulk(kb.id, { operation: "enable", enabledFilter: "all" }),
    ).toEqual({ affected: 3 });
    expect(await idsOf("enabled")).toEqual([...documentIds].sort());

    // One id that is not in this KB refuses the whole call and writes nothing —
    // and the message names none of the ids (ADR 0009 D5).
    const foreign = client.documents.bulk(kb.id, {
      operation: "delete",
      documentIds: [documentIds[0]!, sandboxDocumentId],
    });
    await expect(foreign).rejects.toMatchObject({ status: 404, code: "not-found" });
    await expect(foreign).rejects.toSatisfy(
      (err: { message: string }) => !err.message.includes(sandboxDocumentId),
    );
    expect(await idsOf("all")).toEqual([...documentIds].sort());

    // Delete, which is the soft delete the single-document route performs.
    expect(
      await client.documents.bulk(kb.id, { operation: "delete", documentIds: [documentIds[0]!] }),
    ).toEqual({ affected: 1 });
    expect(await idsOf("all")).toEqual([...documentIds].slice(1).sort());
    await expect(client.documents.get(kb.id, documentIds[0]!)).rejects.toMatchObject({
      status: 404,
    });

    /**
     * **The pre-check's predicate is the engine's.** `bulkDocumentOperation`
     * selects and updates under `userExcluded = false AND archived_at IS NULL
     * AND deleted_at IS NULL`, and it acts on the rows it finds and only *logs*
     * the rest. Checking `deleted_at` alone let an id through that the engine
     * would then skip, and the route answered `200` with an `affected` short of
     * what was asked for — or, for the last id in a call, a `500` out of the
     * engine's "No valid documents found to update". Either way silently, which
     * is the whole thing this check exists to prevent.
     *
     * Neither column is reachable from the wire (an archive is a KB-level
     * delete, and `userExcluded` is the connector soft-delete Studio kept), so
     * this is the row put into the state the engine will skip, directly.
     */
    const survivor = documentIds[1]!;
    for (const state of [{ archivedAt: new Date() }, { userExcluded: true }]) {
      await db.update(document).set(state).where(eq(document.id, survivor));
      await expect(
        client.documents.bulk(kb.id, { operation: "disable", documentIds: [survivor] }),
      ).rejects.toMatchObject({ status: 404, code: "not-found" });
      await db
        .update(document)
        .set({ archivedAt: null, userExcluded: false })
        .where(eq(document.id, survivor));
    }
    // And with the row back, the very same call goes through.
    expect(
      await client.documents.bulk(kb.id, { operation: "disable", documentIds: [survivor] }),
    ).toEqual({ affected: 1 });
    expect(
      await client.documents.bulk(kb.id, { operation: "enable", documentIds: [survivor] }),
    ).toEqual({ affected: 1 });

    // The contract's own refusals, over the wire.
    for (const json of [
      { operation: "delete" },
      { operation: "delete", documentIds: [documentIds[1]], enabledFilter: "all" },
      { operation: "delete", documentIds: [] },
      { operation: "archive", documentIds: [documentIds[1]] },
      { operation: "delete", documentIds: Array.from({ length: 501 }, (_, i) => `d_${i}`) },
    ]) {
      await expect(
        client.request("POST", `/v1/kbs/${kb.id}/documents/bulk`, { json }),
      ).rejects.toMatchObject({ status: 400, code: "validation-failed" });
    }

    // Somebody else's KB is a 404 before the body is even read.
    await expect(
      clientB.documents.bulk(kb.id, { operation: "delete", enabledFilter: "all" }),
    ).rejects.toMatchObject({ status: 404, code: "not-found" });
    expect(await idsOf("all")).toHaveLength(2);
    await inlineJobsSettled();
  }, 300_000);
  it("says who the caller is, on `whoami`, without being told", async () => {
    /**
     * The call Studio's data migration needs: `capabilities()` is about the
     * instance and has no client id in it, and the sealed registration blob has
     * none either, so before this route a migration had to be handed
     * `--paired-client-id` by an operator (its own `PAIRED_CLIENT_ID_GAP`).
     */
    const me = await client.whoami();
    expect(me.clientId).toBe(ids.pairedClient);
    expect(me.label).toBe(`${PREFIX} client`);
    expect(me.schemaVersion).toBe((await client.capabilities()).schemaVersion);
    expect(Date.parse(me.createdAt)).not.toBeNaN();

    // `admin` implies `write` implies `read`, expanded rather than left for the
    // caller to work out — this pairing was seeded `admin`.
    expect(me.scopes).toEqual(["read", "write", "admin"]);

    // No certificate on this connection: the insecure mode reads a header, so
    // there is no serial to report and the field is absent rather than faked
    // from the row. (`pairing.e2e.test.ts` asserts the mTLS half.)
    expect(me.serialNumber).toBeUndefined();

    // The id is the caller's own, and the second client gets its own answer
    // from the same route: this is identity, not a constant.
    expect((await clientB.whoami()).clientId).toBe(ids.pairedClientB);

    // The whole body, against the contract it is defined by.
    expect(
      WhoamiSchema.safeParse(await client.request("GET", "/v1/whoami")).success,
    ).toBe(true);
  });

  it("attaches new bytes to a document without re-ingesting it", async () => {
    /**
     * `PUT …/documents/:docId/blob`, and what it must **not** do is the point:
     * the migration moves `search.document` rows by SQL with the chunk ids and
     * embeddings they already had, and the bytes those rows name are in
     * Studio's bucket. A re-ingest would rewrite every one of those ids, so
     * this route repoints the row and runs nothing.
     */
    const original = Buffer.from(
      "# Parental leave\n\nSix weeks at full pay, from day one.\n",
      "utf8",
    );
    const doc = await client.kbs.ingest(sandboxKbId, {
      filename: "attach-me.md",
      mimeType: "text/markdown",
      file: original,
      tags: { tag1: "handbook" },
    });
    const settled = await waitForDocument(sandboxKbId, doc.documentId);
    expect(settled.processingStatus).toBe("completed");
    await inlineJobsSettled();

    const before = await client.documents.get(sandboxKbId, doc.documentId);
    const chunksBefore = await client.documents.chunks(sandboxKbId, doc.documentId, { limit: 500 });
    expect(chunksBefore.chunks.length).toBeGreaterThan(0);

    // ── The attach ────────────────────────────────────────────────────────
    const replacement = Buffer.from(
      "# Parental leave\n\nThe very same policy, as a different object.\n",
      "utf8",
    );
    const attached = await client.documents.attachBlob(sandboxKbId, doc.documentId, {
      file: replacement,
      filename: "attach-me.md",
      mimeType: "text/markdown",
    });
    expect(DocumentSchema.safeParse(attached).success).toBe(true);

    // Three columns move, and they are the three that describe the object.
    expect(attached.fileUrl).not.toBe(before.fileUrl);
    expect(isInternalFileUrl(attached.fileUrl)).toBe(true);
    expect(attached.fileSize).toBe(replacement.length);
    expect(attached.mimeType).toBe("text/markdown");
    // The ingest key scheme, so a migrated object needs no rename.
    const { key } = parseInternalFileUrl(attached.fileUrl);
    expect(key).toMatch(/^kb\/\d+-[a-z0-9]+-attach-me\.md$/);
    // And the bytes in the bucket are the ones that were sent.
    expect((await downloadFile({ key })).equals(replacement)).toBe(true);

    // Nothing the pipeline owns moved: no chunker ran, no vector was rewritten.
    expect(attached).toMatchObject({
      processingStatus: before.processingStatus,
      chunkCount: before.chunkCount,
      processedChunks: before.processedChunks,
      tokenCount: before.tokenCount,
      characterCount: before.characterCount,
      keywordStatus: before.keywordStatus,
      uploadedAt: before.uploadedAt,
      processingCompletedAt: before.processingCompletedAt,
      // The row's name is the document's, not the object's: a rename is PATCH.
      filename: before.filename,
      tag1: "handbook",
    });
    const chunksAfter = await client.documents.chunks(sandboxKbId, doc.documentId, { limit: 500 });
    expect(chunksAfter.chunks.map((c) => c.id)).toEqual(chunksBefore.chunks.map((c) => c.id));
    expect(chunksAfter.chunks.map((c) => c.content)).toEqual(
      chunksBefore.chunks.map((c) => c.content),
    );
    // No work was enqueued, so there is nothing for the queue to have settled.
    expect(inlineJobFailures()).toEqual([]);

    // ── Idempotent in the row, not in the bucket ──────────────────────────
    const again = await client.documents.attachBlob(sandboxKbId, doc.documentId, {
      file: replacement,
      filename: "attach-me.md",
      mimeType: "text/markdown",
    });
    // Same bytes twice is fine, which is what a retried stream needs: the row
    // ends in the same state, and only the object's key is new.
    expect({ ...again, fileUrl: "" }).toEqual({ ...attached, fileUrl: "" });
    expect(again.fileUrl).not.toBe(attached.fileUrl);
    // The superseded object is left in place — a job may still hold its URL.
    expect((await downloadFile({ key })).equals(replacement)).toBe(true);

    // ── 409 while a run is reading the current bytes ──────────────────────
    for (const status of ["processing", "chunking", "embedding", "clustering", "keywording"]) {
      await db.update(document).set({ processingStatus: status }).where(
        eq(document.id, doc.documentId),
      );
      await expect(
        client.documents.attachBlob(sandboxKbId, doc.documentId, {
          file: replacement,
          filename: "attach-me.md",
        }),
      ).rejects.toMatchObject({ status: 409, code: "conflict" });
    }
    // `pending` is not refused: an upload made with `includedInKb: false` rests
    // there with no job at all, and attaching its bytes is the obvious move.
    await db
      .update(document)
      .set({ processingStatus: "pending" })
      .where(eq(document.id, doc.documentId));
    expect(
      (
        await client.documents.attachBlob(sandboxKbId, doc.documentId, {
          file: replacement,
          filename: "attach-me.md",
        })
      ).processingStatus,
    ).toBe("pending");
    await db
      .update(document)
      .set({ processingStatus: "completed" })
      .where(eq(document.id, doc.documentId));

    // ── 404, and it says nothing about whose document it is ───────────────
    await expect(
      clientB.documents.attachBlob(sandboxKbId, doc.documentId, {
        file: replacement,
        filename: "attach-me.md",
      }),
    ).rejects.toMatchObject({ status: 404, code: "not-found" });
    await expect(
      client.documents.attachBlob(kbIds.sdk, doc.documentId, {
        file: replacement,
        filename: "attach-me.md",
      }),
    ).rejects.toMatchObject({ status: 404, code: "not-found" });
    await expect(
      client.documents.attachBlob(sandboxKbId, "d_does_not_exist", {
        file: replacement,
        filename: "attach-me.md",
      }),
    ).rejects.toMatchObject({ status: 404, code: "not-found" });

    // ── The body has to be a multipart one carrying a `file` part ─────────
    const noFile = new FormData();
    noFile.append("filename", "attach-me.md");
    await expect(
      client.request("PUT", `/v1/kbs/${sandboxKbId}/documents/${doc.documentId}/blob`, {
        multipart: noFile,
      }),
    ).rejects.toMatchObject({ status: 400, code: "bad-request" });
    await expect(
      client.request("PUT", `/v1/kbs/${sandboxKbId}/documents/${doc.documentId}/blob`, {
        json: { file: "no" },
      }),
    ).rejects.toMatchObject({ status: 415, code: "unsupported-media-type" });
    // And the two fields are validated, not swallowed.
    const emptyName = new FormData();
    emptyName.append("file", new Blob([new Uint8Array(replacement)]), "attach-me.md");
    emptyName.append("filename", "");
    await expect(
      client.request("PUT", `/v1/kbs/${sandboxKbId}/documents/${doc.documentId}/blob`, {
        multipart: emptyName,
      }),
    ).rejects.toMatchObject({ status: 400, code: "validation-failed" });

    // A document ingested as text has no stored bytes at all, and this is how
    // it gets some — the `include`-with-no-bytes 409 has an answer now.
    const textDoc = await client.kbs.ingest(sandboxKbId, {
      filename: "text-then-bytes.md",
      text: "Six weeks at full pay.",
    });
    await waitForDocument(sandboxKbId, textDoc.documentId);
    await inlineJobsSettled();
    expect((await client.documents.get(sandboxKbId, textDoc.documentId)).fileUrl).toBe("");
    const filled = await client.documents.attachBlob(sandboxKbId, textDoc.documentId, {
      file: replacement,
      filename: "text-then-bytes.md",
      mimeType: "text/markdown",
    });
    expect(isInternalFileUrl(filled.fileUrl)).toBe(true);
    await inlineJobsSettled();
  }, 300_000);
});
