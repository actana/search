/**
 * The shape every route family on this instance's HTTP surface has, and the
 * hook TASK-004 fills.
 *
 * Copied in spirit from actana/control's `CoreHttpRoutes`: both methods answer
 * `true` when they took the request and `false` when the path is none of that
 * family's business, so the server keeps the 404 and the HTTP surface stays a
 * closed list rather than a catch-all.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { PairedClient } from "@actana/search-shared/pairing/pairing-code-digest";

/** One family of routes, as the server mounts it. */
export type SearchHttpRoutes = {
  handle(req: IncomingMessage, res: ServerResponse): boolean;
  handleContinue(req: IncomingMessage, res: ServerResponse): boolean;
};

/**
 * A request that got past the gate, with the client the certificate named.
 *
 * `client` is `null` only on an open route — nowhere else can a request reach a
 * handler without one, which is ADR 0003 stated as a type.
 */
export type SearchRequestContext = {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  client: PairedClient | null;
  /**
   * May this caller touch this KB?
   *
   * A paired client's grant is a scope **and optionally a list of KB ids** (ADR
   * 0003). The scope half is enforced by the router from {@link SearchRoute};
   * this is the other half, and it is on the context rather than only in the
   * router because a route that reads a KB id out of a *body* — an upsert, a
   * batch — cannot declare it in its path and has to ask.
   *
   * `false` for a KB outside the list, and `false` when there is no client at
   * all: an open route has no business asking, and the safe answer to a
   * question nobody should be asking is no.
   */
  allowsKb(kbId: string): boolean;
};

/**
 * A route registered on the explicit router: an exact method and pathname, or a
 * predicate for a family with parameters in its path.
 */
export type SearchRoute = {
  method: string;
  /** Exact pathname, or a predicate over one. */
  path: string | ((pathname: string) => boolean);
  /** The scope this route needs. `null` means any paired client will do. */
  scope?: "read" | "write" | "admin" | null;
  /**
   * The KB this route acts on, read out of its own URL — `/v1/kbs/:id/query`
   * yields the `:id`.
   *
   * **Declared here so the check cannot be forgotten in a handler.** The server
   * calls it before `handle` and answers `403 kb-forbidden` when the client's
   * grant does not cover what comes back, so a KB-scoped route added in
   * TASK-004 is enforced by the fact of being registered rather than by its
   * author remembering. A route that genuinely acts on no single KB returns
   * `null`; a route that finds its KB in the body checks
   * {@link SearchRequestContext.allowsKb} itself, which is why that exists too.
   */
  kbIdFrom?: (url: URL) => string | null;
  handle(ctx: SearchRequestContext): void | Promise<void>;
};

/**
 * Does this client's grant cover this KB?
 *
 * `kbIds` absent or empty means every KB the client owns — the same meaning the
 * column's NULL carries — and a list means exactly that list.
 */
export function clientAllowsKb(client: PairedClient | null, kbId: string): boolean {
  if (!client) return false;
  if (client.kbIds === null || client.kbIds.length === 0) return true;
  return client.kbIds.includes(kbId);
}

/**
 * What TASK-004 is handed.
 *
 * The API surface is registered rather than discovered: a route that is not
 * added here does not exist, which is the property that lets `server.ts` be
 * read end to end and the pre-auth hole be counted by eye.
 */
export interface SearchRouter {
  /** Add one route. The first registered match answers a request. */
  add(route: SearchRoute): void;
}
