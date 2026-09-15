/**
 * `/v1/endpoints` — the model endpoint registry (ADR 0004).
 *
 * `PUT` is an upsert keyed by the declaring client's own `externalId`, which is
 * what makes Studio's push idempotent: it sends its workspace's endpoints on
 * pairing and again on every edit, and the same endpoint lands on the same row
 * every time. An endpoint left out of a later push is removed **only if no
 * knowledge base is bound to it** — dropping one that is would silently unbind
 * a KB and turn its next ingest into "no embedding endpoint configured", which
 * is a worse answer than a stale row.
 *
 * **No provider key is ever in a response.** A `local` declaration may carry
 * `apiKey`; it is sealed with `SEARCH_ENCRYPTION_KEY` and reported afterwards
 * as `hasKey: true` and nothing more. A `mirrored` one carries no key at all —
 * the resolver's URL, its bearer and the `resolverScope` Search echoes back as
 * the request's `workspaceId` go into `paired_client.endpoint_source` with the
 * credential sealed, and never come back out.
 *
 * ---
 *
 * **This file is a route and nothing else.** The registry lives in
 * `models/endpoint-registry.ts` (TASK-005): the process-wide source, the
 * mirrored resolver and its TTL cache, the SSRF guard at declaration, the cache
 * invalidation. What is left here is the three things a route owes a caller and
 * a module underneath it must not know about — validating the body against the
 * contract, reconciling the *declared set* against what the client used to
 * declare, and turning the registry's refusals into status codes.
 */

import { and, eq, inArray } from "drizzle-orm";
import { PutEndpointsRequestSchema } from "@actana/search/contracts";
import type {
  Endpoint,
  EndpointDeclaration,
  PutEndpointsRequest,
} from "@actana/search/contracts";
import { db, type SearchExecutor } from "../../db/client.ts";
import { knowledgeBase, modelEndpoint } from "../../db/schema.ts";
import { validateExternalUrl } from "../../core/security/url-guard.ts";
import {
  createLocalEndpoint,
  getEndpointSourceSummary,
  invalidateEndpointKeyCache,
  listEndpoints,
  setEndpointSource,
  upsertMirroredEndpoints,
  type EndpointSummary,
  type LocalEndpointInput,
  type MirroredEndpointInput,
} from "../../models/endpoint-registry.ts";
import { readApiKeyEndpointId } from "../../models/endpoint-api-key.ts";
import { badRequest, parseWith, readJsonBody, route, sendJson } from "../http.ts";
import type { SearchRouter } from "../routes.ts";

export function registerEndpointRoutes(router: SearchRouter): void {
  router.add(
    route("GET", "/v1/endpoints", "read", async ({ res, client }) => {
      sendJson(res, 200, {
        // The *declaration*, which is what the client told this instance, and
        // not a guess derived from the rows: a client that has declared a
        // resolver and pushed nothing yet is `mirrored`, and reading it off the
        // rows would have called it `local`.
        source: await getEndpointSourceSummary(client!.id),
        endpoints: (await listEndpoints(client!.id)).map(endpointToWire),
      });
    }),
  );

  router.add(
    route("PUT", "/v1/endpoints", "admin", async ({ req, res, client }) => {
      const body = parseWith(PutEndpointsRequestSchema, await readJsonBody(req));

      /**
       * Every declared `baseUrl` through the SSRF guard, before anything is
       * written.
       *
       * `resolverUrl` is guarded inside the registry (`sealDeclaration`), which
       * is the right place for it — it is that module that dials it. A declared
       * `baseUrl` is guarded *here* because it is the route that accepts it and
       * the registry never calls it: `models/embedding.ts` posts to it per
       * batch, so an admin-scoped client naming `https://169.254.169.254/` here
       * would be asking this process to read its own instance metadata and hand
       * back whatever came out as an embedding. Same dev allowance as the
       * resolver's: `SEARCH_ALLOW_LOCAL_FETCH` is what makes a loopback
       * endpoint legal.
       */
      for (const declared of body.endpoints) {
        if (declared.baseUrl === undefined) continue;
        const verdict = validateExternalUrl(declared.baseUrl, "endpoints[].baseUrl");
        if (!verdict.isValid) {
          throw badRequest(verdict.error ?? "that endpoint base URL cannot be used");
        }
      }

      sendJson(res, 200, { endpoints: await applyEndpointDeclaration(client!.id, body) });
    }),
  );
}

