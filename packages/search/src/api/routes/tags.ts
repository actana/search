/**
 * `/v1/kbs/:kbId/tag-definitions` — the names a KB gives its seventeen slots.
 *
 * `PUT` is the bulk create-or-update Studio's UI drives: a definition carrying
 * `originalDisplayName` is a rename, and a rename rewrites the value on every
 * document and chunk that carried it, which is why it is one call rather than a
 * delete and a create.
 */

import { NextAvailableSlotQuerySchema, PutTagDefinitionsRequestSchema } from "@actana/search/contracts";
import type { TagDefinition } from "@actana/search/contracts";
import { generateShortId } from "@actana/search-shared/short-id";
import {
  deleteTagDefinition,
  getDocumentTagDefinitions,
  getNextAvailableSlot,
  getTagUsage,
  createOrUpdateTagDefinitionsBulk,
} from "../../knowledge/tags/service.ts";
import type { DocumentTagDefinition } from "../../knowledge/tags/types.ts";
import { notFound, parseWith, queryOf, readJsonBody, route, sendJson } from "../http.ts";
import { requireKb } from "../ownership.ts";
import type { SearchRouter } from "../routes.ts";
import { isoRequired } from "../serialize.ts";

const requestId = (): string => `rest-${generateShortId(8)}`;

const definitionToWire = (def: DocumentTagDefinition): TagDefinition => ({
  id: def.id,
  knowledgeBaseId: def.knowledgeBaseId,
  tagSlot: def.tagSlot,
  displayName: def.displayName,
  fieldType: def.fieldType,
  createdAt: isoRequired(def.createdAt),
  updatedAt: isoRequired(def.updatedAt),
});

export function registerTagRoutes(router: SearchRouter): void {
  router.add(
    route("GET", "/v1/kbs/:kbId/tag-definitions", "read", async ({ res, client }, { kbId }) => {
      await requireKb(client, kbId!);
      const definitions = await getDocumentTagDefinitions(kbId!);
      sendJson(res, 200, { definitions: definitions.map(definitionToWire) });
    }),
  );

  router.add(
    route(
      "PUT",
      "/v1/kbs/:kbId/tag-definitions",
      "write",
      async ({ req, res, client }, { kbId }) => {
        await requireKb(client, kbId!);
        const body = parseWith(PutTagDefinitionsRequestSchema, await readJsonBody(req));
        const result = await createOrUpdateTagDefinitionsBulk(kbId!, body, requestId());
        sendJson(res, 200, {
          created: result.created.map(definitionToWire),
          updated: result.updated.map(definitionToWire),
          errors: result.errors,
        });
      },
    ),
  );

  router.add(
    route(
      "DELETE",
      "/v1/kbs/:kbId/tag-definitions/:tagId",
      "write",
      async ({ res, client }, { kbId, tagId }) => {
        await requireKb(client, kbId!);
        try {
          await deleteTagDefinition(kbId!, tagId!, requestId());
        } catch (err) {
          if (err instanceof Error && /not found/i.test(err.message)) {
            throw notFound(`no tag definition ${tagId} in ${kbId}`);
          }
          throw err;
        }
        sendJson(res, 200, { id: tagId, deleted: true });
      },
    ),
  );

  router.add(
    route("GET", "/v1/kbs/:kbId/tag-usage", "read", async ({ res, client }, { kbId }) => {
      await requireKb(client, kbId!);
      sendJson(res, 200, { usage: await getTagUsage(kbId!, requestId()) });
    }),
  );

  router.add(
    route(
      "GET",
      "/v1/kbs/:kbId/next-available-slot",
      "read",
      async ({ res, client, url }, { kbId }) => {
        await requireKb(client, kbId!);
        const query = parseWith(NextAvailableSlotQuerySchema, queryOf(url));
        sendJson(res, 200, {
          fieldType: query.fieldType,
          tagSlot: await getNextAvailableSlot(kbId!, query.fieldType),
        });
      },
    ),
  );
}
