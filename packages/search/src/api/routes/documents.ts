/**
 * `/v1/kbs/:kbId/documents` — getting bytes in, and reading back what became of
 * them.
 *
 * **Two encodings, two pipelines, and the split is not cosmetic.** A file
 * arrives as `multipart/form-data`, is stored in this instance's bucket, and is
 * handed to the resumable worker flow — parse, chunk, stage, fan out embed
 * batches, finalize, keyword. Text arrives as JSON and goes to
 * `ingestDocument`, the path the app-SDK and the runtime route have always
 * taken, which chunks and embeds in one pass and writes only the partition.
 * They produce measurably different corpora from the same bytes (the fixture
 * suite freezes both, and `src/__fixtures__/README.md` explains the one that
 * looks like a defect), so a route that quietly sent text through the file
 * pipeline would change what a Studio caller gets back.
 *
 * Both answer before the work is done. `{ documentId, processingStatus }` and
 * then poll `GET …/documents/:docId`, or listen on `GET /v1/events`.
 */

import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  BulkDocumentsRequestSchema,
  IngestJsonRequestSchema,
  IngestMultipartFieldsSchema,
  IncludeDocumentRequestSchema,
  ListDocumentsQuerySchema,
  MetadataSchema,
  UpdateDocumentRequestSchema,
  UpsertDocumentRequestSchema,
} from "@actana/search/contracts";
import type {
  IngestMultipartFields,
  IngestResponse,
  TagWrites,
  UpsertDocumentResponse,
} from "@actana/search/contracts";
import { generateId, generateShortId } from "@actana/search-shared/short-id";
import { db } from "../../db/client.ts";
import { document } from "../../db/schema.ts";
import { StorageService } from "../../blob/index.ts";
import { MAX_UPLOAD_SIZE_BYTES } from "../../blob/validation.ts";
import { stageIngestedDocument } from "../../kb/ingest.ts";
import { getJobQueue } from "../../queue/index.ts";
import type { KbIngestDocumentPayload } from "../../jobs/types.ts";
import {
  bulkDocumentOperation,
  bulkDocumentOperationByFilter,
  deleteDocument,
  getDocuments,
  updateDocument,
} from "../../knowledge/documents/service.ts";
import { parseBooleanValue, parseDateValue, parseNumberValue } from "../../knowledge/tags/utils.ts";
import {
  badRequest,
  conflict,
  HttpError,
  isMultipart,
  notFound,
  parseWith,
  queryOf,
  readJsonBody,
  readMultipartBody,
  route,
  sendJson,
} from "../http.ts";
import { requireDocument, requireKb } from "../ownership.ts";
import type { SearchRouter } from "../routes.ts";
import { documentToWire } from "../serialize.ts";

const requestId = (): string => `rest-${generateShortId(8)}`;

