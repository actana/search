/**
 * The plumbing every `/v1` route shares: how a body is read, how a URL is
 * matched, how a failure becomes a status code, and nothing else.
 *
 * **Nothing here decides policy.** The scope check is the router's
 * (`api/routes.ts`), the ownership check is `api/ownership.ts`, and the request
 * shapes are the SDK's contracts. This file is the part that would otherwise be
 * copied into thirty handlers.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { Buffer } from "node:buffer";
import { createLogger } from "@actana/search-shared/log";
import { generateShortId } from "@actana/search-shared/short-id";
import type { SearchErrorCode } from "@actana/search/contracts";
import type { SearchRoute, SearchRequestContext } from "./routes.ts";

const logger = createLogger("api/http");

/** The most a JSON body may weigh. Nothing on this surface is large but ingest. */
export const MAX_JSON_BODY_BYTES = 4 * 1024 * 1024;

/** The most a multipart upload may weigh, envelope included. */
export const MAX_MULTIPART_BYTES = 64 * 1024 * 1024;

/**
 * A refusal a handler can throw from anywhere, carrying the wire's own `code`.
 *
 * Thrown rather than returned so a helper five calls down — "this KB is not
 * yours", "that document does not exist" — can end the request without every
 * caller in between having to forward a result type. `serveRoute` is the only
 * place it is caught.
 */
export class HttpError extends Error {
  override readonly name = "HttpError";
  readonly status: number;
  readonly code: SearchErrorCode;
  readonly detail: unknown;
  /** Extra response headers — `Retry-After` on a 429, and nothing else so far. */
  readonly headers: Record<string, string>;

  // Assigned rather than declared as constructor parameters: this repository is
  // loaded by `node` with type stripping only, which cannot erase a parameter
  // property (`scripts/check-strip-types.mjs`).
  constructor(
    status: number,
    code: SearchErrorCode,
    message: string,
    detail?: unknown,
    headers: Record<string, string> = {},
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.detail = detail;
    this.headers = headers;
  }
}

export const badRequest = (message: string, detail?: unknown): HttpError =>
  new HttpError(400, "bad-request", message, detail);

export const notFound = (message: string): HttpError => new HttpError(404, "not-found", message);

export const conflict = (message: string): HttpError => new HttpError(409, "conflict", message);

/** Write a JSON body. `undefined` is `204`, because `null` is a value. */
export function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  if (payload === undefined) {
    res.writeHead(204, { "cache-control": "no-store" });
    res.end();
    return;
  }
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(body)),
    "cache-control": "no-store",
  });
  res.end(body);
}

/**
 * Write an error body: `{ code, message, detail? }`.
 *
 * `error` is written beside `message` with the same string. The pre-auth
 * pairing surface has spelled it that way since it was copied out of Control
 * (ADR 0008) and a client written against that spelling still works; new code
 * reads `message`, and the contract documents `error` as the alias.
 */
