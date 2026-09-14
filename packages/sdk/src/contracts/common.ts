/**
 * The pieces every other contract is built from: the closed error vocabulary,
 * the shape a refusal arrives in, and the two scalar conventions the wire uses.
 *
 * **One definition** (ADR 0009). These schemas are the SDK's, the core
 * validates requests with exactly them, and the SDK's method signatures are
 * `z.infer`red from them rather than written twice. A field that is not here is
 * not on the wire.
 */

import { z } from "zod";

/**
 * Every `code` a Search instance will ever put in an error body.
 *
 * Closed on purpose: a caller switches on this and an instance that invents a
 * code is an instance a caller cannot handle. Two of them are produced by the
 * SDK rather than by the service — `unreachable` and `bad-endpoint` never
 * arrive over the wire because in both cases nothing arrived — and they are in
 * the same enum because a caller catching {@link SearchApiError} sees one list.
 */
export const SEARCH_ERROR_CODES = [
  /** The request was not readable at all: not JSON, not an object, no body. */
  "bad-request",
  /** The body parsed but did not satisfy the contract. `detail` carries the zod issues. */
  "validation-failed",
  /** A content type this route does not read. */
  "unsupported-media-type",
  /** The body, or the uploaded file, is over the cap. */
  "payload-too-large",
  /** No such route, or no such row *for this paired client*. See ADR 0009. */
  "not-found",
  /** The write would collide with a row that already exists — a duplicate KB name. */
  "conflict",
  /** The paired client's scope is below what this route needs. */
  "scope-forbidden",
  /** The paired client's pairing named a KB list and this KB is not on it. */
  "kb-forbidden",
  /** The admin surface's refusal of a browser-shaped request. */
  "forbidden",
  /** No client certificate, or one this instance has taken back. */
  "client-certificate-required",
  /** The route exists but this method does not. */
  "method-not-allowed",
  /** The pre-auth surface's single answer to every bad redemption. */
  "pairing-refused",
  /** Too many requests in the window. */
  "rate-limited",
  /** Declared, not built. */
  "not-implemented",
  /** The instance failed. `detail.errorId` is what a log search needs. */
  "core-error",
  /** SDK-side: the request never reached an instance. */
  "unreachable",
  /** SDK-side: the registration blob's endpoint is not an `https://` origin. */
  "bad-endpoint",
] as const;

export const SearchErrorCodeSchema = z.enum(SEARCH_ERROR_CODES);
export type SearchErrorCode = z.infer<typeof SearchErrorCodeSchema>;

/**
 * The body of every non-2xx answer.
 *
 * `message` is for a human reading a log; do not parse it. `detail` is
 * structured and route-specific — the zod issues for a `validation-failed`, an
 * error id for a `core-error`.
 *
 * `error` is the same string as `message`, and it is here because the pre-auth
 * pairing surface (copied from Control, ADR 0008) has spelled it that way since
 * before this contract existed. New code reads `message`.
 */
export const ErrorBodySchema = z.object({
  code: SearchErrorCodeSchema,
  message: z.string(),
  detail: z.unknown().optional(),
  /** Legacy alias for `message`, kept for the pairing surface. */
  error: z.string().optional(),
});
export type ErrorBody = z.infer<typeof ErrorBodySchema>;

/**
 * A timestamp on the wire is an ISO 8601 string, always — `JSON.stringify` of
 * a `Date` is exactly that, which is what the lifted service functions hand
 * back, so nothing has to remember to convert.
 *
 * Not `z.string().datetime()`: that rejects an offset other than `Z`, and the
 * point of validating here is to catch a missing field rather than to relitigate
 * a format Postgres and Node already agree on.
 */
export const IsoDateTimeSchema = z.string();

/** The `null`able version, which is most of them. */
export const NullableIsoDateTimeSchema = z.string().nullable();

/** Free-form metadata a caller attached. Stored and returned unread. */
export const MetadataSchema = z.record(z.unknown());

/** What a listing says about the rest of the list. */
export const PaginationSchema = z.object({
  total: z.number().int(),
  limit: z.number().int(),
  offset: z.number().int(),
  hasMore: z.boolean(),
});
export type Pagination = z.infer<typeof PaginationSchema>;

/** The seventeen typed tag slots, in the order `CONTEXT.md` names them. */
export const TEXT_TAG_SLOTS = ["tag1", "tag2", "tag3", "tag4", "tag5", "tag6", "tag7"] as const;
export const NUMBER_TAG_SLOTS = ["number1", "number2", "number3", "number4", "number5"] as const;
export const DATE_TAG_SLOTS = ["date1", "date2"] as const;
export const BOOLEAN_TAG_SLOTS = ["boolean1", "boolean2", "boolean3"] as const;
export const ALL_TAG_SLOTS = [
  ...TEXT_TAG_SLOTS,
  ...NUMBER_TAG_SLOTS,
  ...DATE_TAG_SLOTS,
  ...BOOLEAN_TAG_SLOTS,
] as const;

export const TagSlotSchema = z.enum(ALL_TAG_SLOTS);
export type TagSlot = z.infer<typeof TagSlotSchema>;

export const TagFieldTypeSchema = z.enum(["text", "number", "date", "boolean"]);
export type TagFieldType = z.infer<typeof TagFieldTypeSchema>;

/**
 * The tag columns as they come back on a document or a chunk: seven text, five
 * number, two date (ISO strings), three boolean. Every one nullable, because
 * every one is an unassigned slot until a KB names it.
 */
export const TagValuesSchema = z.object({
  tag1: z.string().nullable(),
  tag2: z.string().nullable(),
  tag3: z.string().nullable(),
  tag4: z.string().nullable(),
  tag5: z.string().nullable(),
  tag6: z.string().nullable(),
  tag7: z.string().nullable(),
  number1: z.number().nullable(),
  number2: z.number().nullable(),
  number3: z.number().nullable(),
  number4: z.number().nullable(),
  number5: z.number().nullable(),
  date1: NullableIsoDateTimeSchema,
  date2: NullableIsoDateTimeSchema,
  boolean1: z.boolean().nullable(),
  boolean2: z.boolean().nullable(),
  boolean3: z.boolean().nullable(),
});
export type TagValues = z.infer<typeof TagValuesSchema>;

/**
 * The tag values a caller may *send*. Strings throughout, because that is what
 * a multipart form can carry and what Studio's `updateDocument` has always
 * accepted; the service parses them into the column's type.
 */
export const TagWritesSchema = z
  .object({
    tag1: z.string(),
    tag2: z.string(),
    tag3: z.string(),
    tag4: z.string(),
    tag5: z.string(),
    tag6: z.string(),
    tag7: z.string(),
    number1: z.string(),
    number2: z.string(),
    number3: z.string(),
    number4: z.string(),
    number5: z.string(),
    date1: z.string(),
    date2: z.string(),
    boolean1: z.string(),
    boolean2: z.string(),
    boolean3: z.string(),
  })
  .partial();
export type TagWrites = z.infer<typeof TagWritesSchema>;

/** `{ ok: true }` — for a route whose whole answer is that it happened. */
export const OkSchema = z.object({ ok: z.literal(true) });
export type Ok = z.infer<typeof OkSchema>;
