/**
 * `@actana/search` — the typed client for a Search instance and the zod wire
 * schemas it speaks.
 *
 * The client and the schemas land in TASK-004 (routes and contracts) and
 * TASK-006 (mTLS pairing, copied from Control). The package exists from the
 * bootstrap because everything above the core is built on it and nothing above
 * the core is allowed to reach past it.
 */

/** The wire protocol version this SDK speaks. Reported by `GET /capabilities`. */
export const SEARCH_PROTOCOL_VERSION = 1;
