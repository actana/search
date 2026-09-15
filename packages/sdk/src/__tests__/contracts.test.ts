/**
 * @vitest-environment node
 *
 * The contracts as validators.
 *
 * ADR 0009 D2 says the core does not re-describe a body: every route's first
 * statement parses with one of these schemas, so what a schema accepts *is*
 * what the surface accepts. The rules worth a test are therefore the ones a
 * reader cannot see by looking at a field — the cross-field refusals, the
 * bounds, and the one parameter that arrives encoded.
 *
 * The routes' own behaviour, over a real server and a real database, is
 * `packages/search/src/__tests__/fixture-suite.rest.test.ts`.
 */

import { describe, expect, it } from "vitest";
import {
  AttachBlobMultipartFieldsSchema,
  BulkDocumentsRequestSchema,
  ChunkSchema,
  CreateChunkRequestSchema,
  IngestMultipartFieldsSchema,
  IngestResponseSchema,
  ListChunkKeywordsResponseSchema,
  ListDocumentsQuerySchema,
  QueryRequestSchema,
  SEARCH_SCOPES,
  WhoamiSchema,
} from "../contracts.ts";

/** The one tag filter every tag-only case below is asked with. */
const TAG: {
  tagName?: string;
  tagSlot: string;
  fieldType: string;
  operator: string;
  value: string;
} = { tagSlot: "tag1", fieldType: "text", operator: "eq", value: "handbook" };

/** The paths zod complained about, which is what a caller's message is built from. */
const issuePaths = (value: unknown): string[] => {
  const result = QueryRequestSchema.safeParse(value);
  return result.success ? [] : result.error.issues.map((issue) => issue.path.join("."));
};

describe("QueryRequestSchema: when `text` may be left out", () => {
  it("accepts a tag-only v1 search, which embeds nothing", () => {
    const parsed = QueryRequestSchema.parse({ mode: "v1-tags", tags: [TAG], topK: 20 });
    expect(parsed.text).toBeUndefined();
    expect(parsed.tags).toHaveLength(1);
  });

  it("still requires `text` for a hybrid query, named or defaulted", () => {
    expect(issuePaths({ topK: 5 })).toEqual(["text"]);
    expect(issuePaths({ mode: "hybrid", tags: [TAG] })).toEqual(["text"]);
  });

  it("still requires `text` for a v1 query with no tags to filter by", () => {
    // Nothing to rank by and nothing to filter by is not a search.
    expect(issuePaths({ mode: "v1-tags" })).toEqual(["text"]);
    expect(issuePaths({ mode: "v1-tags", tags: [] })).toEqual(["text"]);
  });

  it("refuses an empty `text` rather than treating it as absent", () => {
    // `''` would embed the empty string, which ranks by an arbitrary vector.
    expect(issuePaths({ mode: "v1-tags", tags: [TAG], text: "" })).toEqual(["text"]);
    expect(issuePaths({ text: "" })).toEqual(["text"]);
  });
});