export function registerDocumentRoutes(router: SearchRouter): void {
  router.add(
    route("POST", "/v1/kbs/:kbId/documents", "write", async (ctx, { kbId }) => {
      await requireKb(ctx.client, kbId!);
      const answer = isMultipart(ctx.req)
        ? await ingestMultipart(ctx.req, kbId!)
        : await ingestJson(ctx.req, kbId!);
      sendJson(ctx.res, 202, answer);
    }),
  );

  router.add(
    route("POST", "/v1/kbs/:kbId/documents/upsert", "write", async (ctx, { kbId }) => {
      await requireKb(ctx.client, kbId!);
      const body = parseWith(UpsertDocumentRequestSchema, await readJsonBody(ctx.req));
      sendJson(ctx.res, 202, await upsert(kbId!, body));
    }),
  );

  router.add(
    /**
     * `POST /v1/kbs/:kbId/documents/bulk` — one request, many documents.
     *
     * Two forms, because the frozen service has two: a list of ids
     * (`bulkDocumentOperation`) and an `enabledFilter` over the whole KB
     * (`bulkDocumentOperationByFilter`). The contract permits exactly one of
     * them and nothing else, because nothing else exists behind it.
     *
     * **The route's own check is that every id is in this KB**, before a single
     * row is written. The frozen function is tolerant — it acts on the ids it
     * recognises and logs the rest — which for a wire is the wrong shape: a
     * caller that mistyped an id, or named another KB's document, would get a
     * `200` and a count it has to diff against what it asked for. So the
     * refusal is a `404` that names *none* of the ids: which of them is not
     * yours is not something to confirm (ADR 0009 D5).
     */
    route("POST", "/v1/kbs/:kbId/documents/bulk", "write", async (ctx, { kbId }) => {
      await requireKb(ctx.client, kbId!);
      const body = parseWith(BulkDocumentsRequestSchema, await readJsonBody(ctx.req));

      if (body.enabledFilter !== undefined) {
        const byFilter = await bulkDocumentOperationByFilter(
          kbId!,
          body.operation,
          body.enabledFilter,
          requestId(),
        );
        sendJson(ctx.res, 200, { affected: byFilter.successCount });
        return;
      }

      const ids = body.documentIds!;
      await requireEveryDocument(kbId!, ids);
      const result = await bulkDocumentOperation(kbId!, body.operation, ids, requestId());
      sendJson(ctx.res, 200, { affected: result.successCount });
    }),
  );

  router.add(
    route("GET", "/v1/kbs/:kbId/documents", "read", async ({ res, client, url }, { kbId }) => {
      await requireKb(client, kbId!);
      const query = parseWith(ListDocumentsQuerySchema, queryOf(url));
      /**
       * Handed over whole, `tagFilters` included: the lifted `getDocuments`
       * already takes `TagFilterCondition[]` under that name and the contract's
       * shape is that type field for field, so there is nothing here to map.
       * The parameter arrives JSON-encoded because a list of conditions cannot
       * be spelled `tag1=…` without losing the operator and the second bound —
       * `ListDocumentsQuerySchema` says so at length.
       */
      const listed = await getDocuments(kbId!, query, requestId());
      const rows = await rowsById(listed.documents.map((d) => d.id));
      sendJson(res, 200, {
        documents: listed.documents
          .map((d) => rows.get(d.id))
          .filter((row) => row !== undefined)
          .map(documentToWire),
        /**
         * `total` is a **number** on the wire, and it takes a cast to be one:
         * the lifted `getDocuments` hands `COUNT(*)` back as the string
         * Postgres sent, on every listing filtered or not, so passing
         * `pagination` straight through answered with a body that did not
         * satisfy the `PaginationSchema.total` (`z.number().int()`) this
         * route's own contract defines it by.
         *
         * Cast **here** rather than in the engine, which is frozen (ADR 0005),
         * and cast rather than widening the schema to `string | number`, which
         * would have made every caller do this instead. Turning a column into
         * the shape the wire promised is exactly this layer's job.
         */
        pagination: { ...listed.pagination, total: Number(listed.pagination.total) },
      });
    }),
  );

  router.add(
    route(
      "GET",
      "/v1/kbs/:kbId/documents/:docId",
      "read",
      async ({ res, client }, { kbId, docId }) => {
        await requireKb(client, kbId!);
        sendJson(res, 200, documentToWire(await requireDocument(kbId!, docId!)));
      },
    ),
  );

  router.add(
    route(
      "PATCH",
      "/v1/kbs/:kbId/documents/:docId",
      "write",
      async ({ req, res, client }, { kbId, docId }) => {
        await requireKb(client, kbId!);
        await requireDocument(kbId!, docId!);
        const body = parseWith(UpdateDocumentRequestSchema, await readJsonBody(req));
        if (Object.keys(body).length === 0) throw badRequest("the patch is empty");
        await updateDocument(docId!, body, requestId());
        sendJson(res, 200, documentToWire(await requireDocument(kbId!, docId!)));
      },
    ),
  );

  router.add(
    route(
      "DELETE",
      "/v1/kbs/:kbId/documents/:docId",
      "write",
      async ({ res, client }, { kbId, docId }) => {
        await requireKb(client, kbId!);
        await requireDocument(kbId!, docId!);
        await deleteDocument(docId!, requestId());
        sendJson(res, 200, { id: docId, deleted: true });
      },
    ),
  );

  router.add(
    route(
      "POST",
      "/v1/kbs/:kbId/documents/:docId/include",
      "write",
      async ({ req, res, client }, { kbId, docId }) => {
        await requireKb(client, kbId!);
        const row = await requireDocument(kbId!, docId!);
        const body = parseWith(IncludeDocumentRequestSchema, await readJsonBody(req));

        if (!body.included) {
          await db
            .update(document)
            .set({ includedInKb: false })
            .where(eq(document.id, docId!));
          sendJson(res, 200, {
            documentId: docId,
            includedInKb: false,
            processingStatus: row.processingStatus,
          });
          return;
        }

        /**
         * Including a document means running the pipeline over its bytes, and a
         * document ingested as direct text has none — `ingestDocument` takes
         * the string and stores no file. Refused rather than silently left
         * `pending`, which is what a status the caller polls forever looks
         * like.
         */
        if (row.fileUrl === "") {
          throw conflict(
            "this document was ingested as text and has no stored bytes to re-ingest; " +
              "post it again instead",
          );
        }
        await db
          .update(document)
          .set({ includedInKb: true, processingStatus: "pending", processingError: null })
          .where(eq(document.id, docId!));
        await enqueueFileProcessing(kbId!, row.id, {
          filename: row.filename,
          fileUrl: row.fileUrl,
          fileSize: row.fileSize,
          mimeType: row.mimeType,
        });
        sendJson(res, 200, {
          documentId: docId,
          includedInKb: true,
          processingStatus: "pending",
        });
      },
    ),
  );
}

