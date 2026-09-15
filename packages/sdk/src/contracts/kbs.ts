/**
 * Knowledge bases: the record, its CRUD, and the query.
 *
 * The record's field names are Studio's, not new ones — `getKnowledgeBaseById`
 * selects exactly these and Studio's routes serialise them straight through, so
 * a Studio wrapper (plan Part 3) returns what it returns today by passing the
 * body along rather than by rebuilding it. Two of them are the lift's renames
 * seen from outside: `userId` is `owner_id` and `workspaceId` is
 * `paired_client_id`. They keep their Studio spelling on the wire because the
 * caller that reads them is Studio (ADR 0005).
 */

import { z } from "zod";
import {
  IsoDateTimeSchema,
  MetadataSchema,
  NullableIsoDateTimeSchema,
  PaginationSchema,
} from "./common.ts";

/**
 * A KB's chunking configuration.
 *
 * Units, and they differ per key because Studio's do: `maxSize` and `overlap`
 * are **tokens**, `minSize` is **characters**. `chunkSize` is the same number
 * as `maxSize` under the name `lib/kb/ingest.ts` reads it by; both are accepted
 * and stored, because the two ingest paths read different keys and a KB that
 * sets only one of them chunks differently on each (see the fixture's
 * `$comment`).
 */
export const ChunkingConfigSchema = z
  .object({
    maxSize: z.number().int().positive(),
    minSize: z.number().int().nonnegative(),
    overlap: z.number().int().nonnegative(),
    chunkSize: z.number().int().positive().optional(),
    method: z.string().optional(),
    strategy: z.string().optional(),
    strategyOptions: z.record(z.unknown()).optional(),
  })
  .passthrough();
export type ChunkingConfig = z.infer<typeof ChunkingConfigSchema>;

/** A knowledge base as every read route returns it. */
export const KnowledgeBaseSchema = z.object({
  id: z.string(),
  /** `owner_id`: the SDK-supplied `ownerId`, or the paired client's own id. */
  userId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  tokenCount: z.number(),
  embeddingModel: z.string().nullable(),
  embeddingDimension: z.number().int(),
  chunkingConfig: ChunkingConfigSchema,
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  deletedAt: NullableIsoDateTimeSchema,
  /** `paired_client_id`. Always this caller's own id (ADR 0003). */
  workspaceId: z.string().nullable(),
  docCount: z.number().int(),
  /** Always empty: connectors stayed in Studio (ADR 0002). */
  connectorTypes: z.array(z.string()),
  clusterCount: z.number().int().nullable().optional(),
  silhouette: z.number().nullable().optional(),
  clustersUpdatedAt: NullableIsoDateTimeSchema.optional(),
  inferenceModelId: z.string().nullable().optional(),
  embeddingEndpointId: z.string().nullable().optional(),
  inferenceEndpointId: z.string().nullable().optional(),
  /** The KB's full-text language, which the partition's `content_tsv` is built with. */
  language: z.string().optional(),
});
export type KnowledgeBase = z.infer<typeof KnowledgeBaseSchema>;

/** `GET /v1/kbs`. */
export const ListKbsQuerySchema = z.object({
  scope: z.enum(["active", "archived", "all"]).optional(),
});
export type ListKbsQuery = z.infer<typeof ListKbsQuerySchema>;

export const ListKbsResponseSchema = z.object({
  knowledgeBases: z.array(KnowledgeBaseSchema),
});
export type ListKbsResponse = z.infer<typeof ListKbsResponseSchema>;

/**
 * `POST /v1/kbs`.
 *
 * `ownerId` is the one field with no counterpart in a Studio call: Studio
 * passes its own `userId` there so a migrated row keeps its owner, and a
 * standalone caller leaves it out and gets the paired client's id.
 */
