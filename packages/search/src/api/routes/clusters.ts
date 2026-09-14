/**
 * `/v1/kbs/:kbId/clusters` — what the last KMeans fit produced, whether one is
 * running, and how to ask for another.
 *
 * `POST …/recluster` enqueues; it does not fit. A fit reads every vector in the
 * partition and rewrites every `cluster_id`, which is not work to do on a
 * request thread, and the job is idempotent under the KB's clustering flag so
 * asking twice costs nothing.
 */

import { asc, eq, sql } from "drizzle-orm";
import { ListClustersQuerySchema } from "@actana/search/contracts";
import { db } from "../../db/client.ts";
import { kbCluster } from "../../db/schema.ts";
import { clustersValidateJobName } from "../../kb/jobs/clusters-validate.ts";
import { isKbClusteringActive } from "../../kb/locks.ts";
import { kbPartitionRef, partitionExists } from "../../kb/partition.ts";
import { getJobQueue } from "../../queue/index.ts";
import { parseWith, queryOf, route, sendJson } from "../http.ts";
import { requireKb } from "../ownership.ts";
import type { SearchRouter } from "../routes.ts";
import { iso } from "../serialize.ts";

/** Below this many chunks no fit happens at all. Mirrors `clustering-trigger.ts`. */
const COLD_START_MIN_CHUNKS = 50;

export function registerClusterRoutes(router: SearchRouter): void {
  router.add(
    route("GET", "/v1/kbs/:kbId/clusters", "read", async ({ res, client, url }, { kbId }) => {
      const kb = await requireKb(client, kbId!);
      const query = parseWith(ListClustersQuerySchema, queryOf(url));
      const withCentroids = query.includeCentroids === "true";
      const rows = await db
        .select()
        .from(kbCluster)
        .where(eq(kbCluster.kbId, kbId!))
        .orderBy(asc(kbCluster.clusterId));
      sendJson(res, 200, {
        clusters: rows.map((row) => ({
          clusterId: row.clusterId,
          size: row.size,
          inertia: row.inertia,
          ...(withCentroids ? { centroid: row.centroid as number[] } : {}),
        })),
        k: kb.kmeansK,
        silhouette: kb.kmeansSilhouette,
        updatedAt: iso(kb.kmeansUpdatedAt),
      });
    }),
  );

  router.add(
    route(
      "GET",
      "/v1/kbs/:kbId/clustering-status",
      "read",
      async ({ res, client }, { kbId }) => {
        const kb = await requireKb(client, kbId!);
        const counts = await partitionCounts(kbId!);
        sendJson(res, 200, {
          active: await isKbClusteringActive(kbId!),
          k: kb.kmeansK,
          silhouette: kb.kmeansSilhouette,
          updatedAt: iso(kb.kmeansUpdatedAt),
          totalChunks: counts.total,
          clusteredChunks: counts.clustered,
          coldStartMinChunks: COLD_START_MIN_CHUNKS,
        });
      },
    ),
  );

  router.add(
    route("POST", "/v1/kbs/:kbId/recluster", "write", async ({ res, client }, { kbId }) => {
      await requireKb(client, kbId!);
      const queue = await getJobQueue();
      await queue.enqueue(clustersValidateJobName, { kbId: kbId! });
      sendJson(res, 202, { kbId, enqueued: true });
    }),
  );
}

/** Rows in the KB's partition, and how many carry a cluster assignment. */
async function partitionCounts(kbId: string): Promise<{ total: number; clustered: number }> {
  if (!(await partitionExists(kbId))) return { total: 0, clustered: 0 };
  const table = kbPartitionRef(kbId);
  const result = (await db.execute(
    sql.raw(
      `SELECT count(*)::int AS total, count(cluster_id)::int AS clustered FROM ${table}`,
    ),
  )) as { rows?: Array<{ total: number; clustered: number }> } | Array<{ total: number; clustered: number }>;
  const rows = Array.isArray(result) ? result : (result.rows ?? []);
  return { total: Number(rows[0]?.total ?? 0), clustered: Number(rows[0]?.clustered ?? 0) };
}
