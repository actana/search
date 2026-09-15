/**
 * The model endpoint registry (ADR 0004).
 *
 * `PUT /v1/endpoints` declares the set, keyed by the client's own `externalId`:
 * the body says where keys come from and lists the endpoints this client wants
 * to exist, and the instance upserts each one. That is what makes the wired
 * mode work — Studio pushes its workspace's endpoints on pair and on every
 * edit, and the same endpoint lands on the same row every time with nobody
 * having to send a delete.
 *
 * An endpoint left out of a later push is removed **unless a knowledge base is
 * bound to it**, in which case it stays: dropping it would set that KB's
 * `embedding_endpoint_id` to NULL and turn its next ingest into "no embedding
 * endpoint configured", which is a worse answer than a stale row.
 *
 * **No key is ever in this body when `source.kind` is `mirrored`**, and none is
 * ever in a response. A `local` endpoint may carry `apiKey` on the way in; it
 * is sealed with `SEARCH_ENCRYPTION_KEY` and never comes back out.
 */

import { z } from "zod";
import { IsoDateTimeSchema } from "./common.ts";

export const EndpointKindSchema = z.enum(["embedding", "inference"]);
export type EndpointKind = z.infer<typeof EndpointKindSchema>;

/**
 * Where the keys for this client's endpoints live.
 *
 * `local` — sealed in `search.model_endpoint` under this instance's encryption
 * key. `mirrored` — held by the paired client; Search asks `resolverUrl` for
 * one per job, with `resolverKey` as the bearer and `resolverScope` echoed back
 * as the request's `workspaceId`, and never writes it down.
 */
export const EndpointSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("local") }),
  z.object({
    kind: z.literal("mirrored"),
    resolverUrl: z.string().url(),
    resolverKey: z.string().min(1),
    /**
     * An opaque string echoed **verbatim** as the `workspaceId` field of every
     * resolver request Search makes.
     *
     * It is the client's own name for whatever the keys belong to — Studio puts
     * its workspace id here — and Search neither parses it nor acts on it. It
     * is in the contract rather than inferred from the paired client's id
     * because Search does not know what a workspace is (ADR 0002) and must not
     * start guessing at one.
     */
    resolverScope: z.string().min(1).optional(),
  }),
]);
export type EndpointSource = z.infer<typeof EndpointSourceSchema>;

/** One endpoint as the client declares it. */
export const EndpointDeclarationSchema = z
  .object({
    /** The declaring client's own id for this endpoint. The reconciliation key. */
    externalId: z.string().min(1).max(200),
    kind: EndpointKindSchema,
    /** Catalog provider id — `openai`, `voyage`, `google`, `cohere`, … */
    provider: z.string().min(1).max(100),
    /** The request shape, as distinct from the provider. Defaults to `provider`. */
    template: z.string().min(1).max(100).optional(),
    model: z.string().min(1).max(200),
    /** Vector width. Required for `embedding`, refused for `inference`. */
    dimensions: z.number().int().positive().optional(),
    baseUrl: z.string().url().optional(),
    label: z.string().min(1).max(200),
    config: z.record(z.unknown()).optional(),
    /** Only meaningful with `source.kind: 'local'`. Sealed, never returned. */
    apiKey: z.string().min(1).optional(),
  })
  .refine((v) => (v.kind === "embedding") === (v.dimensions !== undefined), {
    message: "an embedding endpoint declares `dimensions` and an inference endpoint does not",
  });
export type EndpointDeclaration = z.infer<typeof EndpointDeclarationSchema>;

export const PutEndpointsRequestSchema = z.object({
  source: EndpointSourceSchema,
  endpoints: z.array(EndpointDeclarationSchema).max(256),
});
export type PutEndpointsRequest = z.infer<typeof PutEndpointsRequestSchema>;

/** Search's id for each endpoint, beside the id the client knows it by. */
export const PutEndpointsResponseSchema = z.object({
  endpoints: z.array(z.object({ id: z.string(), externalId: z.string() })),
});
export type PutEndpointsResponse = z.infer<typeof PutEndpointsResponseSchema>;

/** An endpoint as `GET /v1/endpoints` returns it. No key, ever. */
export const EndpointSchema = z.object({
  id: z.string(),
  externalId: z.string().nullable(),
  kind: EndpointKindSchema,
  provider: z.string(),
  template: z.string(),
  model: z.string().nullable(),
  dimensions: z.number().int().nullable(),
  baseUrl: z.string().nullable(),
  label: z.string().nullable(),
  source: z.enum(["local", "mirrored"]),
  /** Whether a key is held for this endpoint. Never the key. */
  hasKey: z.boolean(),
  config: z.record(z.unknown()),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type Endpoint = z.infer<typeof EndpointSchema>;

/**
 * Where this client's keys come from, as a **read**.
 *
 * The declaration the client last made, echoed back — not a key, sealed or
 * otherwise, and not a guess derived from the rows. It is the object rather
 * than a bare `'local' | 'mirrored'` for one concrete reason: `resolverScope`
 * is the field Search, Studio and the resolver all have to agree on (ADR 0010,
 * TASK-008), and a client that has just pushed a catalog needs to be able to
 * read back which scope its keys will be asked for under. `resolverUrl` comes
 * with it because it is the client's own URL and the pair is what identifies
 * the declaration; there is deliberately nothing here about the credential.
 */
export const EndpointSourceSummarySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("local") }),
  z.object({
    kind: z.literal("mirrored"),
    resolverUrl: z.string(),
    resolverScope: z.string().nullable(),
  }),
]);
export type EndpointSourceSummary = z.infer<typeof EndpointSourceSummarySchema>;

export const GetEndpointsResponseSchema = z.object({
  source: EndpointSourceSummarySchema,
  endpoints: z.array(EndpointSchema),
});
export type GetEndpointsResponse = z.infer<typeof GetEndpointsResponseSchema>;
