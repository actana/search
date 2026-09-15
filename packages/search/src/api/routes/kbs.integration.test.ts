/**
 * @vitest-environment node
 *
 * `/v1/kbs` against a live Postgres, for the one question a mocked database
 * cannot answer: **does the response say what the row says?**
 *
 * The end-to-end proof found that it did not. `POST /v1/kbs` with an
 * `embeddingEndpointId` wrote `embedding_endpoint_id` and answered
 * `embeddingEndpointId: null`, and `GET /v1/kbs` repeated the null. Studio
 * reads KB shape from the instance over this wire, so a wired workspace saw a
 * KB with no embedding endpoint on a KB that had one — and the same hole hid
 * the inference endpoint, the inference model and the cluster count on the
 * create, the listing and the patch.
 *
 * Every assertion here compares the wire against the row it was written from,
 * through the SDK, because the SDK is the only way in (CONTEXT.md rule 4).
 *
 * Gated on `SEARCH_TEST_DATABASE_URL`. Postgres only — no Redis, no bucket,
 * nothing is ingested.
 *
 *     SEARCH_TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/search_test \
 *       pnpm --filter @actana/search-core test
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SearchClient } from "@actana/search/client";
import { generateShortId } from "@actana/search-shared/short-id";
import { resetConfig } from "../../config.ts";
import { db } from "../../db/client.ts";
import { knowledgeBase, modelEndpoint, pairedClient } from "../../db/schema.ts";
import { runMigrations } from "../../db/migrate.ts";
import { dropKbPartition } from "../../kb/ddl.ts";
import { ensureMaterial } from "../../pairing/self-register.ts";
import { PairingRevocations } from "../../pairing/pairing-revocation.ts";
import { SearchPairingStore } from "../../pairing/pairing-store.ts";
import { startSearchServer, type SearchServer } from "../server.ts";
import { registerSearchRoutes } from "./index.ts";

const TEST_DATABASE_URL = process.env.SEARCH_TEST_DATABASE_URL;
const describeDb = TEST_DATABASE_URL ? describe : describe.skip;

const PREFIX = `kbwire-${generateShortId(8)}`;
const CLIENT = `${PREFIX}-client`;
const EMBED_ENDPOINT = `${PREFIX}-embed`;
const INFER_ENDPOINT = `${PREFIX}-infer`;

let server: SearchServer;
let client: SearchClient;
let stateDir: string;
/** Every KB this file created, dropped in `afterAll` partition and all. */
const created: string[] = [];

/** The `embedding_endpoint_id` the database holds for a KB. */
async function persistedEmbeddingEndpointId(kbId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: knowledgeBase.embeddingEndpointId })
    .from(knowledgeBase)
    .where(eq(knowledgeBase.id, kbId))
    .limit(1);
  return row?.id ?? null;
}

