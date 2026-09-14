# Blob storage and the queue are Search's own

Search writes uploaded documents into an S3-compatible bucket it owns, and runs
its ingestion fan-out on a BullMQ queue it owns under the prefix `search`. A
client never writes to Search's bucket and never enqueues onto Search's queue:
bytes arrive through the ingest route, and the work that follows is Search's to
schedule.

The two are the same decision. Ingestion is asynchronous, resumable and
long-running, and the thing that owns the work must own both the durable input
it reads and the queue it recovers through. Split them — a client's bucket, or a
client's queue — and a retry two hours later depends on a credential and a
lifecycle policy belonging to someone else.

Standalone, Search owns all three of Postgres, Redis and the bucket outright.
Wired to a client that already runs Postgres and Redis, it receives credentials
for the same servers and a **bucket of its own**, which is why the queue carries
a prefix: two engines, one Redis, no collision.

## Considered Options

- **Keep the blobs in the client's bucket and pass a URL (rejected).** No byte
  copy at ingest, and Search's ability to re-parse a document then depends on a
  presigned URL that expires, a bucket policy it does not control, and an object
  the client may lifecycle away under it. `file_url` pointing into Search's own
  bucket is what makes a re-ingest a local operation.
- **Share the client's queue (rejected).** Cheaper to operate and it puts
  Search's retries, concurrency and failure handling under someone else's
  worker configuration. A stuck Search job would be a stuck client job.
- **No object storage — blobs in Postgres (rejected).** One fewer service to
  run, and it puts multi-megabyte documents in the row store beside the vectors,
  which is the fastest way to make the database the bottleneck for both.
- **No queue — ingest synchronously in the request (rejected).** It is fine
  until the first large document, and it makes the resumable embed ledger
  pointless.

## Consequences

- Search's configuration carries its own storage and queue settings —
  `SEARCH_S3_*`, `SEARCH_REDIS_URL` — and its bucket is separate even when the
  servers are shared.
- Uploads go through the ingest route, multipart or JSON text. There is no
  second path that writes a blob.
- Completion is announced by signed webhooks (`document.ingested`,
  `document.failed`, `clusters.retrained`) to a URL the paired client
  registered. Search does not know what the other end does with it, and
  deliberately does not know what a workflow is.
- The client's own queue keeps serving its unpaired users until the retirement
  commit; the two run side by side without sharing a prefix.
- The phase-4 data migration has to move blobs as well as rows, and the fact
  that Search's bucket is separate is what makes that a copy rather than a
  re-owning.
