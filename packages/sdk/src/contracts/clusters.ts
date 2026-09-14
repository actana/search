/**
 * Clusters: what was fitted, whether a fit is running, and how to ask for one.
 *
 * Centroids are **not** in the listing. A centroid is one float per embedding
 * dimension — 1536 of them for the usual model — and nothing above the service
 * has a use for the raw vector that a 2-D projection would not serve better.
 * `?includeCentroids=true` asks for them anyway, for the panel's PCA plot.
 */

import { z } from "zod";
import { NullableIsoDateTimeSchema } from "./common.ts";

export const ClusterSchema = z.object({
  /** The KMeans label, `0 … k-1`. Stable only within one fit. */
  clusterId: z.number().int(),
  size: z.number().int(),
  inertia: z.number().nullable(),
  centroid: z.array(z.number()).optional(),
});
export type Cluster = z.infer<typeof ClusterSchema>;

export const ListClustersQuerySchema = z.object({
  includeCentroids: z.enum(["true", "false"]).optional(),
});
export type ListClustersQuery = z.infer<typeof ListClustersQuerySchema>;

export const ListClustersResponseSchema = z.object({
  clusters: z.array(ClusterSchema),
  /** The KB's current `kmeans_k`. The fit may have chosen fewer. */
  k: z.number().int(),
  silhouette: z.number().nullable(),
  updatedAt: NullableIsoDateTimeSchema,
});
export type ListClustersResponse = z.infer<typeof ListClustersResponseSchema>;

/**
 * `GET /v1/kbs/:id/clustering-status`.
 *
 * `active` is the TTL-protected Redis flag the fit sets, so a crashed worker
 * clears itself rather than leaving a KB looking busy forever.
 */
export const ClusteringStatusSchema = z.object({
  active: z.boolean(),
  k: z.number().int(),
  silhouette: z.number().nullable(),
  updatedAt: NullableIsoDateTimeSchema,
  /** Rows in the partition, and how many of them carry a cluster assignment. */
  totalChunks: z.number().int(),
  clusteredChunks: z.number().int(),
  /** Fewer than this many chunks and no fit happens at all. */
  coldStartMinChunks: z.number().int(),
});
export type ClusteringStatus = z.infer<typeof ClusteringStatusSchema>;

/** `POST /v1/kbs/:id/recluster`. Enqueues a fit; does not wait for one. */
export const ReclusterResponseSchema = z.object({
  kbId: z.string(),
  enqueued: z.literal(true),
});
export type ReclusterResponse = z.infer<typeof ReclusterResponseSchema>;
