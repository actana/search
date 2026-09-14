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
  IngestJsonRequestSchema,
  IngestMultipartFieldsSchema,
  IncludeDocumentRequestSchema,
  ListDocumentsQuerySchema,
  UpdateDocumentRequestSchema,
  UpsertDocumentRequestSchema,
} from "@actana/search/contracts";
import type { TagWrites, UpsertDocumentResponse } from "@actana/search/contracts";
import { generateId, generateShortId } from "@actana/search-shared/short-id";
import { db } from "../../db/client.ts";
import { document } from "../../db/schema.ts";
import { StorageService } from "../../blob/index.ts";
import { MAX_UPLOAD_SIZE_BYTES } from "../../blob/validation.ts";
import { stageIngestedDocument } from "../../kb/ingest.ts";
import { getJobQueue } from "../../queue/index.ts";
import {
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
    route("GET", "/v1/kbs/:kbId/documents", "read", async ({ res, client, url }, { kbId }) => {
      await requireKb(client, kbId!);
      const query = parseWith(ListDocumentsQuerySchema, queryOf(url));
      const listed = await getDocuments(kbId!, query, requestId());
      const rows = await rowsById(listed.documents.map((d) => d.id));
      sendJson(res, 200, {
        documents: listed.documents
          .map((d) => rows.get(d.id))
          .filter((row) => row !== undefined)
          .map(documentToWire),
        pagination: listed.pagination,
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
): Promise<{ documentId: string; processingStatus: string }> {
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

  const stored = await StorageService.uploadFile({
    file: file.bytes,
    fileName: filename,
    contentType: mimeType,
    context: "knowledge-base",
  });

  const documentId = generateId();
  await stageIngestedDocument({
    kbId,
    documentId,
    filename,
    mimeType,
    fileUrl: stored.path,
    fileSize: file.bytes.length,
    includedInKb: true,
    tags: coerceTags(tagWritesFrom(body.fields)),
  });

  await enqueueFileProcessing(kbId, documentId, {
    filename,
    fileUrl: stored.path,
    fileSize: file.bytes.length,
    mimeType,
  });
  return { documentId, processingStatus: "pending" };
}

/** JSON: `text` takes the `ingestDocument` path, `url` takes the file one. */
async function ingestJson(
  req: import("node:http").IncomingMessage,
  kbId: string,
): Promise<{ documentId: string; processingStatus: string }> {
  const body = parseWith(IngestJsonRequestSchema, await readJsonBody(req));
  const includedInKb = body.includedInKb ?? true;
  const mimeType = body.mimeType ?? "application/octet-stream";
  const documentId = generateId();
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
    return { documentId, processingStatus: "pending" };
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
  await queue.enqueue("kb.ingest.document", {
    kbId,
    documentId,
    text: body.text,
    filename: body.filename,
    mimeType,
    metadata: body.metadata ?? {},
    includedInKb,
    tags,
  });
  return { documentId, processingStatus: "pending" };
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
    await queue.enqueue("kb.ingest.document", {
      kbId,
      documentId,
      text: body.text,
      filename: body.filename,
      mimeType,
      metadata: body.metadata ?? {},
      includedInKb: true,
      tags,
    });
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

/** The document rows for a page of ids, indexed by id. */
async function rowsById(
  ids: string[],
): Promise<Map<string, typeof document.$inferSelect>> {
  if (ids.length === 0) return new Map();
  const rows = await db.select().from(document).where(inArray(document.id, ids));
  return new Map(rows.map((row) => [row.id, row]));
}

/** Pull the tag parts out of a multipart form's string fields. */
function tagWritesFrom(fields: Record<string, string>): TagWrites {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(fields)) {
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
