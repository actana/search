/**
 * `/v1/kbs` — the knowledge bases, and the query over one.
 *
 * Every handler here is a thin shell: validate against the contract, check that
 * the row is this paired client's, call the lifted service function, serialise
 * what it returned. **Nothing in here decides anything about ranking**, which
 * is the property ADR 0005 exists to hold — `POST /kbs/:kbId/query` chooses
 * between two engines and then gets out of the way.
 */

import { and, eq, inArray } from "drizzle-orm";
import {
  CreateKbRequestSchema,
  ListKbsQuerySchema,
  QueryRequestSchema,
  UpdateKbRequestSchema,
} from "@actana/search/contracts";
import type {
  HybridQueryResponse,
  QueryRequest,
  V1TagQueryResponse,
} from "@actana/search/contracts";
import { generateShortId } from "@actana/search-shared/short-id";
import { db } from "../../db/client.ts";
import { knowledgeBase } from "../../db/schema.ts";
import { provisionKbPartition } from "../../kb/ddl.ts";
import { handleKbQuery } from "../../kb/query-handler.ts";
import { queryKb } from "../../kb/query.ts";
import { resolveKbEmbeddingEndpoint } from "../../kb/provider-context.ts";
import { executeWorkspaceEmbedding } from "../../models/embedding.ts";
import {
  createKnowledgeBase,
  deleteKnowledgeBase,
  getKnowledgeBaseById,
  getKnowledgeBases,
  KnowledgeBaseConflictError,
  updateKnowledgeBase,
} from "../../knowledge/service.ts";
import type { ChunkingConfig } from "../../knowledge/types.ts";
import { getQueryStrategy, handleTagAndVectorSearch } from "../../v1/knowledge-search-utils.ts";
import type { StructuredFilter } from "../../knowledge/types.ts";
import {
  badRequest,
  conflict,
  HttpError,
  notFound,
  parseWith,
  queryOf,
  readJsonBody,
  route,
  sendJson,
} from "../http.ts";
import { chargeQuery } from "../rate-limit.ts";
import { ownerIdFor, requireKb } from "../ownership.ts";
import { listEndpoints } from "../../models/endpoint-registry.ts";
import type { SearchRouter } from "../routes.ts";
import { iso, kbToWire } from "../serialize.ts";

/** A request id for the lifted service functions' log lines. */
const requestId = (): string => `rest-${generateShortId(8)}`;

/**
 * Studio's `createKnowledgeBase` takes these as literal types because its own
 * route's zod schema pinned them. A KB created here may name any model its
 * embedding endpoint actually serves, so the pin is satisfied by a cast rather
 * than by refusing a legal request — the dimension the row ends up with is read
 * off the endpoint inside `createKnowledgeBase` regardless.
 */
const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";
const DEFAULT_EMBEDDING_DIMENSION = 1536;

/** The column default, spelled out so a create and a UI-made KB agree. */
const DEFAULT_CHUNKING_CONFIG: ChunkingConfig = { maxSize: 1024, minSize: 1, overlap: 200 };

/**
 * Every model endpoint id in this request has to be one of the caller's own.
 *
 * **The frozen service will not check.** `createKnowledgeBase` looks the
 * embedding endpoint up by id with no `paired_client_id` predicate and never
 * looks the inference one up at all (`knowledge/service.ts`), so a client that
 * knew — or walked onto — another client's endpoint id could bind its own KB to
 * that client's sealed provider key and have this instance spend it. The engine
 * is behaviour-frozen (ADR 0005), so the check lives here, in the route, before
 * the id is handed over.
 *
 * `404 not-found` rather than `403`: an id that is not the caller's must not be
 * confirmed to exist (ADR 0009 D5).
 *
 * **One helper and one lookup**, over the endpoint registry's own per-client
 * listing (`models/endpoint-registry.ts`). It was written against a copy of
 * that listing that lived in `api/routes/endpoints.ts` until the two branches
 * met, with the same name and signature, so the merge was one import.
 */
async function requireOwnedEndpoints(
  pairedClientId: string,
  ids: Array<string | null | undefined>,
): Promise<void> {
  const wanted = ids.filter((id): id is string => typeof id === "string" && id !== "");
  if (wanted.length === 0) return;
  const owned = new Set((await listEndpoints(pairedClientId)).map((row) => row.id));
  for (const id of wanted) {
    if (!owned.has(id)) throw notFound(`no model endpoint ${id}`);
  }
}