export const CreateKbRequestSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  ownerId: z.string().min(1).optional(),
  embeddingModel: z.string().min(1).optional(),
  embeddingDimension: z.number().int().positive().optional(),
  chunkingConfig: ChunkingConfigSchema.optional(),
  embeddingEndpointId: z.string().min(1).optional(),
  inferenceEndpointId: z.string().min(1).optional(),
  inferenceModelId: z.string().min(1).optional(),
  /** KMeans `k`. Stored as `kmeans_k`; 8 when absent. */
  clusterCount: z.number().int().positive().max(1024).optional(),
  language: z.string().min(1).optional(),
});
export type CreateKbRequest = z.infer<typeof CreateKbRequestSchema>;

/** `PATCH /v1/kbs/:id`. Every field optional; an absent one is untouched. */
export const UpdateKbRequestSchema = z
  .object({
    name: z.string().min(1).max(200),
    description: z.string().max(2000),
    chunkingConfig: z.object({
      maxSize: z.number().int().positive(),
      minSize: z.number().int().nonnegative(),
      overlap: z.number().int().nonnegative(),
    }),
    inferenceModelId: z.string().nullable(),
    inferenceEndpointId: z.string().nullable(),
    clusterCount: z.number().int().positive().max(1024),
  })
  .partial();
export type UpdateKbRequest = z.infer<typeof UpdateKbRequestSchema>;

export const DeleteKbResponseSchema = z.object({
  id: z.string(),
  deleted: z.literal(true),
});
export type DeleteKbResponse = z.infer<typeof DeleteKbResponseSchema>;

// ─── Query ───────────────────────────────────────────────────────────────────

export const TokenUsageSchema = z.object({
  promptTokens: z.number(),
  totalTokens: z.number(),
});
export type TokenUsage = z.infer<typeof TokenUsageSchema>;

/**
 * One structured filter on the v1 tag path. `tagSlot` names a column
 * (`tag1`…`boolean3`), `fieldType` says how to read `value`, and two filters on
 * different slots are ANDed.
 */
export const StructuredFilterSchema = z.object({
  tagName: z.string().optional(),
  tagSlot: z.string().min(1),
  fieldType: z.string().min(1),
  operator: z.string().min(1),
  value: z.union([z.string(), z.number(), z.boolean()]),
  valueTo: z.union([z.string(), z.number()]).optional(),
});
export type StructuredFilter = z.infer<typeof StructuredFilterSchema>;

/**
 * `POST /v1/kbs/:id/query`.
 *
 * `mode` picks the engine. `hybrid` (the default) is `handleKbQuery` — closed-set
 * query-keyword selection from the KB's own vocabulary, then the blended
 * keyword+semantic rank over the KB's partition. `v1-tags` is the pre-v2 path
 * over the shared `embedding` table: tag filter first, vector search over what
 * survives. Both are served, neither is a reimplementation of the other, and
 * ADR 0009 says why they are one route.
 */
