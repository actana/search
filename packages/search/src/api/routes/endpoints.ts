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
 * the request's `workspaceId` are sealed into the row's `config` for the
 * `MirroredEndpointSource` to use per job, and stripped out of every read.
 *
 * ---
 *
 * **The six functions below are the registry, and they are deliberately named
 * after TASK-005's.** That ticket owns `models/endpoint-registry.ts` — the
 * process-wide source, the mirrored resolver and its TTL cache — and exports
 * `setEndpointSource(clientId, declaration)`, `upsertMirroredEndpoints(clientId,
 * inputs) → [{ id, externalId }]`, `createLocalEndpoint(clientId, input,
 * apiKey)`, `listEndpoints(clientId)`, `deleteEndpoint(clientId, id)` and
 * `getEndpointSourceSummary(clientId)`. These are the same names with the same
 * argument order over the same table, so when the two branches meet the change
 * is deleting this section and importing that module: the handler above it does
 * not move. They are written here rather than imported from there because that
 * file does not exist on this branch and a route that cannot store an endpoint
 * is a route the fixture suite cannot use.
 */

import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { PutEndpointsRequestSchema } from "@actana/search/contracts";
import type { Endpoint, EndpointDeclaration, EndpointSource } from "@actana/search/contracts";
import { generateId } from "@actana/search-shared/short-id";
import { db } from "../../db/client.ts";
import { knowledgeBase, modelEndpoint } from "../../db/schema.ts";
import { encryptSecret } from "../../core/security/encryption.ts";
import { validateExternalUrl } from "../../core/security/url-guard.ts";
import { badRequest, parseWith, readJsonBody, route, sendJson } from "../http.ts";
import type { SearchRouter } from "../routes.ts";
import { isoRequired } from "../serialize.ts";

/** The `config` key the mirrored resolver's address, bearer and scope sit under. */
export const RESOLVER_CONFIG_KEY = "__resolver";

/** The row shape a mirrored push declares. TASK-005's `MirroredEndpointInput`. */
export type MirroredEndpointInput = {
  externalId: string;
  kind: "embedding" | "inference";
  provider: string;
  template: string;
  model?: string;
  dimensions?: number;
  baseUrl?: string;
  label?: string;
  config?: Record<string, unknown>;
};