/**
 * Apply one `PUT /v1/endpoints` body: the source, the endpoints, and the
 * reconciliation of what is no longer declared — **all of it or none of it**.
 *
 * It used to be neither. `setEndpointSource` committed on its own, then each
 * endpoint committed on its own, then the reconciliation ran; so a body whose
 * fourth endpoint was refused (an embedding endpoint with no dimension, a
 * provider the catalog does not know) left a client with a *new* source
 * declaration, three of its endpoints written, the rest missing and the
 * previous set still there — a half-applied declaration that no retry of the
 * same body would have produced. One transaction: a refusal on row N leaves
 * exactly what was there before.
 *
 * Exported because it is the unit worth testing against a real Postgres — the
 * atomicity *is* the database — and a route handler needs a request to be
 * called at all.
 */
export async function applyEndpointDeclaration(
  clientId: string,
  body: PutEndpointsRequest,
): Promise<Array<{ id: string; externalId: string }>> {
  const answered = await db.transaction(async (tx) => {
    // The source first, so a bad resolver URL is refused before any endpoint
    // row is written against it. The declaration is stored on the paired
    // client, so nothing has to be threaded into the rows below.
    await asBadRequest(() => setEndpointSource(clientId, body.source, tx));

    /**
     * The endpoint ids this client may link a key to: its own, plus the ones
     * this request is creating.
     *
     * `config` is a `z.record(z.unknown())` on the wire and this route passes
     * it through, so `config.apiKeyEndpointId` was a free choice of *any*
     * endpoint id in the instance — and an id is a public value, answered by
     * this very route. Client B could therefore declare an endpoint keyed on
     * client A's, bind a KB to it and embed with A's sealed key.
     * `resolveEndpointApiKey` refuses that at the moment of use; this refuses
     * it at the moment it is declared, which is the message that reaches the
     * client that made the mistake.
     */
    const linkable = new Set((await listEndpoints(clientId, tx)).map((e) => e.id));

    const written: Array<{ id: string; externalId: string }> = [];
    const mirrored: MirroredEndpointInput[] = [];
    for (const declared of body.endpoints) {
      const linkedId = readApiKeyEndpointId(declared.config);
      if (linkedId !== null && !linkable.has(linkedId)) {
        throw badRequest(
          `config.apiKeyEndpointId "${linkedId}" is not one of your endpoints — a key can ` +
            "only be shared with an endpoint this client owns",
        );
      }
      if (body.source.kind === "mirrored") {
        if (declared.apiKey !== undefined) {
          throw badRequest(
            "a mirrored endpoint carries no key — Search resolves one per job and never " +
              "stores it",
          );
        }
        mirrored.push(mirroredInput(declared));
        continue;
      }
      const row = await asBadRequest(() =>
        createLocalEndpoint(clientId, localInput(declared), declared.apiKey ?? null, tx),
      );
      linkable.add(row.id);
      written.push({ id: row.id, externalId: declared.externalId });
    }
    if (mirrored.length > 0) {
      written.push(...(await asBadRequest(() => upsertMirroredEndpoints(clientId, mirrored, tx))));
    }

    await removeUndeclared(
      clientId,
      body.endpoints.map((e) => e.externalId),
      tx,
    );
    return written;
  });

  /**
   * After the commit, not during it.
   *
   * The registry's writes defer the invalidation when they are handed a
   * transaction: dropping this client's resolved keys before a commit that may
   * still roll back would forget keys that are still current and re-read them
   * under a declaration that is about to be undone.
   */
  invalidateEndpointKeyCache(clientId);
  return answered;
}

