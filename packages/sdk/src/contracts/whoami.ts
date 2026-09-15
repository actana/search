/**
 * Who is calling.
 *
 * `GET /v1/capabilities` answers what the *instance* is and carries no client
 * id at all; `GET /v1/pair/status` does answer with one, but it is the pairing
 * surface's own shape (`@actana/search/pairing-wire`, copied out of Control with
 * ADR 0008) and it spells the id `id`, beside the pairing lifecycle's
 * `certNotAfter`, `platform` and `kbIds`. **`GET /v1/whoami` is the explicit
 * call**: a zod-contracted identity read, named the way a caller asks the
 * question, answering the two facts a caller has to hold before it writes
 * anything — *which* `search.paired_client` row this certificate is, and which
 * schema version the instance is on — in one request.
 *
 * It exists because Studio could not learn the first of those. A workspace's
 * `workspace_search` row holds an address, a CA fingerprint and a sealed
 * registration blob, and `SearchRegistrationBlob` carries no client id; the
 * sidecar's status route answers with the *Studio* row's id. So the data
 * migration (Studio's TASK-013) had to be handed `--paired-client-id` by an
 * operator, or guess it from `search.model_endpoint` rows — which only works
 * for a workspace that has pushed an endpoint. `whoami` is the answer to that
 * gap, and the id it returns is the one `search.knowledge_base.paired_client_id`
 * is written with.
 */

import { z } from "zod";
import { IsoDateTimeSchema } from "./common.ts";

/**
 * The scopes a pairing can hold, weakest first (ADR 0003).
 *
 * Deliberately coarse, and the order is the implication: `admin` implies
 * `write` implies `read`.
 */
export const SEARCH_SCOPES = ["read", "write", "admin"] as const;

export const SearchScopeSchema = z.enum(SEARCH_SCOPES);
export type SearchScope = z.infer<typeof SearchScopeSchema>;

export const WhoamiSchema = z.object({
  /**
   * The `search.paired_client.id` this connection's certificate resolves to.
   *
   * The same string `search.knowledge_base.paired_client_id` carries, which is
   * what makes it the id a migration writes rows with.
   */
  clientId: z.string(),
  /** The label the client chose at redemption ("actanastudio"). */
  label: z.string(),
  /**
   * Everything this client may do — **expanded**, not the single stored value.
   *
   * A client paired `admin` reads `["read", "write", "admin"]`. It is a list
   * for the same reason `CapabilitiesSchema.features` is: a caller tests
   * membership (`scopes.includes("write")`) rather than re-implementing the
   * rank the router enforces, and a caller that re-implemented it is a caller
   * that can disagree with the instance about what it is allowed to do.
   * `GET /v1/pair/status` still answers the stored value under `scope`.
   */
  scopes: z.array(SearchScopeSchema),
  /** When the pairing was redeemed — `paired_client.created_at`. */
  createdAt: IsoDateTimeSchema,
  /**
   * Hex serial of the client certificate presented **on this connection**.
   *
   * Off the socket rather than off the row, so it answers "which certificate
   * am I holding" and not merely "which certificate was this pairing issued".
   * Absent on the plain-HTTP development path (`SEARCH_DEV_INSECURE=1`), where
   * the caller is a header and there is no certificate to report — the same
   * reason `SearchPairStatus.certNotAfter` is nullable there.
   */
  serialNumber: z.string().optional(),
  /**
   * The instance's database schema version, as `GET /v1/capabilities` reports
   * it.
   *
   * Carried here so the identity read and the version precondition are one
   * round trip: a migration that must check both had to make two calls and
   * could observe them at two different instants.
   */
  schemaVersion: z.number().int(),
});
export type Whoami = z.infer<typeof WhoamiSchema>;