describe("QueryRequestSchema: `distanceThreshold`", () => {
  it("is accepted on the v1 path, where there is a distance to threshold", () => {
    expect(QueryRequestSchema.parse({ mode: "v1-tags", text: "leave", distanceThreshold: 0.8 }))
      .toMatchObject({ distanceThreshold: 0.8 });
    // The whole range the wire allows, from just above zero to two.
    for (const value of [0.000001, 0.8, 1, 2]) {
      expect(
        QueryRequestSchema.safeParse({ mode: "v1-tags", text: "q", distanceThreshold: value })
          .success,
      ).toBe(true);
    }
  });

  it("is refused with `hybrid` — and with no mode at all, which is `hybrid`", () => {
    expect(issuePaths({ text: "q", distanceThreshold: 0.8 })).toEqual(["distanceThreshold"]);
    expect(issuePaths({ mode: "hybrid", text: "q", distanceThreshold: 0.8 })).toEqual([
      "distanceThreshold",
    ]);
  });

  it("is a cosine distance, so it is refused outside (0, 2]", () => {
    for (const value of [-0.1, 2.1]) {
      expect(issuePaths({ mode: "v1-tags", text: "q", distanceThreshold: value })).toEqual([
        "distanceThreshold",
      ]);
    }
  });

  it("refuses `0`, which the frozen guard cannot tell from nothing at all", () => {
    /**
     * `handleVectorOnlySearch` and `handleTagAndVectorSearch` both test this
     * with `!distanceThreshold` — "was one given?" — so a stated `0` reads
     * there as absent and the guard throws a plain `Error`, which on the wire
     * was a `500` on a body the contract had accepted. `0` is also the one
     * value that can match nothing at all, since a row is kept for being
     * `< threshold`. Refused at the contract, because the engine is frozen
     * (ADR 0005) and a `400` on the field is the honest answer.
     */
    expect(issuePaths({ mode: "v1-tags", text: "q", distanceThreshold: 0 })).toEqual([
      "distanceThreshold",
    ]);
    expect(
      issuePaths({ mode: "v1-tags", tags: [TAG], distanceThreshold: 0 }),
    ).toEqual(["distanceThreshold"]);
  });

  it("reports both cross-field refusals at once when a request is wrong twice", () => {
    // `superRefine` rather than two `.refine`s: a caller fixing one thing at a
    // time is a caller making two more round trips.
    expect(issuePaths({ mode: "hybrid", distanceThreshold: 0.8 })).toEqual([
      "text",
      "distanceThreshold",
    ]);
  });
});

describe("QueryRequestSchema: the `topK` ceiling", () => {
  it("accepts 100, which is what Studio's own public routes accept", () => {
    expect(QueryRequestSchema.parse({ text: "q", topK: 100 }).topK).toBe(100);
    expect(QueryRequestSchema.parse({ text: "q", topK: 51 }).topK).toBe(51);
  });

  it("refuses 101, a fraction and zero", () => {
    for (const topK of [101, 0, -1, 12.5]) {
      expect(issuePaths({ text: "q", topK })).toEqual(["topK"]);
    }
  });
});

describe("IngestMultipartFieldsSchema: the tag parts", () => {
  it("carries the seventeen slots as string parts, as the JSON `tags` object does", () => {
    const parsed = IngestMultipartFieldsSchema.parse({
      filename: "handbook.md",
      tag1: "handbook",
      tag7: "people",
      number1: "42",
      date1: "2026-09-15",
      boolean1: "true",
    });
    expect(parsed).toMatchObject({
      tag1: "handbook",
      tag7: "people",
      number1: "42",
      date1: "2026-09-15",
      boolean1: "true",
    });
  });

  it("leaves the slots a form did not send undefined rather than empty", () => {
    const parsed = IngestMultipartFieldsSchema.parse({ filename: "a.md" });
    expect(parsed.tag1).toBeUndefined();
    expect(Object.keys(parsed)).toEqual(["filename"]);
  });

  it("refuses a tag part that is not a string, and there is no `tag8`", () => {
    expect(IngestMultipartFieldsSchema.safeParse({ tag1: 42 }).success).toBe(false);
    // A form can only carry strings, so an unknown part is dropped rather than
    // refused — but it is dropped, which is what keeps it out of the staged row.
    expect(IngestMultipartFieldsSchema.parse({ tag8: "x" })).toEqual({});
  });
});

describe("IngestResponseSchema: `chunkCount`", () => {
  it("is optional, because a 202 usually cannot know it yet", () => {
    expect(IngestResponseSchema.parse({ documentId: "d_1", processingStatus: "pending" }))
      .toEqual({ documentId: "d_1", processingStatus: "pending" });
  });

  it("is a non-negative integer when it is there", () => {
    expect(
      IngestResponseSchema.parse({
        documentId: "d_1",
        processingStatus: "completed",
        chunkCount: 12,
      }).chunkCount,
    ).toBe(12);
    for (const chunkCount of [-1, 1.5, "12"]) {
      expect(
        IngestResponseSchema.safeParse({
          documentId: "d_1",
          processingStatus: "completed",
          chunkCount,
        }).success,
      ).toBe(false);
    }
  });
});