/**
 * The registry's refusals, as the status code they are.
 *
 * `models/endpoint-registry.ts` throws plain `Error`s — "a mirrored source
 * needs a resolverUrl", "an embedding endpoint needs a dimension", the SSRF
 * guard's verdict — because it is also reached from the CLI and from a job,
 * where an HTTP status means nothing. Left untranslated, every one of them
 * reached the router's catch-all and was answered `500 core-error` with an
 * error id, which tells a client that named a private resolver address that
 * *Search* is broken. They are all statements about the request, so they are
 * all `400`.
 */
async function asBadRequest<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    // A refusal the router already knows how to answer — `badRequest` and its
    // siblings — is left exactly as it is.
    if (err instanceof Error && "status" in err) throw err;
    throw badRequest(err instanceof Error ? err.message : "that endpoint cannot be registered");
  }
}

/** The contract's declaration, as a mirrored push's input. */
function mirroredInput(declared: EndpointDeclaration): MirroredEndpointInput {
  return {
    externalId: declared.externalId,
    kind: declared.kind,
    provider: declared.provider,
    template: declared.template ?? declared.provider,
    model: declared.model,
    ...(declared.dimensions === undefined ? {} : { dimensions: declared.dimensions }),
    ...(declared.baseUrl === undefined ? {} : { baseUrl: declared.baseUrl }),
    label: declared.label,
    ...(declared.config === undefined ? {} : { config: declared.config }),
  };
}

/** The same declaration, as a local one's. Carries the reconciliation key. */
function localInput(declared: EndpointDeclaration): LocalEndpointInput {
  return {
    externalId: declared.externalId,
    kind: declared.kind,
    provider: declared.provider,
    template: declared.template ?? declared.provider,
    model: declared.model,
    ...(declared.dimensions === undefined ? {} : { dimensions: declared.dimensions }),
    ...(declared.baseUrl === undefined ? {} : { baseUrl: declared.baseUrl }),
    label: declared.label,
    ...(declared.config === undefined ? {} : { config: declared.config }),
  };
}

// ─── Reconciliation and serialisation ───────────────────────────────────────

/**
 * Drop the endpoints this client used to declare and no longer does — except
 * the ones a knowledge base is bound to, which stay.
 *
 * This is the route's job rather than the registry's, because it is a property
 * of `PUT` being *declarative*: the registry's job is to write one endpoint, and
 * the request's is to say what the whole set is.
 */
async function removeUndeclared(
  pairedClientId: string,
  declared: string[],
  executor: SearchExecutor = db,
): Promise<void> {
  const bound = await executor
    .select({
      embeddingEndpointId: knowledgeBase.embeddingEndpointId,
      inferenceEndpointId: knowledgeBase.inferenceEndpointId,
    })
    .from(knowledgeBase)
    .where(eq(knowledgeBase.pairedClientId, pairedClientId));
  const inUse = new Set(
    bound.flatMap((row) =>
      [row.embeddingEndpointId, row.inferenceEndpointId].filter(
        (id): id is string => id !== null,
      ),
    ),
  );

  const wanted = new Set(declared);
  const removable = (await listEndpoints(pairedClientId, executor))
    // A row with no `externalId` was not declared through this route at all —
    // the admin socket's path, and anything a migration left — so it is not
    // this route's to reap.
    .filter(
      (row) =>
        row.externalId !== null && !wanted.has(row.externalId) && !inUse.has(row.id),
    )
    .map((row) => row.id);
  if (removable.length === 0) return;
  await executor
    .delete(modelEndpoint)
    .where(
      and(
        eq(modelEndpoint.pairedClientId, pairedClientId),
        inArray(modelEndpoint.id, removable),
      ),
    );
}

function endpointToWire(row: EndpointSummary): Endpoint {
  return {
    id: row.id,
    externalId: row.externalId,
    kind: row.kind,
    provider: row.provider,
    template: row.template,
    model: row.model,
    dimensions: row.dimensions,
    baseUrl: row.baseUrl,
    label: row.label,
    source: row.source,
    hasKey: row.hasKey,
    config: row.config,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