// ─── Ingest ──────────────────────────────────────────────────────────────────

/**
 * `multipart/form-data`: the bytes into the bucket, the row into `document`,
 * the work onto the queue.
 *
 * The blob key is what lands in `file_url`, as a `/api/files/serve/s3/<key>`
 * reference — the document processor resolves it back through the storage
 * service, which is why an ingest works with no publicly reachable URL
 * anywhere.
 */
async function ingestMultipart(
  req: import("node:http").IncomingMessage,
  kbId: string,
): Promise<IngestResponse> {
  const body = await readMultipartBody(req);
  const file = body.files.find((f) => f.field === "file") ?? body.files[0];
  if (!file) throw badRequest("the multipart body carries no `file` part");
  if (file.bytes.length > MAX_UPLOAD_SIZE_BYTES) {
    throw new HttpError(
      413,
      "payload-too-large",
      `the file is over ${MAX_UPLOAD_SIZE_BYTES} bytes`,
    );
  }
  const fields = parseWith(IngestMultipartFieldsSchema, body.fields);
  const filename = fields.filename ?? file.filename;
  const mimeType = fields.mimeType ?? file.contentType;
  /**
   * `includedInKb` and `metadata` are on the multipart contract and the SDK
   * sends both — and this route read neither, so a form that said
   * `includedInKb=false` got a document chunked into the KB anyway. Both are
   * read the way the JSON encoding reads them now, which for `metadata` also
   * means a malformed value is a `400` rather than a part quietly dropped.
   */
  const includedInKb = booleanField(fields.includedInKb, "includedInKb") ?? true;
  /**
   * Validated for its own sake, and the value goes nowhere: on a *file* ingest
   * `metadata` is accepted and not written, because only `ingestDocument` — the
   * text path — carries it onto the chunk rows and that is lifted,
   * behaviour-frozen code (ADR 0005). The JSON encoding's `url` branch is the
   * same pipeline and does the same thing, and `docs/external-api.md` says so
   * rather than leaving it to be discovered. Validating anyway is the
   * difference between "not written" and "silently dropped, malformed or not".
   */
  metadataField(fields.metadata);

  // Before the upload: a `documentId` that belongs to another knowledge base is
  // refused rather than answered after this instance has stored the bytes.
  const reused = await documentForSuppliedId(kbId, fields.documentId);
  if (reused) return reused;
  const documentId = fields.documentId ?? generateId();

  const stored = await StorageService.uploadFile({
    file: file.bytes,
    fileName: filename,
    contentType: mimeType,
    context: "knowledge-base",
  });

  await stageIngestedDocument({
    kbId,
    documentId,
    filename,
    mimeType,
    fileUrl: stored.path,
    fileSize: file.bytes.length,
    includedInKb,
    /**
     * The same call the JSON path makes, over the same seventeen values:
     * `IngestMultipartFieldsSchema` now *declares* the tag slots (it extends
     * `TagWritesSchema`), so they are read off the validated fields rather
     * than off the raw form — one definition of what a tag part is, and the
     * SDK's typed `tags` reaches the staged row by the contract rather than by
     * the shape of the form it happens to build.
     */
    tags: coerceTags(tagWritesFrom(fields)),
  });

  /**
   * `includedInKb: false` means "the bytes are here, do not chunk them", so the
   * pipeline is not enqueued at all — which is what `ingestDocument` does with
   * the same flag on the text path ("persisting metadata only"). The document
   * stays at `pending` with no chunks, which is what keeps it out of every
   * query, and `POST …/documents/:docId/include` is the way in afterwards: it
   * has stored bytes, so that route works on it.
   */
  if (!includedInKb) return { documentId, processingStatus: "pending" };

  await enqueueFileProcessing(kbId, documentId, {
    filename,
    fileUrl: stored.path,
    fileSize: file.bytes.length,
    mimeType,
  });
  return settledAnswer(documentId);
}