export function registerKbRoutes(router: SearchRouter): void {
  router.add(
    route("GET", "/v1/kbs", "read", async ({ res, client, url }) => {
      const query = parseWith(ListKbsQuerySchema, queryOf(url));
      const rows = await getKnowledgeBases(client!.id, client!.id, query.scope ?? "active");
      const languages = await languagesFor(client!.id, rows.map((r) => r.id));
      sendJson(res, 200, {
        knowledgeBases: rows.map((kb) => kbToWire(kb, { language: languages.get(kb.id) })),
      });
    }),
  );

  router.add(
    route("POST", "/v1/kbs", "write", async ({ req, res, client }) => {
      const body = parseWith(CreateKbRequestSchema, await readJsonBody(req));
      await requireOwnedEndpoints(client!.id, [
        body.embeddingEndpointId,
        body.inferenceEndpointId,
      ]);

      let created;
      try {
        created = await createKnowledgeBase(
          {
            name: body.name,
            ...(body.description === undefined ? {} : { description: body.description }),
            workspaceId: client!.id,
            userId: ownerIdFor(client, body.ownerId),
            embeddingModel: (body.embeddingModel ??
              DEFAULT_EMBEDDING_MODEL) as typeof DEFAULT_EMBEDDING_MODEL,
            embeddingDimension: (body.embeddingDimension ??
              DEFAULT_EMBEDDING_DIMENSION) as typeof DEFAULT_EMBEDDING_DIMENSION,
            chunkingConfig: (body.chunkingConfig ?? DEFAULT_CHUNKING_CONFIG) as ChunkingConfig,
            ...(body.embeddingEndpointId === undefined
              ? {}
              : { embeddingEndpointId: body.embeddingEndpointId }),
            ...(body.inferenceEndpointId === undefined
              ? {}
              : { inferenceEndpointId: body.inferenceEndpointId }),
            ...(body.inferenceModelId === undefined
              ? {}
              : { inferenceModelId: body.inferenceModelId }),
            ...(body.clusterCount === undefined ? {} : { clusterCount: body.clusterCount }),
          },
          requestId(),
        );
      } catch (err) {
        if (err instanceof KnowledgeBaseConflictError) {
          throw conflict(`a knowledge base named "${body.name}" already exists`);
        }
        if (err instanceof Error && /endpoint not found/i.test(err.message)) {
          throw badRequest(err.message);
        }
        throw err;
      }

      /**
       * `language` is Search's own column — it sizes the partition's generated
       * `content_tsv` — and the lifted create does not know about it, so it is
       * written here rather than by widening a lifted signature.
       */
      const language = body.language ?? "english";
      if (language !== "english") {
        await db
          .update(knowledgeBase)
          .set({ language })
          .where(eq(knowledgeBase.id, created.id));
      }

      /**
       * Provision the partition now rather than at the first ingest.
       *
       * Two of the three ingest paths provision defensively on their way past
       * (`CREATE TABLE IF NOT EXISTS` under an advisory lock) and the third —
       * `ingestDocument`, which the JSON-text route uses — does not: it writes
       * straight into the partition and expects one. Doing it at create time is
       * also what the in-process fixture suite does, so the two replays start
       * from the same database.
       */
      const [row] = await db
        .select({
          embeddingDimension: knowledgeBase.embeddingDimension,
          language: knowledgeBase.language,
        })
        .from(knowledgeBase)
        .where(eq(knowledgeBase.id, created.id))
        .limit(1);
      await provisionKbPartition({
        kbId: created.id,
        dim: row?.embeddingDimension ?? DEFAULT_EMBEDDING_DIMENSION,
        language: row?.language ?? language,
      });

      sendJson(res, 201, kbToWire(created, { language: row?.language ?? language }));
    }),
  );

  router.add(
    route("GET", "/v1/kbs/:kbId", "read", async ({ res, client }, { kbId }) => {
      const owned = await requireKb(client, kbId!);
      const kb = await getKnowledgeBaseById(kbId!);
      if (!kb) throw notFound(`no knowledge base ${kbId}`);
      sendJson(res, 200, kbToWire(kb, { language: owned.language }));
    }),
  );

  router.add(
    route("PATCH", "/v1/kbs/:kbId", "write", async ({ req, res, client }, { kbId }) => {
      await requireKb(client, kbId!);
      const body = parseWith(UpdateKbRequestSchema, await readJsonBody(req));
      if (Object.keys(body).length === 0) throw badRequest("the patch is empty");
      // Same reason as the create: `updateKnowledgeBase` writes the id it is
      // given without asking whose it is.
      await requireOwnedEndpoints(client!.id, [
        body.inferenceEndpointId,
        (body as { embeddingEndpointId?: string | null }).embeddingEndpointId,
      ]);
      let updated;
      try {
        updated = await updateKnowledgeBase(kbId!, body, requestId());
      } catch (err) {
        if (err instanceof KnowledgeBaseConflictError) {
          throw conflict(err.message);
        }
        if (err instanceof Error && /not found/i.test(err.message)) {
          throw notFound(`no knowledge base ${kbId}`);
        }
        throw err;
      }
      const owned = await requireKb(client, kbId!);
      sendJson(res, 200, kbToWire(updated, { language: owned.language }));
    }),
  );

  router.add(
    route("DELETE", "/v1/kbs/:kbId", "write", async ({ res, client }, { kbId }) => {
      await requireKb(client, kbId!);
      await deleteKnowledgeBase(kbId!, requestId());
      sendJson(res, 200, { id: kbId, deleted: true });
    }),
  );

  router.add(
    route("POST", "/v1/kbs/:kbId/query", "read", async ({ req, res, client }, { kbId }) => {
      // The one route a caller can loop at no cost to itself. `api/rate-limit.ts`
      // says why this and not everything.
      chargeQuery(client!.id);
      const kb = await requireKb(client, kbId!);
      const body = parseWith(QueryRequestSchema, await readJsonBody(req));
      if ((body.mode ?? "hybrid") === "v1-tags") {
        sendJson(res, 200, await runV1TagQuery(kbId!, kb.embeddingEndpointId, body));
        return;
      }
      const engineArgs = {
        kbId: kbId!,
        text: body.text,
        ...(body.topK === undefined ? {} : { topK: body.topK }),
        ...(body.keywordWeight === undefined ? {} : { keywordWeight: body.keywordWeight }),
        ...(body.neighborClusters === undefined
          ? {}
          : { neighborClusters: body.neighborClusters }),
        ...(body.filter === undefined ? {} : { filter: body.filter }),
        ...(body.minScore === undefined ? {} : { minScore: body.minScore }),
        ...(body.includeContent === undefined ? {} : { includeContent: body.includeContent }),
        ...(body.includeDiagnostics === undefined
          ? {}
          : { includeDiagnostics: body.includeDiagnostics }),
      };
      /**
       * `queryKeywords` picks which of the two frozen entry points runs, and
       * they rank differently on the same corpus.
       *
       * Absent, the instance selects the query's keywords out of the KB's
       * vocabulary and then blends — `handleKbQuery`, which is what the search
       * bar and the app-SDK do. Present, the caller's list is used verbatim,
       * which with `[]` collapses the blend to pure semantic similarity —
       * `queryKb`, which is what a direct caller got. Both are frozen (ADR
       * 0005) and the fixture suite asserts both, so the wire has to be able to
       * say which one it means.
       */
      const result =
        body.queryKeywords === undefined
          ? await handleKbQuery({ pairedClientId: client!.id, source: "sdk" }, engineArgs)
          : await queryKb({ ...engineArgs, queryKeywordCanonicals: body.queryKeywords });
      const answer: HybridQueryResponse = {
        mode: "hybrid",
        matches: result.matches,
        ...(result.usage === undefined ? {} : { usage: result.usage }),
        ...(result.diagnostics === undefined ? {} : { diagnostics: result.diagnostics }),
      };
      sendJson(res, 200, answer);
    }),
  );
}

