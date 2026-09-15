/**
 * `@actana/search` — the typed client for a Search instance and the wire it
 * speaks.
 *
 * Every entry point is also reachable as its own module (`@actana/search/client`,
 * `@actana/search/pairing`, …), which is the shape Control's SDK has and the
 * one the plan's snippet uses. This barrel exists for a caller that wants one
 * import; nothing in the package imports it.
 *
 * The zod contracts are `@actana/search/contracts` (and one module per family
 * beneath it). They are **not** re-exported here: they are three hundred
 * exported names, most of them schemas a given caller will never touch, and a
 * barrel that pulled them in would make `import { SearchClient } from
 * "@actana/search"` pay for all of them. Import the contracts by their own
 * path.
 */

/** The wire protocol version this SDK speaks. Reported by `GET /capabilities`. */
export const SEARCH_PROTOCOL_VERSION = 1;

export { SearchClient, DEFAULT_REQUEST_TIMEOUT_MS } from "./client.ts";
export type { SearchClientOptions, SearchRequestOptions } from "./client.ts";
export { SearchApiError } from "./errors.ts";
export {
  pairWithSearch,
  fetchSearchPairingIdentity,
  parsePairingTicket,
  parseSearchAddress,
  parseFingerprint,
  fingerprintOf,
  SearchPairingError,
  DEFAULT_PAIRING_TIMEOUT_MS,
} from "./pairing.ts";
export type {
  PairWithSearchOptions,
  SearchPairingFailure,
  SearchPairingErrorDetail,
  SearchPairingIdentity,
} from "./pairing.ts";
export {
  SEARCH_PAIRING_REDEEM_PATH,
  SEARCH_PAIRING_ROUTE_PREFIX,
} from "./pairing-wire.ts";
export type {
  SearchHealth,
  SearchPairStatus,
  SearchPairingClientInfo,
  SearchPairingRedeemRequest,
  SearchPairingRedeemResponse,
  SearchPairingRefusalBody,
} from "./pairing-wire.ts";
export {
  decodeRegistrationBlob,
  encodeRegistrationBlob,
  httpsBaseUrlFor,
  searchConnectionFromBlob,
} from "./registration-blob.ts";
export type {
  SearchConnection,
  SearchRegistrationBlob,
  SearchTlsMaterial,
} from "./registration-blob.ts";
export { generateClientCsr } from "./pairing-csr.ts";
export type { ClientCsr } from "./pairing-csr.ts";