/** JSON: `text` takes the `ingestDocument` path, `url` takes the file one. */
async function ingestJson(
  req: import("node:http").IncomingMessage,
  kbId: string,
): Promise<IngestResponse> {
  const body = parseWith(IngestJsonRequestSchema, await readJsonBody(req));
  const includedInKb = body.includedInKb ?? true;
  const mimeType = body.mimeType ?? "application/octet-stream";
  const reused = await documentForSuppliedId(kbId, body.documentId);
  if (reused) return reused;
  const documentId = body.documentId ?? generateId();
  const tags = coerceTags(body.tags);

  if (body.url !== undefined) {
    await stageIngestedDocument({
      kbId,
      documentId,
      filename: body.filename,
      mimeType,
      fileUrl: body.url,
      includedInKb,
      tags,
    });
    await enqueueFileProcessing(kbId, documentId, {
      filename: body.filename,
      fileUrl: body.url,
      fileSize: 0,
      mimeType,
    });
    return settledAnswer(documentId);
  }

  /**
   * The row is written here rather than by the job so that the id this route
   * answers with names something a caller can immediately `GET`.
   * `stageIngestedDocument` is idempotent and `ingestDocument` calls it with
   * the same id, so the job finds the row it would have created.
   */
  await stageIngestedDocument({
    kbId,
    documentId,
    filename: body.filename,
    mimeType,
    characterCount: body.text!.length,
    includedInKb,
    tags,
  });
  const queue = await getJobQueue();
  // Typed rather than inline: `KbIngestDocumentPayload` is the shape the frozen
  // `ingestDocument` destructures, and TASK-005's worker declares a different
  // one for this job name (see that type's note).
  const payload: KbIngestDocumentPayload = {
    kbId,
    documentId,
    text: body.text,
    filename: body.filename,
    mimeType,
    metadata: body.metadata ?? {},
    includedInKb,
    ...(tags === undefined ? {} : { tags }),
  };
  await queue.enqueue("kb.ingest.document", payload);
  return settledAnswer(documentId);
}

/**
 * Studio's upsert semantics.
 *
 * Identity is `(connectorId, externalId)` when both are given — that is the
 * pair a connector syncs against — and the filename otherwise. An unchanged
 * `contentHash` short-circuits without touching anything, which is what makes a
 * connector's periodic re-sync cheap.
 */
async function upsert(
  kbId: string,
  body: import("@actana/search/contracts").UpsertDocumentRequest,
): Promise<UpsertDocumentResponse> {
  const identity =
    body.connectorId !== undefined && body.externalId !== undefined
      ? and(
          eq(document.knowledgeBaseId, kbId),
          eq(document.connectorId, body.connectorId),
          eq(document.externalId, body.externalId),
          isNull(document.deletedAt),
        )
      : and(
          eq(document.knowledgeBaseId, kbId),
          eq(document.filename, body.filename),
          isNull(document.deletedAt),
        );

  const [existing] = await db.select().from(document).where(identity).limit(1);

  if (existing && body.contentHash !== undefined && existing.contentHash === body.contentHash) {
    return {
      documentId: existing.id,
      processingStatus: existing.processingStatus as UpsertDocumentResponse["processingStatus"],
      outcome: "skipped",
    };
  }
  if (existing) await deleteDocument(existing.id, requestId());

  const documentId = generateId();
  const mimeType = body.mimeType ?? "application/octet-stream";
  const tags = coerceTags(body.tags);
  const provenance = {
    ...(body.connectorId === undefined ? {} : { connectorId: body.connectorId }),
    ...(body.externalId === undefined ? {} : { externalId: body.externalId }),
    ...(body.contentHash === undefined ? {} : { contentHash: body.contentHash }),
    ...(body.sourceUrl === undefined ? {} : { sourceUrl: body.sourceUrl }),
  };

  if (body.url !== undefined) {
    await stageIngestedDocument({
      kbId,
      documentId,
      filename: body.filename,
      mimeType,
      fileUrl: body.url,
      includedInKb: true,
      tags: { ...tags, ...provenance },
    });
    await enqueueFileProcessing(kbId, documentId, {
      filename: body.filename,
      fileUrl: body.url,
      fileSize: 0,
      mimeType,
    });
  } else {
    await stageIngestedDocument({
      kbId,
      documentId,
      filename: body.filename,
      mimeType,
      characterCount: body.text!.length,
      includedInKb: true,
      tags: { ...tags, ...provenance },
    });
    const queue = await getJobQueue();
    const payload: KbIngestDocumentPayload = {
      kbId,
      documentId,
      text: body.text,
      filename: body.filename,
      mimeType,
      metadata: body.metadata ?? {},
      includedInKb: true,
      ...(tags === undefined ? {} : { tags }),
    };
    await queue.enqueue("kb.ingest.document", payload);
  }

  return {
    documentId,
    processingStatus: "pending",
    outcome: existing ? "replaced" : "created",
  };
}