export function registerEndpointRoutes(router: SearchRouter): void {
  router.add(
    route("GET", "/v1/endpoints", "read", async ({ res, client }) => {
      sendJson(res, 200, {
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
       * written and for the same reason `resolverUrl` goes through it: that URL
       * is **fetched** — `models/embedding.ts` posts to it per batch — so an
       * admin-scoped client naming `https://169.254.169.254/` here would be
       * asking this process to read its own instance metadata and hand back
       * whatever came out as an embedding. Same dev allowance as the resolver's:
       * `SEARCH_ALLOW_LOCAL_FETCH` is what makes a loopback endpoint legal.
       */
      for (const declared of body.endpoints) {
        if (declared.baseUrl === undefined) continue;
        const verdict = validateExternalUrl(declared.baseUrl, "endpoints[].baseUrl");
        if (!verdict.isValid) {
          throw badRequest(verdict.error ?? "that endpoint base URL cannot be used");
        }
      }

      // The source next, so a bad resolver URL is refused before any endpoint
      // row is written against it.
      const declaration = await setEndpointSource(client!.id, body.source);

      const answered: Array<{ id: string; externalId: string }> = [];
      const mirrored: MirroredEndpointInput[] = [];
      for (const declared of body.endpoints) {
        if (body.source.kind === "mirrored") {
          if (declared.apiKey !== undefined) {
            throw badRequest(
              "a mirrored endpoint carries no key — Search resolves one per job and never " +
                "stores it",
            );
          }
          mirrored.push(inputFor(declared));
          continue;
        }
        answered.push(
          await createLocalEndpoint(client!.id, inputFor(declared), declared.apiKey ?? null),
        );
      }
      if (mirrored.length > 0) {
        answered.push(...(await upsertMirroredEndpoints(client!.id, mirrored, declaration)));
      }

      await removeUndeclared(
        client!.id,
        body.endpoints.map((e) => e.externalId),
      );
      sendJson(res, 200, { endpoints: answered });
    }),
  );
}

/** The contract's declaration, as the registry's input. */
function inputFor(declared: EndpointDeclaration): MirroredEndpointInput {
  return {
    externalId: declared.externalId,
    kind: declared.kind,
    provider: declared.provider,
    template: declared.template ?? declared.provider,
    ...(declared.model === undefined ? {} : { model: declared.model }),
    ...(declared.dimensions === undefined ? {} : { dimensions: declared.dimensions }),
    ...(declared.baseUrl === undefined ? {} : { baseUrl: declared.baseUrl }),
    ...(declared.label === undefined ? {} : { label: declared.label }),
    ...(declared.config === undefined ? {} : { config: declared.config }),
  };
}

// ─── The registry (TASK-005's surface, on this branch) ───────────────────────

/** What a mirrored push's resolver looks like once sealed, or `null` for local. */
type SealedResolver = { url: string; key: string; scope?: string } | null;

/**
 * Record where this client's keys come from, and refuse a resolver that cannot
 * be reached.
 *
 * The URL goes through the SSRF guard here, at registration, rather than only
 * at the first job: a resolver pointing at a private address is a mistake worth
 * reporting while somebody is watching.
 */
export async function setEndpointSource(
  _pairedClientId: string,
  source: EndpointSource,
): Promise<SealedResolver> {
  if (source.kind === "local") return null;
  const verdict = validateExternalUrl(source.resolverUrl, "source.resolverUrl");
  if (!verdict.isValid) throw badRequest(verdict.error ?? "that resolver URL cannot be used");
  return {
    url: source.resolverUrl,
    key: (await encryptSecret(source.resolverKey)).encrypted,
    ...(source.resolverScope === undefined ? {} : { scope: source.resolverScope }),
  };
}

/** Upsert a mirrored push, keyed by `externalId`. Never touches a key. */
export async function upsertMirroredEndpoints(
  pairedClientId: string,
  inputs: MirroredEndpointInput[],
  resolver: SealedResolver = null,
): Promise<Array<{ id: string; externalId: string }>> {
  const existing = await byExternalId(pairedClientId);
  const now = new Date();
  const answered: Array<{ id: string; externalId: string }> = [];

  for (const input of inputs) {
    const id = existing.get(input.externalId) ?? generateId();
    const config: Record<string, unknown> = { ...(input.config ?? {}) };
    if (resolver) config[RESOLVER_CONFIG_KEY] = resolver;
    const values = {
      kind: input.kind,
      provider: input.provider,
      template: input.template,
      model: input.model ?? null,
      dimension: input.dimensions ?? null,
      baseUrl: input.baseUrl ?? null,
      source: "mirrored",
      label: input.label ?? null,
      config,
      updatedAt: now,
    };
    if (existing.has(input.externalId)) {
      await db.update(modelEndpoint).set(values).where(eq(modelEndpoint.id, id));
    } else {
      await db.insert(modelEndpoint).values({
        id,
        pairedClientId,
        externalId: input.externalId,
        keyCiphertext: null,
        createdAt: now,
        ...values,
      });
    }
    answered.push({ id, externalId: input.externalId });
  }
  return answered;
}

/**
 * Create or update one locally-keyed endpoint.
 *
 * `apiKey` of `null` leaves whatever key the row already holds: a client that
 * pushes metadata on every edit and the key once must not blank it by saying
 * nothing about it.
 */
export async function createLocalEndpoint(
  pairedClientId: string,
  input: MirroredEndpointInput,
  apiKey: string | null,
): Promise<{ id: string; externalId: string }> {
  const existing = await byExternalId(pairedClientId);
  const id = existing.get(input.externalId) ?? generateId();
  const now = new Date();
  const sealed = apiKey === null ? null : (await encryptSecret(apiKey)).encrypted;
  const values = {
    kind: input.kind,
    provider: input.provider,
    template: input.template,
    model: input.model ?? null,
    dimension: input.dimensions ?? null,
    baseUrl: input.baseUrl ?? null,
    source: "local",
    label: input.label ?? null,
    config: (input.config ?? {}) as Record<string, unknown>,
    updatedAt: now,
  };
  if (existing.has(input.externalId)) {
    await db
      .update(modelEndpoint)
      .set({ ...values, ...(sealed === null ? {} : { keyCiphertext: sealed }) })
      .where(eq(modelEndpoint.id, id));
  } else {
    await db.insert(modelEndpoint).values({
      id,
      pairedClientId,
      externalId: input.externalId,
      keyCiphertext: sealed,
      createdAt: now,
      ...values,
    });
  }
  return { id, externalId: input.externalId };
}

/** Every endpoint row this client has. */
export async function listEndpoints(
  pairedClientId: string,
): Promise<Array<typeof modelEndpoint.$inferSelect>> {
  return db
    .select()
    .from(modelEndpoint)
    .where(eq(modelEndpoint.pairedClientId, pairedClientId));
}

/** Drop one endpoint. */
export async function deleteEndpoint(pairedClientId: string, id: string): Promise<boolean> {
  const gone = await db
    .delete(modelEndpoint)
    .where(and(eq(modelEndpoint.id, id), eq(modelEndpoint.pairedClientId, pairedClientId)))
    .returning({ id: modelEndpoint.id });
  return gone.length > 0;
}

/** Which source this client's endpoints came from. `local` when it has none. */
export async function getEndpointSourceSummary(
  pairedClientId: string,
): Promise<"local" | "mirrored"> {
  const rows = await db
    .select({ source: modelEndpoint.source })
    .from(modelEndpoint)
    .where(eq(modelEndpoint.pairedClientId, pairedClientId));
  return rows.some((r) => r.source === "mirrored") ? "mirrored" : "local";
}

// ─── Reconciliation and serialisation ───────────────────────────────────────

/** This client's endpoints, indexed by the id the client knows them by. */
async function byExternalId(pairedClientId: string): Promise<Map<string, string>> {
  const rows = await db
    .select({ id: modelEndpoint.id, externalId: modelEndpoint.externalId })
    .from(modelEndpoint)
    .where(
      and(eq(modelEndpoint.pairedClientId, pairedClientId), isNotNull(modelEndpoint.externalId)),
    );
  return new Map(rows.map((row) => [row.externalId!, row.id]));
}

/**
 * Drop the endpoints this client used to declare and no longer does — except
 * the ones a knowledge base is bound to, which stay.
 */
async function removeUndeclared(pairedClientId: string, declared: string[]): Promise<void> {
  const bound = await db
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
  const removable = [...(await byExternalId(pairedClientId))]
    .filter(([externalId, id]) => !wanted.has(externalId) && !inUse.has(id))
    .map(([, id]) => id);
  if (removable.length === 0) return;
  await db.delete(modelEndpoint).where(inArray(modelEndpoint.id, removable));
}

function endpointToWire(row: typeof modelEndpoint.$inferSelect): Endpoint {
  const config = { ...((row.config as Record<string, unknown> | null) ?? {}) };
  delete config[RESOLVER_CONFIG_KEY];
  return {
    id: row.id,
    externalId: row.externalId,
    kind: row.kind as Endpoint["kind"],
    provider: row.provider,
    template: row.template,
    model: row.model,
    dimensions: row.dimension,
    baseUrl: row.baseUrl,
    label: row.label,
    source: row.source as Endpoint["source"],
    hasKey: row.keyCiphertext !== null,
    config,
    createdAt: isoRequired(row.createdAt),
    updatedAt: isoRequired(row.updatedAt),
  };
}