describe("BulkDocumentsRequestSchema", () => {
  const paths = (value: unknown): string[] => {
    const result = BulkDocumentsRequestSchema.safeParse(value);
    return result.success ? [] : result.error.issues.map((issue) => issue.path.join("."));
  };

  it("takes a list of ids, or a filter, and refuses both and neither", () => {
    expect(
      BulkDocumentsRequestSchema.parse({ operation: "disable", documentIds: ["d_1", "d_2"] }),
    ).toEqual({ operation: "disable", documentIds: ["d_1", "d_2"] });
    expect(
      BulkDocumentsRequestSchema.parse({ operation: "enable", enabledFilter: "disabled" }),
    ).toEqual({ operation: "enable", enabledFilter: "disabled" });

    expect(paths({ operation: "delete" })).toEqual(["documentIds"]);
    expect(
      paths({ operation: "delete", documentIds: ["d_1"], enabledFilter: "all" }),
    ).toEqual(["documentIds"]);
  });

  it("caps a list at 500 and refuses an empty one", () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `d_${i}`);
    expect(
      BulkDocumentsRequestSchema.parse({ operation: "delete", documentIds: ids(500) }).documentIds,
    ).toHaveLength(500);
    expect(paths({ operation: "delete", documentIds: ids(501) })).toEqual(["documentIds"]);
    // An empty list is a call that means nothing; the by-filter form is how a
    // caller says "everything".
    expect(paths({ operation: "delete", documentIds: [] })).toEqual(["documentIds"]);
  });

  it("has exactly the three operations the frozen service implements", () => {
    for (const operation of ["enable", "disable", "delete"]) {
      expect(
        BulkDocumentsRequestSchema.safeParse({ operation, documentIds: ["d_1"] }).success,
      ).toBe(true);
    }
    expect(paths({ operation: "archive", documentIds: ["d_1"] })).toEqual(["operation"]);
  });
});

describe("CreateChunkRequestSchema", () => {
  it("needs content, and `enabled` is the only other thing a caller may say", () => {
    expect(CreateChunkRequestSchema.parse({ content: "A paragraph." })).toEqual({
      content: "A paragraph.",
    });
    expect(CreateChunkRequestSchema.parse({ content: "x", enabled: false })).toEqual({
      content: "x",
      enabled: false,
    });
    expect(CreateChunkRequestSchema.safeParse({ content: "" }).success).toBe(false);
    expect(CreateChunkRequestSchema.safeParse({ enabled: true }).success).toBe(false);
    // `chunkIndex` is the engine's (the next one, taken in a transaction) and
    // the tags are inherited from the document, so neither is on the wire.
    expect(CreateChunkRequestSchema.parse({ content: "x", chunkIndex: 3, tag1: "a" })).toEqual({
      content: "x",
    });
  });
});

