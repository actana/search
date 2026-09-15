/**
 * The KB mapper, and the defect it had.
 *
 * `POST /v1/kbs` wrote `embedding_endpoint_id` and answered
 * `embeddingEndpointId: null`, and so did `GET /v1/kbs`. The cause was not the
 * write: `createKnowledgeBase` returns an object it assembles by hand which
 * names none of Search's own columns, the lifted listing selects twelve columns
 * that do not include them, and `kbToWire` read them off that object with
 * `?? null`. A wired Studio reads KB shape from the instance, so a KB settings
 * page showed no embedding endpoint on a KB that had one.
 *
 * The fix is in the signature — the row is a required argument — so the tests
 * here are about the two shapes staying in their lanes: the counts come from
 * the lifted object, everything Search owns comes from the row.
 */
import { describe, expect, it } from "vitest";
import type { KnowledgeBaseWithCounts } from "../knowledge/types.ts";
import { kbToWire, type KbWireColumns } from "./serialize.ts";

const CREATED_AT = new Date("2026-09-01T10:00:00.000Z");

/**
 * What `createKnowledgeBase` hands back: counts, names, and **not one** of
 * Search's own columns. Copied field for field from its `return` statement,
 * because that is the input the defect came in through.
 */
function liftedCreateResult(
  overrides: Partial<KnowledgeBaseWithCounts> = {},
): KnowledgeBaseWithCounts {
  return {
    id: "kb_1",
    userId: "owner_1",
    name: "Handbook",
    description: null,
    tokenCount: 0,
    embeddingModel: "text-embedding-3-small",
    embeddingDimension: 1536,
    chunkingConfig: { maxSize: 1024, minSize: 1, overlap: 200 },
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    deletedAt: null,
    workspaceId: "pc_1",
    docCount: 0,
    connectorTypes: [],
    ...overrides,
  };
}

/** The row the routes read beside it. */
function row(overrides: Partial<KbWireColumns> = {}): KbWireColumns {
  return {
    language: "english",
    embeddingEndpointId: "me_embed",
    inferenceEndpointId: "me_infer",
    inferenceModelId: "gpt-4o-mini",
    kmeansK: 8,
    kmeansSilhouette: 0.42,
    kmeansUpdatedAt: new Date("2026-09-02T11:00:00.000Z"),
    ...overrides,
  };
}

describe("kbToWire", () => {
  /** The regression: the create path, with the shape the create actually returns. */
  it("reports the endpoint ids off the row, not off the lifted create result", () => {
    const wire = kbToWire(liftedCreateResult(), row());
    expect(wire.embeddingEndpointId).toBe("me_embed");
    expect(wire.inferenceEndpointId).toBe("me_infer");
    expect(wire.inferenceModelId).toBe("gpt-4o-mini");
  });

  it("reports the cluster configuration and the language off the row too", () => {
    const wire = kbToWire(liftedCreateResult(), row({ kmeansK: 12, language: "german" }));
    expect(wire.clusterCount).toBe(12);
    expect(wire.silhouette).toBe(0.42);
    expect(wire.clustersUpdatedAt).toBe("2026-09-02T11:00:00.000Z");
    expect(wire.language).toBe("german");
  });

  /**
   * The row is authoritative even when the lifted object *does* carry a value —
   * `getKnowledgeBaseById` selects these columns, and if the two ever disagreed
   * it would be because the row moved after the counts were read.
   */
  it("prefers the row when the lifted shape carries its own copy", () => {
    const wire = kbToWire(
      liftedCreateResult({ embeddingEndpointId: "stale", clusterCount: 99 }),
      row({ embeddingEndpointId: "me_fresh", kmeansK: 8 }),
    );
    expect(wire.embeddingEndpointId).toBe("me_fresh");
    expect(wire.clusterCount).toBe(8);
  });

  it("keeps a null column null rather than dropping the field", () => {
    const wire = kbToWire(
      liftedCreateResult(),
      row({
        embeddingEndpointId: null,
        inferenceEndpointId: null,
        inferenceModelId: null,
        kmeansSilhouette: null,
        kmeansUpdatedAt: null,
      }),
    );
    expect(wire.embeddingEndpointId).toBeNull();
    expect(wire.inferenceEndpointId).toBeNull();
    expect(wire.inferenceModelId).toBeNull();
    expect(wire.silhouette).toBeNull();
    expect(wire.clustersUpdatedAt).toBeNull();
  });

  /** The counts and the names are still the lifted object's to answer. */
  it("takes the counts and the timestamps from the lifted shape", () => {
    const wire = kbToWire(
      liftedCreateResult({ docCount: 3, tokenCount: 1200, name: "Runbooks" }),
      row(),
    );
    expect(wire).toMatchObject({
      id: "kb_1",
      name: "Runbooks",
      docCount: 3,
      tokenCount: 1200,
      workspaceId: "pc_1",
      createdAt: CREATED_AT.toISOString(),
      deletedAt: null,
    });
  });
});