export const QueryRequestSchema = z
  .object({
    /**
     * The query text, embedded through the KB's own embedding endpoint.
     *
     * **Required, except for a tag-only v1 search.** `mode: 'v1-tags'` with a
     * non-empty `tags` is the one request that ranks by nothing: it filters by
     * tag and answers with what survives, embedding nothing at all
     * (`handleTagOnlySearch`). Studio has always been able to ask for that and
     * this wire could not express it — `text: ''` is a `400`, and sending the
     * tag values as the text is a different ranking — so the whole class of
     * query stayed in Studio (TASK-009's rework notes, contract change 1).
     *
     * Optional *only* there. `hybrid` embeds, and so does a tag-less
     * `v1-tags` — which is the **vector-only** v1 search
     * (`handleVectorOnlySearch`), the shape Studio's own wired path sends as
     * `{ text, topK }` with no filters at all. A request with nothing to embed
     * and nothing to filter by is refused below rather than answered with an
     * arbitrary vector.
     */
    text: z.string().min(1).optional(),
    /**
     * How many rows to return. Up to **100**.
     *
     * 100 and not 50 because Studio's own public routes accept 100
     * (`app/api/knowledge/search/route.ts`, `app/api/v1/knowledge/search`) and
     * the lifted engines take it unchanged — it is a `LIMIT`. Against a
     * ceiling of 50 a `topK` in between either came back short or had to be
     * fanned out at 50 per KB and merged, which is a *different* result set
     * for a single-KB search (ADR 0009, "the topK ceiling").
     */
    topK: z.number().int().positive().max(100).optional(),
    keywordWeight: z.number().min(0).max(1).optional(),
    neighborClusters: z.number().int().min(0).max(20).optional(),
    filter: z.record(z.unknown()).optional(),
    minScore: z.number().optional(),
    includeContent: z.boolean().optional(),
    includeDiagnostics: z.boolean().optional(),
    mode: z.enum(["hybrid", "v1-tags"]).optional(),
    /** The v1 path's structured tag filters. Ignored by `hybrid`. */
    tags: z.array(StructuredFilterSchema).optional(),
    /**
     * The cosine distance a v1 row has to be inside, instead of the one this
     * instance's `getQueryStrategy` would compute.
     *
     * **`v1-tags` only: given with `hybrid` it is a `400`.** Studio computes
     * this once for a whole multi-KB call — `0.8` above three knowledge bases,
     * `1.0` otherwise — and then asks each KB separately, so an instance left
     * to infer it from the single KB in front of it always answers `1.0` and a
     * search over four or more KBs could not be reproduced on this wire at all
     * (TASK-009's rework notes, contract change 2). Saying it is the fix.
     *
     * The blended v2 rank has no distance threshold to override — it ranks by
     * a score, and `minScore` is its floor — so a `hybrid` request carrying
     * this field is asking for something that does not exist. Refused rather
     * than accepted and dropped, because a threshold that was quietly ignored
     * looks exactly like one that was applied.
     *
     * **Above `0`, not from `0`.** The frozen v1 search functions test their
     * threshold with `!distanceThreshold` — "was one given?" — so a stated `0`
     * is indistinguishable there from one left out and the guard throws
     * ("Query vector and distance threshold are required…"), which on this wire
     * is a `500`. `0` is also the one value that can match nothing at all: a
     * cosine distance is `< threshold`, so `0` is an empty result set by
     * definition and anybody who means that means `minScore`-style "nothing".
     * Refused at the contract rather than translated, because the engine is
     * frozen (ADR 0005) and a `400` on the field is the honest answer.
     */
    distanceThreshold: z.number().gt(0).max(2).optional(),
    /**
     * The canonical query keywords to blend with, instead of the ones the
     * instance would pick.
     *
     * **Omitting this and sending `[]` are different requests**, and both are
     * engine behaviour the lift froze (ADR 0005):
     *
     *   - **Omitted** — the instance selects the query's keywords from the KB's
     *     own vocabulary first (`selectQueryKeywordsFromMenu`), then blends.
     *     This is what the search bar and the app-SDK have always done, and it
     *     is the default because it is the one a caller who has no vocabulary
     *     in hand wants.
     *   - **`[]`** — no keywords, so the blend collapses to pure semantic
     *     similarity whatever `keywordWeight` says. This is what a caller that
     *     went straight to `queryKb` got, and it is a materially different
     *     ranking rather than a tuning knob.
     *   - **A list** — exactly these, already in canonical form.
     */
    queryKeywords: z.array(z.string()).optional(),
  })
  /**
   * The two cross-field rules, in one place because both are about which
   * engine the request is for.
   *
   * `superRefine` rather than two `.refine`s so that a request that is wrong
   * twice is told both times, and so that each issue lands on the field it is
   * about — `detail.issues[].path` is what a caller's own error message is
   * built from.
   */
  .superRefine((value, ctx) => {
    const mode = value.mode ?? "hybrid";
    /** The one shape that ranks by nothing, and so needs no text. */
    const tagOnly = mode === "v1-tags" && (value.tags?.length ?? 0) > 0;
    if (value.text === undefined && !tagOnly) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["text"],
        message:
          "`text` is required unless `mode` is 'v1-tags' and `tags` is non-empty — " +
          "the tag-only search, the one shape that embeds nothing. A tag-less " +
          "`v1-tags` is the vector-only search and embeds `text` like any other",
      });
    }
    if (value.distanceThreshold !== undefined && mode !== "v1-tags") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["distanceThreshold"],
        message:
          "`distanceThreshold` is a cosine distance and only `mode: 'v1-tags'` ranks by one; " +
          "the hybrid path ranks by a blended score, whose floor is `minScore`",
      });
    }
  });