describe("ListDocumentsQuerySchema: `tagFilters`", () => {
  it("decodes the one JSON parameter into the conditions the engine takes", () => {
    const filters = [
      { tagSlot: "tag1", fieldType: "text", operator: "contains", value: "hand" },
      { tagSlot: "number1", fieldType: "number", operator: "between", value: "1", valueTo: "9" },
    ];
    const parsed = ListDocumentsQuerySchema.parse({
      limit: "25",
      tagFilters: JSON.stringify(filters),
    });
    expect(parsed.tagFilters).toEqual(filters);
    // The scalars still coerce, so one encoded parameter did not change the rest.
    expect(parsed.limit).toBe(25);
  });

  it("takes the array itself too, for a caller that is not a query string", () => {
    const parsed = ListDocumentsQuerySchema.parse({ tagFilters: [TAG] });
    expect(parsed.tagFilters).toEqual([TAG]);
  });

  it("is absent when it is absent", () => {
    expect(ListDocumentsQuerySchema.parse({}).tagFilters).toBeUndefined();
  });

  it("refuses a value that is not JSON with a validation error, not a throw", () => {
    const result = ListDocumentsQuerySchema.safeParse({ tagFilters: "not json at all" });
    expect(result.success).toBe(false);
    expect(result.success ? [] : result.error.issues[0]!.path).toEqual(["tagFilters"]);
  });

  it("refuses a slot the engine would silently drop", () => {
    // A dropped condition answers a filtered listing with an unfiltered one,
    // which is the one wrong answer this parameter must not be able to give.
    expect(
      ListDocumentsQuerySchema.safeParse({
        tagFilters: JSON.stringify([{ ...TAG, tagSlot: "tag8" }]),
      }).success,
    ).toBe(false);
    expect(
      ListDocumentsQuerySchema.safeParse({
        tagFilters: JSON.stringify([{ ...TAG, fieldType: "colour" }]),
      }).success,
    ).toBe(false);
  });

  it("refuses an operator the engine does not implement at all", () => {
    /**
     * `buildTagFilterCondition` answers a condition it cannot build with
     * `undefined`, and an undefined condition is **dropped** — so an operator
     * it has never heard of answered a *filtered* listing with the
     * *unfiltered* one, which a caller cannot tell from the rows. The enum is
     * exactly what that function's four branches implement.
     */
    for (const operator of ["regex", "in", "not_in", "is_null", "like", "EQ", ""]) {
      expect(
        ListDocumentsQuerySchema.safeParse({ tagFilters: [{ ...TAG, operator }] }).success,
      ).toBe(false);
    }
    // And the eleven it does implement are all accepted, on a type that has them.
    for (const operator of ["eq", "neq", "contains", "not_contains", "starts_with", "ends_with"]) {
      expect(
        ListDocumentsQuerySchema.safeParse({ tagFilters: [{ ...TAG, operator }] }).success,
      ).toBe(true);
    }
    for (const operator of ["eq", "neq", "gt", "gte", "lt", "lte"]) {
      expect(
        ListDocumentsQuerySchema.safeParse({
          tagFilters: [{ tagSlot: "number1", fieldType: "number", operator, value: "7" }],
        }).success,
      ).toBe(true);
    }
  });

  it("refuses an operator that type's branch does not implement", () => {
    // A real operator on the wrong type is the dropped-condition case again:
    // the `text` branch has no `gt`, the `boolean` branch has only `eq`/`neq`.
    const refused = [
      { tagSlot: "tag1", fieldType: "text", operator: "gt", value: "x" },
      { tagSlot: "tag1", fieldType: "text", operator: "between", value: "a", valueTo: "b" },
      { tagSlot: "boolean1", fieldType: "boolean", operator: "contains", value: "true" },
      { tagSlot: "boolean1", fieldType: "boolean", operator: "gte", value: "true" },
      { tagSlot: "number1", fieldType: "number", operator: "contains", value: "7" },
      { tagSlot: "date1", fieldType: "date", operator: "starts_with", value: "2026" },
    ];
    for (const condition of refused) {
      const result = ListDocumentsQuerySchema.safeParse({ tagFilters: [condition] });
      expect(result.success).toBe(false);
      expect(result.success ? [] : result.error.issues[0]!.path).toEqual([
        "tagFilters",
        0,
        "operator",
      ]);
    }
  });

  it("binds `fieldType` to the slot's own prefix", () => {
    /**
     * Worse than a dropped condition: `{ tagSlot: 'number1', fieldType: 'text' }`
     * reaches Postgres as a text comparison against an integer column, which is
     * a type error and a `500`. The prefix *is* the column's type, so the pair
     * has exactly one valid spelling and the mismatch is a `400` on `fieldType`.
     */
    for (const condition of [
      { tagSlot: "number1", fieldType: "text", operator: "eq", value: "7" },
      { tagSlot: "tag1", fieldType: "number", operator: "eq", value: "7" },
      { tagSlot: "date1", fieldType: "text", operator: "eq", value: "2026-09-15" },
      { tagSlot: "boolean1", fieldType: "text", operator: "eq", value: "true" },
      { tagSlot: "tag7", fieldType: "boolean", operator: "eq", value: "true" },
    ]) {
      const result = ListDocumentsQuerySchema.safeParse({ tagFilters: [condition] });
      expect(result.success).toBe(false);
      expect(result.success ? [] : result.error.issues[0]!.path).toEqual([
        "tagFilters",
        0,
        "fieldType",
      ]);
    }
    // Each family's own spelling, accepted.
    for (const condition of [
      { tagSlot: "tag4", fieldType: "text", operator: "eq", value: "x" },
      { tagSlot: "number5", fieldType: "number", operator: "lt", value: "7" },
      { tagSlot: "date2", fieldType: "date", operator: "gte", value: "2026-09-15" },
      { tagSlot: "boolean3", fieldType: "boolean", operator: "neq", value: "false" },
    ]) {
      expect(ListDocumentsQuerySchema.safeParse({ tagFilters: [condition] }).success).toBe(true);
    }
  });

  it("requires `valueTo` for `between`, which the engine drops without one", () => {
    for (const condition of [
      { tagSlot: "number1", fieldType: "number", operator: "between", value: "1" },
      { tagSlot: "date1", fieldType: "date", operator: "between", value: "2026-01-01" },
    ]) {
      const result = ListDocumentsQuerySchema.safeParse({ tagFilters: [condition] });
      expect(result.success).toBe(false);
      expect(result.success ? [] : result.error.issues[0]!.path).toEqual([
        "tagFilters",
        0,
        "valueTo",
      ]);
      expect(
        ListDocumentsQuerySchema.safeParse({ tagFilters: [{ ...condition, valueTo: "9" }] })
          .success,
      ).toBe(true);
    }
  });

  it("refuses a number where the engine parses a string", () => {
    // `TagFilterCondition.value` is a string whatever the column's type is —
    // the service parses it, exactly as it does for a tag write.
    expect(
      ListDocumentsQuerySchema.safeParse({
        tagFilters: [{ tagSlot: "number1", fieldType: "number", operator: "eq", value: 42 }],
      }).success,
    ).toBe(false);
  });
});

