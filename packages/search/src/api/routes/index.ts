/**
 * Every `/v1` route this instance serves, registered in one place.
 *
 * `server.ts` mounts pairing, health and capabilities itself and then calls
 * `registerRoutes`, which is this. The surface is a closed list on purpose:
 * a route that is not added here does not exist, which is the property that
 * lets the pre-auth hole be counted by eye.
 *
 * Order does not matter. `matchPath` compares segment counts first and then
 * every literal segment, so no two patterns here can match the same pathname —
 * `…/documents/upsert` is six segments and `…/documents/:docId/include` is
 * seven, and there is no `POST …/documents/:docId` for `upsert` to be mistaken
 * for.
 */

import type { SearchRouter } from "../routes.ts";
import { registerChunkRoutes } from "./chunks.ts";
import { registerClusterRoutes } from "./clusters.ts";
import { registerDocumentRoutes } from "./documents.ts";
import { registerEndpointRoutes } from "./endpoints.ts";
import { registerEventRoutes } from "./events.ts";
import { registerKbRoutes } from "./kbs.ts";
import { registerKeywordRoutes } from "./keywords.ts";
import { registerTagRoutes } from "./tags.ts";
import { registerWebhookRoutes } from "./webhooks.ts";

export function registerSearchRoutes(router: SearchRouter): void {
  registerKbRoutes(router);
  registerDocumentRoutes(router);
  registerChunkRoutes(router);
  registerKeywordRoutes(router);
  registerClusterRoutes(router);
  registerTagRoutes(router);
  registerEndpointRoutes(router);
  registerWebhookRoutes(router);
  registerEventRoutes(router);
}
