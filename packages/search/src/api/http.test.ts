// The routing and body-reading plumbing, without a server around it.
import { PassThrough } from "node:stream";
import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import {
  HttpError,
  MAX_JSON_BODY_BYTES,
  matchPath,
  readJsonBody,
  readMultipartBody,
} from "./http.ts";

/** An `IncomingMessage` enough for the body readers: headers and a stream. */
function fakeRequest(headers: Record<string, string>, body: Buffer | string): IncomingMessage {
  const stream = new PassThrough();
  const req = stream as unknown as IncomingMessage;
  (req as { headers: Record<string, string> }).headers = headers;
  process.nextTick(() => {
    stream.end(typeof body === "string" ? Buffer.from(body, "utf8") : body);
  });
  return req;
}

describe("matchPath", () => {
  it("pulls the parameters out of a pathname", () => {
    expect(matchPath("/v1/kbs/:kbId/documents/:docId", "/v1/kbs/kb_1/documents/doc_2")).toEqual({
      kbId: "kb_1",
      docId: "doc_2",
    });
  });

  it("matches a pattern with no parameters", () => {
    expect(matchPath("/v1/endpoints", "/v1/endpoints")).toEqual({});
  });

  it("refuses a different segment count, so no pattern eats a longer path", () => {
    expect(matchPath("/v1/kbs/:kbId", "/v1/kbs/kb_1/documents")).toBeNull();
    expect(matchPath("/v1/kbs/:kbId/documents", "/v1/kbs/kb_1")).toBeNull();
  });

  it("refuses an empty parameter segment", () => {
    // `/v1/kbs//query` must be a 404 rather than a query against a KB named "".
    expect(matchPath("/v1/kbs/:kbId/query", "/v1/kbs//query")).toBeNull();
  });

  it("compares literal segments exactly, case included", () => {
    expect(matchPath("/v1/kbs/:kbId/query", "/v1/kbs/kb_1/Query")).toBeNull();
    expect(matchPath("/v1/kbs/:kbId/query", "/v2/kbs/kb_1/query")).toBeNull();
  });

  it("decodes a percent-escaped parameter", () => {
    expect(matchPath("/v1/kbs/:kbId", "/v1/kbs/kb%2F1")).toEqual({ kbId: "kb/1" });
  });
});

describe("readJsonBody", () => {
  it("reads an object", async () => {
    const req = fakeRequest({ "content-type": "application/json" }, '{"a":1}');
    await expect(readJsonBody(req)).resolves.toEqual({ a: 1 });
  });

  it("accepts a charset, which a client may well send", async () => {
    const req = fakeRequest({ "content-type": "application/json; charset=utf-8" }, "{}");
    await expect(readJsonBody(req)).resolves.toEqual({});
  });

  it("reads an empty body as `{}` — a POST whose meaning is its URL", async () => {
    const req = fakeRequest({}, "");
    await expect(readJsonBody(req)).resolves.toEqual({});
  });

  it("refuses a content type it does not read", async () => {
    const req = fakeRequest({ "content-type": "text/plain" }, "{}");
    await expect(readJsonBody(req)).rejects.toMatchObject({
      status: 415,
      code: "unsupported-media-type",
    });
  });

  it("refuses a non-object and a non-JSON body by name", async () => {
    await expect(
      readJsonBody(fakeRequest({ "content-type": "application/json" }, "[1,2]")),
    ).rejects.toMatchObject({ status: 400, code: "bad-request" });
    await expect(
      readJsonBody(fakeRequest({ "content-type": "application/json" }, "not json")),
    ).rejects.toMatchObject({ status: 400, code: "bad-request" });
  });

  it("refuses a body over the cap as it arrives, not after", async () => {
    const req = fakeRequest({ "content-type": "application/json" }, Buffer.alloc(64, 0x20));
    await expect(readJsonBody(req, 16)).rejects.toMatchObject({
      status: 413,
      code: "payload-too-large",
    });
  });
});

describe("readMultipartBody", () => {
  const BOUNDARY = "----test-boundary-9f2";

  /** One well-formed multipart body: a file part and two field parts. */
  function multipart(fileBytes: Buffer): Buffer {
    const parts = [
      `--${BOUNDARY}\r\n`,
      'content-disposition: form-data; name="filename"\r\n\r\nhandbook.md\r\n',
      `--${BOUNDARY}\r\n`,
      'content-disposition: form-data; name="tag1"\r\n\r\nhandbook\r\n',
      `--${BOUNDARY}\r\n`,
      'content-disposition: form-data; name="file"; filename="handbook.md"\r\n' +
        "content-type: text/markdown\r\n\r\n",
    ];
    return Buffer.concat([
      Buffer.from(parts.join(""), "utf8"),
      fileBytes,
      Buffer.from(`\r\n--${BOUNDARY}--\r\n`, "utf8"),
    ]);
  }

  it("separates the file part from the string parts", async () => {
    const bytes = Buffer.from("# Parental leave\n\nSix weeks.\n", "utf8");
    const req = fakeRequest(
      { "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
      multipart(bytes),
    );
    const body = await readMultipartBody(req);
    expect(body.fields).toEqual({ filename: "handbook.md", tag1: "handbook" });
    expect(body.files).toHaveLength(1);
    expect(body.files[0]).toMatchObject({
      field: "file",
      filename: "handbook.md",
      contentType: "text/markdown",
    });
    expect(body.files[0]!.bytes.equals(bytes)).toBe(true);
  });

  it("keeps binary content byte-for-byte, CRLF sequences included", async () => {
    // The parser trims exactly one CRLF before a boundary. A file that ends in
    // its own CRLF must keep it, or every uploaded document chunks differently.
    const bytes = Buffer.from([0x00, 0x0d, 0x0a, 0xff, 0x0d, 0x0a]);
    const req = fakeRequest(
      { "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
      multipart(bytes),
    );
    const body = await readMultipartBody(req);
    expect(body.files[0]!.bytes.equals(bytes)).toBe(true);
  });

  it("accepts a quoted boundary", async () => {
    const req = fakeRequest(
      { "content-type": `multipart/form-data; boundary="${BOUNDARY}"` },
      multipart(Buffer.from("x")),
    );
    await expect(readMultipartBody(req)).resolves.toMatchObject({
      fields: { filename: "handbook.md" },
    });
  });

  it("refuses a body that declares no boundary", async () => {
    const req = fakeRequest({ "content-type": "multipart/form-data" }, "whatever");
    await expect(readMultipartBody(req)).rejects.toMatchObject({
      status: 415,
      code: "unsupported-media-type",
    });
  });

  it("refuses a truncated envelope rather than inventing a part", async () => {
    const truncated = multipart(Buffer.from("x")).subarray(0, 60);
    const req = fakeRequest(
      { "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
      truncated,
    );
    await expect(readMultipartBody(req)).rejects.toBeInstanceOf(HttpError);
  });

  it("refuses an upload over the cap", async () => {
    const req = fakeRequest(
      { "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
      multipart(Buffer.alloc(4096)),
    );
    await expect(readMultipartBody(req, 512)).rejects.toMatchObject({
      status: 413,
      code: "payload-too-large",
    });
  });
});

describe("the caps", () => {
  it("are what the documentation says, because a client sizes itself by them", () => {
    expect(MAX_JSON_BODY_BYTES).toBe(4 * 1024 * 1024);
  });
});