/** Hand a file-backed document to the worker flow. */
async function enqueueFileProcessing(
  kbId: string,
  documentId: string,
  docData: { filename: string; fileUrl: string; fileSize: number; mimeType: string },
): Promise<void> {
  const queue = await getJobQueue();
  await queue.enqueue(
    "knowledge-process-document",
    { knowledgeBaseId: kbId, documentId, docData, processingOptions: {}, requestId: requestId() },
    { tags: [`knowledgeBaseId:${kbId}`, `documentId:${documentId}`] },
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * What a caller's own `documentId` means, decided in one place for both
 * encodings.
 *
 * Three answers, and the middle one is the point:
 *
 *   - **No row has that id** → `null`, and the caller's id is used as-is. A
 *     caller that already has an id for this document keeps it (TASK-009's
 *     wrapper needs the ids either side of the wire to be the same ids).
 *   - **A row in *this* KB has it** → that row, and the route answers with its
 *     status and writes nothing. This is the idempotent re-ingest the engine
 *     already supports: `stageIngestedDocument` is `onConflictDoNothing`, so a
 *     second POST of the same id was already a no-op on the row — answering
 *     with the row's real status is just saying so out loud.
 *   - **A row in *another* KB has it** → `409 conflict`. `document.id` is the
 *     primary key across every knowledge base on the instance, so honouring the
 *     id would either overwrite somebody else's document or silently ingest
 *     into their KB. Neither is something a caller can have asked for, and a
 *     `409` is the one answer that does not confirm whose it is.
 */
async function documentForSuppliedId(
  kbId: string,
  suppliedId: string | undefined,
): Promise<IngestResponse | null> {
  if (suppliedId === undefined) return null;
  const [row] = await db
    .select({
      id: document.id,
      knowledgeBaseId: document.knowledgeBaseId,
      processingStatus: document.processingStatus,
      chunkCount: document.chunkCount,
    })
    .from(document)
    .where(eq(document.id, suppliedId))
    .limit(1);
  if (!row) return null;
  if (row.knowledgeBaseId !== kbId) {
    throw conflict(`document ${suppliedId} already exists in another knowledge base`);
  }
  return {
    documentId: row.id,
    processingStatus: row.processingStatus as IngestResponse["processingStatus"],
    ...(row.chunkCount > 0 ? { chunkCount: row.chunkCount } : {}),
  };
}

/**
 * The answer a just-enqueued ingest gets, with `chunkCount` if there already is
 * one.
 *
 * **One read, never a wait.** Ingest is asynchronous and this route answers
 * `202`, so on a first ingest there is usually nothing to report and this
 * costs one indexed read to find that out. What it is for is the case where
 * the count *is* already there — the idempotent re-ingest of an id, and any
 * ingest whose work landed before the answer did. Studio's `ingestDocument`
 * returns a count and `kb_add_file` surfaces it as a block output, so a wire
 * with no field for it leaves that caller reporting `0` (TASK-009, contract
 * change 5).
 *
 * Zero is reported as *absent* rather than as `0`: a document mid-pipeline has
 * no count yet, and "not known" and "no chunks" are different claims. The
 * count for a document still being processed arrives on `document.ingested` or
 * from `GET …/documents/:docId`.
 */
async function settledAnswer(documentId: string): Promise<IngestResponse> {
  const [row] = await db
    .select({ processingStatus: document.processingStatus, chunkCount: document.chunkCount })
    .from(document)
    .where(eq(document.id, documentId))
    .limit(1);
  const chunkCount = row?.chunkCount ?? 0;
  return {
    documentId,
    // `pending` when the row has somehow gone: the work was enqueued either way.
    processingStatus: (row?.processingStatus ?? "pending") as IngestResponse["processingStatus"],
    ...(chunkCount > 0 ? { chunkCount } : {}),
  };
}

/**
 * A form part as a boolean, or a `400`.
 *
 * Refused rather than coerced: `includedInKb=banana` read as `false` is a
 * document silently left out of the KB the caller thought it had filled.
 */
function booleanField(raw: string | undefined, name: string): boolean | undefined {
  if (raw === undefined) return undefined;
  const value = raw.trim();
  if (/^(1|true|yes|on)$/i.test(value)) return true;
  if (/^(0|false|no|off)$/i.test(value)) return false;
  throw badRequest(`\`${name}\` must be true or false, not ${JSON.stringify(raw)}`);
}

/** The `metadata` form part, as the JSON encoding's own schema validates it. */
function metadataField(raw: string | undefined): Record<string, unknown> | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw badRequest("`metadata` must be a JSON object");
  }
  return parseWith(MetadataSchema, parsed);
}