describeDb("/v1/kbs answers with the row it wrote", () => {
  beforeAll(async () => {
    process.env.SEARCH_DATABASE_URL = TEST_DATABASE_URL as string;
    resetConfig();
    await runMigrations({ url: TEST_DATABASE_URL as string });

    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "search-kbwire-"));
    const { material } = await ensureMaterial({ stateDir, publicHosts: ["127.0.0.1"] });
    const store = new SearchPairingStore(db);
    const revocations = new PairingRevocations(store);

    // The pairing a real client would have redeemed; what is under test is
    // everything after the handshake.
    await db.insert(pairedClient).values({
      id: CLIENT,
      label: `${PREFIX} client`,
      certSerial: `${PREFIX}-serial`,
      certFingerprint: `${PREFIX}-fingerprint`,
      scope: "admin",
      status: "active",
      createdAt: new Date(),
    });

    // Two endpoints of this client's own, so `requireOwnedEndpoints` passes and
    // the ids in the responses below are ids that mean something.
    await db.insert(modelEndpoint).values([
      {
        id: EMBED_ENDPOINT,
        pairedClientId: CLIENT,
        kind: "embedding",
        provider: "openai",
        template: "openai-embeddings",
        model: "text-embedding-3-small",
        dimension: 1536,
        source: "local",
      },
      {
        id: INFER_ENDPOINT,
        pairedClientId: CLIENT,
        kind: "inference",
        provider: "openai",
        template: "openai-chat",
        model: "gpt-4o-mini",
        source: "local",
      },
    ]);

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
    client = SearchClient.insecureForTests(server.origin, CLIENT);
  }, 120_000);

  afterAll(async () => {
    for (const kbId of created) {
      await dropKbPartition({ kbId }).catch(() => {});
      await db.delete(knowledgeBase).where(eq(knowledgeBase.id, kbId)).catch(() => {});
    }
    // Cascades to `model_endpoint`.
    await db.delete(pairedClient).where(eq(pairedClient.id, CLIENT)).catch(() => {});
    await server?.close();
    if (stateDir) fs.rmSync(stateDir, { recursive: true, force: true });
  });

  /** The defect, at the route that had it. */
  it("returns the embedding endpoint the create persisted, not null", async () => {
    const kb = await client.kbs.create({
      name: `${PREFIX} create`,
      embeddingEndpointId: EMBED_ENDPOINT,
      inferenceEndpointId: INFER_ENDPOINT,
      inferenceModelId: "gpt-4o-mini",
      clusterCount: 12,
      // `simple` and `english` are the two the partitioner accepts
      // (`kb/ddl.ts`); `simple` is the one that is not the column default, so
      // it proves the value travelled.
      language: "simple",
    });
    created.push(kb.id);

    expect(await persistedEmbeddingEndpointId(kb.id)).toBe(EMBED_ENDPOINT);
    expect(kb.embeddingEndpointId).toBe(EMBED_ENDPOINT);
    expect(kb.inferenceEndpointId).toBe(INFER_ENDPOINT);
    expect(kb.inferenceModelId).toBe("gpt-4o-mini");
    expect(kb.clusterCount).toBe(12);
    expect(kb.language).toBe("simple");
    // The dimension comes off the endpoint, which is the one v2 column the
    // lifted create did carry — asserted so a regression there is not read as
    // this one.
    expect(kb.embeddingDimension).toBe(1536);
  });

  it("reports nulls for a KB that really has no endpoints", async () => {
    const kb = await client.kbs.create({ name: `${PREFIX} bare` });
    created.push(kb.id);
    expect(kb.embeddingEndpointId).toBeNull();
    expect(kb.inferenceEndpointId).toBeNull();
    expect(kb.inferenceModelId).toBeNull();
    // The column default, not a null: a KB always has a `k`.
    expect(kb.clusterCount).toBe(8);
    expect(kb.language).toBe("english");
  });

  /** The listing had the same hole, for the same reason, and it is what Studio polls. */
  it("returns the endpoint ids in the listing too", async () => {
    const kb = await client.kbs.create({
      name: `${PREFIX} listed`,
      embeddingEndpointId: EMBED_ENDPOINT,
      clusterCount: 5,
    });
    created.push(kb.id);

    const listed = (await client.kbs.list()).find((row) => row.id === kb.id);
    expect(listed).toBeDefined();
    expect(listed!.embeddingEndpointId).toBe(EMBED_ENDPOINT);
    expect(listed!.clusterCount).toBe(5);
    expect(listed!.language).toBe("english");
  });

  it("and on the single read, which was the one route already right", async () => {
    const kb = await client.kbs.create({
      name: `${PREFIX} single`,
      embeddingEndpointId: EMBED_ENDPOINT,
    });
    created.push(kb.id);
    expect((await client.kbs.get(kb.id)).embeddingEndpointId).toBe(EMBED_ENDPOINT);
  });

  /**
   * The patch answers with the row *after* the update. `updateKnowledgeBase`'s
   * own select leaves these columns out, so a patch that changed the inference
   * endpoint reported it as null while writing it.
   */
  it("returns what a patch left behind, endpoint ids included", async () => {
    const kb = await client.kbs.create({
      name: `${PREFIX} patched`,
      embeddingEndpointId: EMBED_ENDPOINT,
    });
    created.push(kb.id);

    const patched = await client.kbs.update(kb.id, {
      inferenceEndpointId: INFER_ENDPOINT,
      clusterCount: 16,
    });
    expect(patched.inferenceEndpointId).toBe(INFER_ENDPOINT);
    expect(patched.clusterCount).toBe(16);
    // Untouched by the patch, and still reported.
    expect(patched.embeddingEndpointId).toBe(EMBED_ENDPOINT);
  });

  it("carries the endpoint ids through an archive and a restore", async () => {
    const kb = await client.kbs.create({
      name: `${PREFIX} restored`,
      embeddingEndpointId: EMBED_ENDPOINT,
    });
    created.push(kb.id);

    await client.kbs.delete(kb.id);
    const archived = (await client.kbs.list({ scope: "archived" })).find((r) => r.id === kb.id);
    expect(archived?.embeddingEndpointId).toBe(EMBED_ENDPOINT);

    const restored = await client.kbs.restore(kb.id);
    expect(restored.embeddingEndpointId).toBe(EMBED_ENDPOINT);
  });
});
