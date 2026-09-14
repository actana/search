/**
 * What this instance's build can do.
 *
 * The SDK reads it to decide whether it is newer than the instance it is
 * holding: `protocol` is the wire version, `schemaVersion` is the database's,
 * and `features` is the list a caller tests membership in rather than inferring
 * from a version number.
 */

import { z } from "zod";

/**
 * Every feature name an instance may advertise. Closed, so a caller that tests
 * for a misspelled one fails to compile rather than silently never matching.
 */
export const SEARCH_FEATURES = [
  /** `POST /v1/kbs/:id/query` with the blended keyword+semantic rank. */
  "hybrid",
  /** The same route with `mode: 'v1-tags'`: tag filter then vector search. */
  "v1-tags",
  /** KMeans over the KB's chunks, and the routes that read and re-fit it. */
  "clusters",
  /** The curated vocabulary and the inference extractor behind it. */
  "keywords",
  /** Signed, retried POSTs to a registered URL. */
  "webhooks",
  /** `GET /v1/events`. */
  "sse",
  /** `PUT /v1/endpoints` accepts `source.kind: 'mirrored'`. */
  "mirrored-endpoints",
] as const;

export const SearchFeatureSchema = z.enum(SEARCH_FEATURES);
export type SearchFeature = z.infer<typeof SearchFeatureSchema>;

export const CapabilitiesSchema = z.object({
  protocol: z.number().int(),
  schemaVersion: z.number().int(),
  features: z.array(SearchFeatureSchema),
  publicHost: z.string(),
});
export type Capabilities = z.infer<typeof CapabilitiesSchema>;