/**
 * Every one of these ids has to be a document this bulk call **would act on**,
 * or nothing happens.
 *
 * One `IN` read, and the refusal names none of the ids: a `404` that said
 * *which* one is not yours would confirm that the others are (ADR 0009 D5), and
 * a bulk call is exactly where a caller could walk an id space cheaply. The
 * count is safe to state — the caller sent the list.
 *
 * **The predicate is the engine's own**, and it has to be: `bulkDocumentOperation`
 * selects and updates under `userExcluded = false AND archived_at IS NULL AND
 * deleted_at IS NULL`, and it *acts on the rows it finds and logs the rest*.
 * Checking only `deleted_at` here therefore let an id through that the engine
 * would then skip — and the route answered `200` with an `affected` short of
 * what the caller asked for, silently, which is the whole thing this check
 * exists to prevent. Additive: every id this used to accept and the engine
 * would have acted on is still accepted.
 */
async function requireEveryDocument(kbId: string, ids: string[]): Promise<void> {
  const rows = await db
    .select({ id: document.id })
    .from(document)
    .where(
      and(
        eq(document.knowledgeBaseId, kbId),
        inArray(document.id, ids),
        eq(document.userExcluded, false),
        isNull(document.archivedAt),
        isNull(document.deletedAt),
      ),
    );
  const found = new Set(rows.map((row) => row.id));
  const missing = new Set(ids.filter((id) => !found.has(id))).size;
  if (missing > 0) {
    throw notFound(
      `${missing} of the ${new Set(ids).size} documents named are not in knowledge base ${kbId}`,
    );
  }
}

/** The document rows for a page of ids, indexed by id. */
async function rowsById(
  ids: string[],
): Promise<Map<string, typeof document.$inferSelect>> {
  if (ids.length === 0) return new Map();
  const rows = await db.select().from(document).where(inArray(document.id, ids));
  return new Map(rows.map((row) => [row.id, row]));
}

/**
 * The tag parts of a validated multipart form, as the JSON encoding's `tags`.
 *
 * `IngestMultipartFieldsSchema` extends `TagWritesSchema`, so the seventeen
 * slots are declared parts rather than whatever the form happened to carry —
 * which is what lets this read the *parsed* fields and hand the result to the
 * same `coerceTags` the JSON path uses. The other keys of the form
 * (`filename`, `documentId`, …) are not tag slots and are not picked up.
 */
function tagWritesFrom(fields: IngestMultipartFields): TagWrites {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (/^(tag[1-7]|number[1-5]|date[12]|boolean[123])$/.test(key)) out[key] = value;
  }
  return out as TagWrites;
}

/**
 * Turn the wire's all-string tag values into the column types.
 *
 * Strings on the way in because a multipart form cannot carry anything else and
 * because Studio's `updateDocument` has always taken them that way; the parsers
 * are Studio's own, so a value that round-trips there round-trips here.
 */
function coerceTags(
  tags: TagWrites | undefined,
): Record<string, string | number | boolean | Date | null> | undefined {
  if (!tags) return undefined;
  const out: Record<string, string | number | boolean | Date | null> = {};
  for (const [key, value] of Object.entries(tags)) {
    if (value === undefined) continue;
    if (key.startsWith("number")) out[key] = parseNumberValue(value);
    else if (key.startsWith("date")) out[key] = parseDateValue(value);
    else if (key.startsWith("boolean")) out[key] = parseBooleanValue(value);
    else out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
