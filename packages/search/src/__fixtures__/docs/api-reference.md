# REST API Reference

The platform REST API is served from `https://api.example.invalid/v1`. Every
response is JSON. Every request must be authenticated.

## Authentication

Send an API key in the `X-API-Key` header. Keys are created per workspace and
carry the permissions of the role they were minted with. A key is shown once at
creation and is never retrievable afterwards.

A request with no key, an unknown key, or a revoked key returns `401` with
`{"error":"unauthorized"}`. A request with a valid key that lacks the required
permission returns `403` with the required permission named in the body.

## Rate limits

Rate limits are applied per API key using a sliding window of sixty seconds.
The default limit is six hundred requests per minute for read endpoints and
sixty requests per minute for write endpoints. Search endpoints have their own
limit of one hundred and twenty requests per minute because each request may
fan out to several vector queries.

Every response carries `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and
`X-RateLimit-Reset`. Exceeding the limit returns `429` with a `Retry-After`
header in seconds. Clients should back off exponentially with jitter; retrying
immediately on a `429` will extend the penalty window.

Bulk endpoints count as one request regardless of how many items are in the
payload, which is the cheapest way to stay inside the limit.

## Pagination

List endpoints return at most fifty items by default and two hundred at most.
Pass `limit` to change the page size and `cursor` to continue. A response with
more pages available includes `next_cursor`; the absence of that field is the
only reliable signal that a listing is complete. Do not compute the number of
pages from a total count — totals are approximate on large collections.

## Errors

Errors use standard status codes and a consistent body: `error` holds a stable
machine-readable code, `message` holds a human sentence, and `details` holds a
field-by-field breakdown for validation failures. Never parse `message`; it is
allowed to change.

A `409` means a conflicting write happened between your read and your write.
Re-read the resource and retry. A `422` means the payload was well formed but
semantically invalid, for example a chunk size larger than the model's context
window.

## Idempotency

Write endpoints accept an `Idempotency-Key` header. A repeated request with the
same key within twenty-four hours returns the original response rather than
performing the write again. Use a fresh key per logical operation, not per
retry.

## Webhooks

Webhook deliveries are signed with a shared secret over the raw request body
using HMAC with SHA-256; the signature is in the `X-Signature` header alongside
a timestamp. Reject a delivery whose timestamp is more than five minutes old to
prevent replay. Deliveries are retried with exponential backoff for up to
twenty-four hours, so consumers must be idempotent on the event identifier.