export type QueryRequest = z.infer<typeof QueryRequestSchema>;

/** One hybrid match. The shape `queryKb` has always returned. */
export const QueryMatchSchema = z.object({
  id: z.string(),
  documentId: z.string(),
  chunkIndex: z.number().int(),
  content: z.string().nullable(),
  metadata: MetadataSchema,
  score: z.number(),
  semanticScore: z.number(),
  keywordScore: z.number(),
});
export type QueryMatch = z.infer<typeof QueryMatchSchema>;

export const HybridQueryResponseSchema = z.object({
  mode: z.literal("hybrid"),
  matches: z.array(QueryMatchSchema),
  usage: z.object({ embed: TokenUsageSchema, keywords: TokenUsageSchema }).optional(),
  diagnostics: z
    .object({
      candidateClusterIds: z.array(z.number()).nullable(),
      queryKeywords: z.array(z.string()),
    })
    .optional(),
});
export type HybridQueryResponse = z.infer<typeof HybridQueryResponseSchema>;

/** One v1 tag+vector row. `distance` is cosine distance, ascending. */
export const V1MatchSchema = z.object({
  id: z.string(),
  content: z.string(),
  documentId: z.string(),
  chunkIndex: z.number().int(),
  tag1: z.string().nullable(),
  tag2: z.string().nullable(),
  tag3: z.string().nullable(),
  tag4: z.string().nullable(),
  tag5: z.string().nullable(),
  tag6: z.string().nullable(),
  tag7: z.string().nullable(),
  number1: z.number().nullable(),
  number2: z.number().nullable(),
  number3: z.number().nullable(),
  number4: z.number().nullable(),
  number5: z.number().nullable(),
  date1: NullableIsoDateTimeSchema,
  date2: NullableIsoDateTimeSchema,
  boolean1: z.boolean().nullable(),
  boolean2: z.boolean().nullable(),
  boolean3: z.boolean().nullable(),
  distance: z.number(),
  knowledgeBaseId: z.string(),
});
export type V1Match = z.infer<typeof V1MatchSchema>;

export const V1TagQueryResponseSchema = z.object({
  mode: z.literal("v1-tags"),
  matches: z.array(V1MatchSchema),
  /**
   * What the v1 path actually ran with. A v1 caller logs it; nothing reads it.
   *
   * `getQueryStrategy`'s answer, except that `distanceThreshold` is the
   * **effective** one: a request that stated its own (see
   * {@link QueryRequestSchema}) reads its own value back, because a caller
   * comparing the threshold it asked for against the one it is told about
   * should not have to know which of the two this field means.
   *
   * Which is also why it is **absent on the tag-only search**: that shape
   * embeds nothing, ranks by nothing and thresholds nothing, so there is no
   * distance any row was kept or dropped for. Reporting the number
   * `getQueryStrategy` would have computed — or the one the caller stated —
   * would be reporting a threshold that never ran, on the one path where the
   * field cannot mean what it means everywhere else.
   */
  strategy: z.object({
    useParallel: z.boolean(),
    distanceThreshold: z.number().optional(),
    parallelLimit: z.number(),
    singleQueryOptimized: z.boolean(),
  }),
  usage: z.object({ embed: TokenUsageSchema, keywords: TokenUsageSchema }).optional(),
});
export type V1TagQueryResponse = z.infer<typeof V1TagQueryResponseSchema>;

export const QueryResponseSchema = z.discriminatedUnion("mode", [
  HybridQueryResponseSchema,
  V1TagQueryResponseSchema,
]);
export type QueryResponse = z.infer<typeof QueryResponseSchema>;

export { PaginationSchema };
