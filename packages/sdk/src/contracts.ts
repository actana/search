/**
 * `@actana/search/contracts` — the wire, defined once.
 *
 * Every request body, response body, error body and event payload a Search
 * instance speaks is a zod schema in here. **The core validates with these
 * exact objects** (`packages/search/src/api/routes/*` imports them) and the
 * SDK's method signatures are `z.infer`red from them, so there is one
 * definition of a request and no way for the two halves to drift. ADR 0009 is
 * why.
 *
 * Each family is also its own module — `@actana/search/contracts/documents`,
 * `@actana/search/contracts/events`, … — for a caller that wants one of them.
 */

export * from "./contracts/common.ts";
export * from "./contracts/capabilities.ts";
export * from "./contracts/whoami.ts";
export * from "./contracts/kbs.ts";
export * from "./contracts/documents.ts";
export * from "./contracts/keywords.ts";
export * from "./contracts/clusters.ts";
export * from "./contracts/tags.ts";
export * from "./contracts/endpoints.ts";
export * from "./contracts/events.ts";
export * from "./contracts/webhooks.ts";