/** A chunk as the four routes that produce one answer with it. */
const CHUNK = {
  id: "c_1",
  documentId: "d_1",
  chunkIndex: 0,
  content: "Six weeks, at full pay.",
  contentLength: 23,
  tokenCount: 6,
  enabled: true,
  startOffset: 0,
  endOffset: 23,
  tag1: "handbook",
  tag2: null,
  tag3: null,
  tag4: null,
  tag5: null,
  tag6: null,
  tag7: null,
  createdAt: "2026-09-15T00:00:00.000Z",
  updatedAt: "2026-09-15T00:00:00.000Z",
};

describe("ChunkSchema: `documentId`", () => {
  it("is required, because every route that answers with a chunk can say it", () => {
    // Three of the four are addressed through a document and the fourth reads
    // the whole `embedding` row, so there is no producer that would need it
    // optional — and a caller that addressed a chunk by id alone can check
    // which document it is in rather than assume (TASK-009c, request 12).
    expect(ChunkSchema.parse(CHUNK).documentId).toBe("d_1");
    const { documentId: _omitted, ...without } = CHUNK;
    const result = ChunkSchema.safeParse(without);
    expect(result.success).toBe(false);
    expect(result.success ? [] : result.error.issues[0]!.path).toEqual(["documentId"]);
  });
});

describe("ListChunkKeywordsResponseSchema", () => {
  /** One `embedding_keyword` row joined to its vocabulary row. */
  const LINK = {
    id: "k_1",
    knowledgeBaseId: "kb_1",
    keyword: "parental-leave",
    displayLabel: "Parental Leave",
    usageCount: 4,
    createdAt: "2026-09-15T00:00:00.000Z",
    updatedAt: "2026-09-15T00:00:00.000Z",
    createdByUserId: null,
    source: "manual",
    attachedAt: "2026-09-15T01:00:00.000Z",
  };

  it("is a keyword plus the join's own two fields", () => {
    // `source` and `attachedAt` are the reason this is not `keywords.list`
    // filtered: they are the *link's*, so two chunks carrying the same keyword
    // disagree about them.
    const parsed = ListChunkKeywordsResponseSchema.parse({ keywords: [LINK] });
    expect(parsed.keywords[0]).toEqual(LINK);
    expect(ListChunkKeywordsResponseSchema.parse({ keywords: [] }).keywords).toEqual([]);
  });

  it("takes only the two sources the engine writes", () => {
    expect(
      ListChunkKeywordsResponseSchema.safeParse({ keywords: [{ ...LINK, source: "llm" }] }).success,
    ).toBe(true);
    for (const source of ["LLM", "imported", "", null]) {
      expect(
        ListChunkKeywordsResponseSchema.safeParse({ keywords: [{ ...LINK, source }] }).success,
      ).toBe(false);
    }
  });

  it("requires the link's own timestamp, which is not the keyword's", () => {
    const { attachedAt: _omitted, ...without } = LINK;
    const result = ListChunkKeywordsResponseSchema.safeParse({ keywords: [without] });
    expect(result.success).toBe(false);
    expect(result.success ? [] : result.error.issues[0]!.path).toEqual([
      "keywords",
      0,
      "attachedAt",
    ]);
  });
});