export function sendError(res: ServerResponse, error: unknown): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  if (error instanceof HttpError) {
    const body: Record<string, unknown> = {
      code: error.code,
      message: error.message,
      error: error.message,
    };
    if (error.detail !== undefined) body.detail = error.detail;
    const text = JSON.stringify(body);
    res.writeHead(error.status, {
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(text)),
      "cache-control": "no-store",
      ...error.headers,
    });
    res.end(text);
    return;
  }

  /**
   * Anything else is this instance's fault, and the caller is told an id rather
   * than a stack: a stack is an internal map of the process and a caller has no
   * use for one. The id is in the log line beside the real error, which is what
   * an operator greps.
   */
  const errorId = `err_${generateShortId(10)}`;
  logger.error("Route failed", {
    errorId,
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
  sendError(res, new HttpError(500, "core-error", "this instance failed", { errorId }));
}

/**
 * Read a JSON body, capped.
 *
 * An empty body is `{}` rather than an error: a `POST` whose whole meaning is
 * its URL (`/recluster`) should not have to carry `{}` to be legal.
 */
export async function readJsonBody(
  req: IncomingMessage,
  maxBytes: number = MAX_JSON_BODY_BYTES,
): Promise<unknown> {
  const declared = req.headers["content-type"];
  const mediaType = String(declared ?? "").split(";")[0]!.trim().toLowerCase();
  if (mediaType !== "" && mediaType !== "application/json") {
    throw new HttpError(
      415,
      "unsupported-media-type",
      `this route reads application/json, not ${mediaType}`,
    );
  }
  const raw = await readBody(req, maxBytes);
  const text = raw.toString("utf8").trim();
  if (text === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw badRequest("the body was not JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw badRequest("the body must be a JSON object");
  }
  return parsed;
}

/** Read the whole body into memory, refusing past `maxBytes`. */
export function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const fail = (err: unknown): void => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        fail(new HttpError(413, "payload-too-large", `the body is over ${maxBytes} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on("error", () => fail(badRequest("the body could not be read")));
  });
}

/**
 * Validate against a contract, or refuse with the issues.
 *
 * `detail` carries zod's own issue list — path, code, message — because "this
 * failed validation" without saying which field is a message a caller has to
 * guess at.
 */
export function parseWith<T>(
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false; error: { issues: unknown[] } } },
  value: unknown,
): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new HttpError(400, "validation-failed", "the request does not match the contract", {
    issues: result.error.issues,
  });
}

// ─── Routing ─────────────────────────────────────────────────────────────────

/** The parameters a pattern pulled out of a pathname. */
export type PathParams = Record<string, string>;

/**
 * Match `/v1/kbs/:kbId/documents/:docId` against a pathname.
 *
 * Segment-by-segment and nothing cleverer: no wildcards, no optional segments,
 * no regular expression a reviewer has to run in their head. A parameter never
 * matches an empty segment, so `/v1/kbs//query` is a 404 rather than a query
 * against a KB called "".
 */
export function matchPath(pattern: string, pathname: string): PathParams | null {
  const wanted = pattern.split("/");
  const got = pathname.split("/");
  if (wanted.length !== got.length) return null;
  const params: PathParams = {};
  for (let i = 0; i < wanted.length; i++) {
    const w = wanted[i]!;
    const g = got[i]!;
    if (w.startsWith(":")) {
      if (g === "") return null;
      params[w.slice(1)] = decodeURIComponent(g);
      continue;
    }
    if (w !== g) return null;
  }
  return params;
}

/** A handler that gets the matched path parameters beside the request. */
export type ParamHandler = (
  ctx: SearchRequestContext,
  params: PathParams,
) => void | Promise<void>;

/**
 * Build a {@link SearchRoute} from a pattern.
 *
 * **`kbIdFrom` is derived, not written.** A pattern carrying `:kbId` yields a
 * route that declares it, so the router refuses a KB outside the pairing's
 * allow-list before the handler is entered — the property `routes.ts` describes
 * as "enforced by the fact of being registered". A route whose KB is in a body
 * has no `:kbId` and asks `ctx.allowsKb` itself.
 */
export function route(
  method: string,
  pattern: string,
  scope: "read" | "write" | "admin" | null,
  handle: ParamHandler,
): SearchRoute {
  const carriesKb = pattern.includes(":kbId");
  return {
    method,
    path: (pathname) => matchPath(pattern, pathname) !== null,
    scope,
    ...(carriesKb
      ? { kbIdFrom: (url: URL) => matchPath(pattern, url.pathname)?.kbId ?? null }
      : {}),
    handle: async (ctx) => {
      /**
       * Every refusal is turned into a body here, which is why a handler can
       * `throw notFound(...)` from four calls down. The server's own catch is
       * still behind this one and still answers `core-error` — it is the net
       * under a route that failed while writing its response.
       */
      try {
        const params = matchPath(pattern, ctx.url.pathname);
        if (!params) throw notFound(`no route for ${method} ${ctx.url.pathname}`);
        await handle(ctx, params);
      } catch (err) {
        sendError(ctx.res, err);
      }
    },
  };
}

/** Query-string parameters as a plain object, last value wins. */
export function queryOf(url: URL): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of url.searchParams) out[key] = value;
  return out;
}

// ─── Multipart ───────────────────────────────────────────────────────────────

export type MultipartFile = {
  field: string;
  filename: string;
  contentType: string;
  bytes: Buffer;
};

export type MultipartBody = {
  fields: Record<string, string>;
  files: MultipartFile[];
};

/**
 * Parse a `multipart/form-data` body.
 *
 * **Hand-written, and that is the cheaper option here.** The whole of what this
 * surface needs is one file part and a handful of string parts under a 64 MB
 * cap; a dependency for that is a dependency to audit, pin, and age-gate
 * (SECURITY.md), against about sixty lines that a reviewer can read in one
 * sitting. It buffers rather than streams, which the cap is what makes safe.
 */
export async function readMultipartBody(
  req: IncomingMessage,
  maxBytes: number = MAX_MULTIPART_BYTES,
): Promise<MultipartBody> {
  const contentType = String(req.headers["content-type"] ?? "");
  const boundary = boundaryOf(contentType);
  if (!boundary) {
    throw new HttpError(
      415,
      "unsupported-media-type",
      "a multipart body must declare its boundary in the content type",
    );
  }
  const raw = await readBody(req, maxBytes);
  const delimiter = Buffer.from(`--${boundary}`);
  const fields: Record<string, string> = {};
  const files: MultipartFile[] = [];

  let cursor = raw.indexOf(delimiter);
  if (cursor === -1) throw badRequest("the multipart body has no first boundary");
  cursor += delimiter.length;

  while (cursor < raw.length) {
    // `--` right after a delimiter is the closing one; anything else is CRLF.
    if (raw[cursor] === 0x2d && raw[cursor + 1] === 0x2d) break;
    if (raw[cursor] === 0x0d && raw[cursor + 1] === 0x0a) cursor += 2;
    else if (raw[cursor] === 0x0a) cursor += 1;

    const headerEnd = raw.indexOf("\r\n\r\n", cursor);
    if (headerEnd === -1) throw badRequest("a multipart part has no header block");
    const headerText = raw.subarray(cursor, headerEnd).toString("utf8");
    const bodyStart = headerEnd + 4;

    const nextDelimiter = raw.indexOf(delimiter, bodyStart);
    if (nextDelimiter === -1) throw badRequest("a multipart part has no closing boundary");
    // The CRLF immediately before the delimiter belongs to the delimiter.
    let bodyEnd = nextDelimiter;
    if (raw[bodyEnd - 2] === 0x0d && raw[bodyEnd - 1] === 0x0a) bodyEnd -= 2;
    else if (raw[bodyEnd - 1] === 0x0a) bodyEnd -= 1;

    const part = raw.subarray(bodyStart, bodyEnd);
    const disposition = headerLine(headerText, "content-disposition");
    const field = quotedParam(disposition, "name");
    const filename = quotedParam(disposition, "filename");
    if (field) {
      if (filename !== null) {
        files.push({
          field,
          filename,
          contentType:
            headerLine(headerText, "content-type")?.split(";")[0]?.trim() ??
            "application/octet-stream",
          bytes: Buffer.from(part),
        });
      } else {
        fields[field] = part.toString("utf8");
      }
    }
    cursor = nextDelimiter + delimiter.length;
  }

  return { fields, files };
}

function boundaryOf(contentType: string): string | null {
  const mediaType = contentType.split(";")[0]!.trim().toLowerCase();
  if (mediaType !== "multipart/form-data") return null;
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const value = (match?.[1] ?? match?.[2] ?? "").trim();
  return value === "" ? null : value;
}

function headerLine(headers: string, name: string): string | null {
  for (const line of headers.split("\r\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    if (line.slice(0, colon).trim().toLowerCase() === name) return line.slice(colon + 1).trim();
  }
  return null;
}

function quotedParam(header: string | null, name: string): string | null {
  if (!header) return null;
  const match = new RegExp(`${name}="([^"]*)"`, "i").exec(header);
  return match ? match[1]! : null;
}

/** Is this request a multipart one? */
export function isMultipart(req: IncomingMessage): boolean {
  return String(req.headers["content-type"] ?? "")
    .toLowerCase()
    .startsWith("multipart/form-data");
}
