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
import { onSearchEvent } from "../events/emitter.ts";
import { resetAnnouncedEvents, runSearchJob } from "../jobs/run.ts";
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
});