/**
 * The v1 tag+vector path, over the shared `embedding` table.
 *
 * The query vector is produced by the KB's own embedding endpoint, which is
 * what the v1 route did; `getQueryStrategy` then decides the distance
 * threshold. One KB per request here — the v1 route could search several, and
 * an instance of Search answers for one KB per call because the route names
 * one. That is the only difference, and it puts `kbCount` at 1, which is the
 * `singleQueryOptimized` branch.
 */
async function runV1TagQuery(
  kbId: string,
  embeddingEndpointId: string | null,
  body: QueryRequest,
): Promise<V1TagQueryResponse> {
  if (!embeddingEndpointId) {
    throw new HttpError(
      400,
      "bad-request",
      `knowledge base ${kbId} has no embedding endpoint configured`,
    );
  }
  const topK = body.topK ?? 5;
  const endpoint = await resolveKbEmbeddingEndpoint(embeddingEndpointId);
  const embedded = await executeWorkspaceEmbedding({ endpoint, input: body.text });
  const vector = embedded.embeddings[0];
  if (!vector) throw new HttpError(500, "core-error", "the embedding provider returned nothing");

  const strategy = getQueryStrategy(1, topK);
  const results = await handleTagAndVectorSearch({
    knowledgeBaseIds: [kbId],
    topK,
    structuredFilters: (body.tags ?? []) as StructuredFilter[],
    queryVector: `[${vector.join(",")}]`,
    distanceThreshold: strategy.distanceThreshold,
  });

  return {
    mode: "v1-tags",
    matches: results.map((row) => ({
      ...row,
      date1: iso(row.date1),
      date2: iso(row.date2),
      distance: Number(row.distance),
    })),
    strategy,
    usage: {
      embed: {
        promptTokens: embedded.usage?.promptTokens ?? 0,
        totalTokens: embedded.usage?.totalTokens ?? 0,
      },
      keywords: { promptTokens: 0, totalTokens: 0 },
    },
  };
}

/**
 * The `language` column for a batch of KBs, which the lifted type omits.
 *
 * Restricted to the ids asked for **and** to the calling client: this read used
 * to select every `knowledge_base` row on the instance and filter in memory,
 * which is one `GET /v1/kbs` reading every other client's rows to answer with
 * four of its own.
 */
async function languagesFor(
  pairedClientId: string,
  kbIds: string[],
): Promise<Map<string, string>> {
  if (kbIds.length === 0) return new Map();
  const rows = await db
    .select({ id: knowledgeBase.id, language: knowledgeBase.language })
    .from(knowledgeBase)
    .where(
      and(
        eq(knowledgeBase.pairedClientId, pairedClientId),
        inArray(knowledgeBase.id, kbIds),
      ),
    );
  return new Map(rows.map((r) => [r.id, r.language]));
}