describe("AttachBlobMultipartFieldsSchema", () => {
  it("has exactly the two things a caller can say about bytes already owned", () => {
    // Neither field is required — the file part declares both — and there is no
    // `documentId`, no `tags`, no `metadata` and no `includedInKb`, because the
    // row this attaches to exists already and the attach does not touch it.
    expect(AttachBlobMultipartFieldsSchema.parse({})).toEqual({});
    expect(
      AttachBlobMultipartFieldsSchema.parse({ filename: "handbook.md", mimeType: "text/markdown" }),
    ).toEqual({ filename: "handbook.md", mimeType: "text/markdown" });

    const extras = AttachBlobMultipartFieldsSchema.parse({
      filename: "handbook.md",
      documentId: "d_1",
      includedInKb: "true",
      tag1: "handbook",
    });
    expect(Object.keys(extras)).toEqual(["filename"]);
  });

  it("refuses an empty name or media type rather than storing under one", () => {
    expect(AttachBlobMultipartFieldsSchema.safeParse({ filename: "" }).success).toBe(false);
    expect(AttachBlobMultipartFieldsSchema.safeParse({ mimeType: "" }).success).toBe(false);
    expect(AttachBlobMultipartFieldsSchema.safeParse({ filename: 7 }).success).toBe(false);
  });
});

describe("WhoamiSchema", () => {
  const WHOAMI = {
    clientId: "pc_1",
    label: "actanastudio",
    scopes: ["read", "write"] as const,
    createdAt: "2026-09-15T00:00:00.000Z",
    serialNumber: "0a1b2c",
    schemaVersion: 2,
  };

  it("names the paired client id, the scopes it holds and the schema version", () => {
    expect(WhoamiSchema.parse(WHOAMI)).toEqual(WHOAMI);
  });

  it("makes `serialNumber` the only optional field — the insecure path has none", () => {
    const { serialNumber: _omitted, ...withoutSerial } = WHOAMI;
    expect(WhoamiSchema.parse(withoutSerial).serialNumber).toBeUndefined();

    // Everything else is a fact the row always carries, so leaving one out is a
    // body that does not satisfy the contract rather than a partial answer.
    for (const field of ["clientId", "label", "scopes", "createdAt", "schemaVersion"] as const) {
      const { [field]: _dropped, ...without } = WHOAMI;
      const result = WhoamiSchema.safeParse(without);
      expect(result.success, field).toBe(false);
      expect(result.success ? [] : result.error.issues[0]!.path).toEqual([field]);
    }
  });

  it("takes `scopes` as a list of the three scopes and nothing else", () => {
    expect(SEARCH_SCOPES).toEqual(["read", "write", "admin"]);
    expect(WhoamiSchema.parse({ ...WHOAMI, scopes: [...SEARCH_SCOPES] }).scopes).toEqual([
      "read",
      "write",
      "admin",
    ]);
    // A single string is not a list of one: `scope` is `/v1/pair/status`.
    expect(WhoamiSchema.safeParse({ ...WHOAMI, scopes: "admin" }).success).toBe(false);
    expect(WhoamiSchema.safeParse({ ...WHOAMI, scopes: ["owner"] }).success).toBe(false);
  });

  it("takes `schemaVersion` as an integer, as capabilities reports it", () => {
    expect(WhoamiSchema.safeParse({ ...WHOAMI, schemaVersion: 2.5 }).success).toBe(false);
    expect(WhoamiSchema.safeParse({ ...WHOAMI, schemaVersion: "2" }).success).toBe(false);
  });
});
