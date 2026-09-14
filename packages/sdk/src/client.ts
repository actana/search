// `SearchClient` — the only way into a Search instance.
//
// CONTEXT.md rule 4: "The SDK is the only way in. No consumer reads a table."
// This is that door. It holds the mTLS material a pairing produced, posts every
// request through one `undici` `Agent`, and turns anything that is not a 2xx
// into a {@link SearchApiError}.
//
// **The namespaces below are declared and empty on purpose.** TASK-004 fills
// `kbs`, `documents`, `keywords`, `clusters`, `tags`, `endpoints`, `webhooks`
// and `events()` against the zod contracts it writes. They are named here so
// that the shape of this client is decided once — by the routes TASK-004's task
// file already lists — rather than accreting method by method, and so that a
// caller reading the package can see what is coming and what is not. Each one
// throws a `not-implemented` `SearchApiError` until then: a stub that returned
// `undefined` would be a method that silently did nothing.
//
// **`undici` rather than `fetch`.** Node's global `fetch` is undici, but its
// per-request `dispatcher` is not a public, typed option, and mTLS material has
// to reach the connection pool somehow. Naming the dependency is the honest
// version of the same thing.

import { Agent, request as undiciRequest } from "undici";
import type { Dispatcher } from "undici";
import { SearchApiError } from "./errors.ts";
import {
  searchConnectionFromBlob,
  type SearchRegistrationBlob,
} from "./registration-blob.ts";
import type { SearchHealth, SearchPairStatus } from "./pairing-wire.ts";

/** What a request may carry. One of these, or nothing. */
export type SearchRequestBody =
  | { json: unknown }
  | { multipart: FormData }
  | { stream: NodeJS.ReadableStream | ReadableStream; contentType?: string }
  | undefined;

export type SearchRequestOptions = {
  /** Query parameters, appended to the path. */
  query?: Record<string, string | number | boolean | undefined>;
  /** Extra headers. Never a credential — the certificate is the credential. */
  headers?: Record<string, string>;
  /** Milliseconds before the request is abandoned. */
  timeoutMs?: number;
} & ({ json?: unknown; multipart?: FormData; stream?: never } | { stream?: NodeJS.ReadableStream | ReadableStream; contentType?: string; json?: never; multipart?: never });

export type SearchClientOptions = {
  /** What this client calls itself, in logs on this side only. */
  label?: string;
  /** Default per-request timeout. 30s. */
  timeoutMs?: number;
};

/** The default per-request timeout. Ingest passes its own. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** A namespace TASK-004 fills. Every member throws until it does. */
function pending(namespace: string, method: string): never {
  throw new SearchApiError(
    "not-implemented",
    0,
    `${namespace}.${method}() lands with the REST surface in TASK-004. ` +
      "Use client.request() against the route in the meantime.",
  );
}

export class SearchClient {
  /** `https://host:port`. No path, no trailing slash. */
  readonly baseUrl: string;
  readonly label: string;
  private readonly agent: Agent;
  private readonly timeoutMs: number;

  private constructor(baseUrl: string, agent: Agent, label: string, timeoutMs: number) {
    this.baseUrl = baseUrl;
    this.agent = agent;
    this.label = label;
    this.timeoutMs = timeoutMs;
  }

  /**
   * Build a client from the credential a pairing produced.
   *
   * The three PEMs go straight into the connection pool's TLS options: `ca`
   * pins the instance, `cert` and `key` are what it recognises this client by.
   * The key is the one `pairWithSearch` generated locally and never sent.
   */
  static fromRegistrationBlob(
    blob: SearchRegistrationBlob,
    opts: SearchClientOptions = {},
  ): SearchClient {
    const connection = searchConnectionFromBlob(blob);
    if (!connection.tls) {
      throw new SearchApiError(
        "bad-endpoint",
        0,
        `the blob's endpoint ${blob.endpoint} is not an https:// origin, so there is no ` +
          "handshake to present a certificate on",
      );
    }
    const agent = new Agent({
      connect: {
        ca: connection.tls.ca,
        cert: connection.tls.cert,
        key: connection.tls.key,
        rejectUnauthorized: true,
      },
    });
    return new SearchClient(
      connection.httpsBaseUrl,
      agent,
      opts.label ?? blob.label ?? "actana-search-client",
      opts.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    );
  }

  /**
   * Build a client against a plain-HTTP instance running with
   * `SEARCH_DEV_INSECURE=1`, identifying as `pairedClientId`.
   *
   * It exists for the fixture suites, it sends the id in a header, and a header
   * is exactly what ADR 0003 says identity is never read from — which is why
   * the *server* half refuses to start this way under `NODE_ENV=production`.
   */
  static insecureForTests(baseUrl: string, pairedClientId: string): SearchClient {
    const client = new SearchClient(
      baseUrl.replace(/\/+$/, ""),
      new Agent(),
      "insecure-test-client",
      DEFAULT_REQUEST_TIMEOUT_MS,
    );
    client.insecureClientId = pairedClientId;
    return client;
  }

  private insecureClientId: string | undefined;

  /** Release the connection pool. A long-lived process should call this. */
  async close(): Promise<void> {
    await this.agent.close();
  }

  /**
   * One request, and the only place a response is turned into an error.
   *
   * A non-2xx is a {@link SearchApiError} carrying whatever `code` the instance
   * sent, so a caller switches on the instance's vocabulary rather than on a
   * status number it would have to map itself.
   */
  async request<T>(
    method: string,
    path: string,
    options: SearchRequestOptions = {},
  ): Promise<T> {
    const url = new URL(path.startsWith("/") ? path : `/${path}`, this.baseUrl);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const headers: Record<string, string> = { accept: "application/json", ...options.headers };
    if (this.insecureClientId) headers["x-paired-client"] = this.insecureClientId;

    let body: Dispatcher.RequestOptions["body"];
    if (options.json !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(options.json);
    } else if (options.multipart) {
      // `undici` sets the multipart boundary itself from a `FormData`.
      body = options.multipart as unknown as Dispatcher.RequestOptions["body"];
    } else if (options.stream) {
      headers["content-type"] = options.contentType ?? "application/octet-stream";
      body = options.stream as unknown as Dispatcher.RequestOptions["body"];
    }

    let response;
    try {
      response = await undiciRequest(url, {
        method: method.toUpperCase() as Dispatcher.HttpMethod,
        dispatcher: this.agent,
        headersTimeout: options.timeoutMs ?? this.timeoutMs,
        bodyTimeout: options.timeoutMs ?? this.timeoutMs,
        headers,
        body,
      });
    } catch (err) {
      throw new SearchApiError(
        "unreachable",
        0,
        `${method.toUpperCase()} ${url.pathname} could not be sent: ${
          err instanceof Error ? err.message : String(err)
        }`,
        undefined,
        { cause: err },
      );
    }

    const text = await response.body.text();
    const parsed = text === "" ? undefined : safeJson(text);

    if (response.statusCode >= 200 && response.statusCode < 300) {
      return parsed as T;
    }
    const failure = (parsed ?? {}) as { code?: unknown; error?: unknown; message?: unknown; detail?: unknown };
    throw new SearchApiError(
      typeof failure.code === "string" ? failure.code : `http-${response.statusCode}`,
      response.statusCode,
      typeof failure.error === "string"
        ? failure.error
        : typeof failure.message === "string"
          ? failure.message
          : `${method.toUpperCase()} ${url.pathname} answered ${response.statusCode}`,
      failure.detail,
    );
  }

  /** `GET /v1/health`. Open — it answers without a certificate too. */
  health(): Promise<SearchHealth> {
    return this.request<SearchHealth>("GET", "/v1/health");
  }

  /** `GET /v1/capabilities`. What this instance's build can do. */
  capabilities(): Promise<{
    protocol: number;
    schemaVersion: number;
    features: string[];
    publicHost: string;
  }> {
    return this.request("GET", "/v1/capabilities");
  }

  /** `GET /v1/pair/status`. Who this certificate is, and what it was granted. */
  pairStatus(): Promise<SearchPairStatus> {
    return this.request<SearchPairStatus>("GET", "/v1/pair/status");
  }

  // ── The namespaces TASK-004 fills ──────────────────────────────────────────
  //
  // Declared now so the client's shape is one decision. Each throws
  // `not-implemented` until the route behind it exists.

  readonly kbs = {
    list: () => pending("kbs", "list"),
    create: (_input: unknown) => pending("kbs", "create"),
    get: (_id: string) => pending("kbs", "get"),
    update: (_id: string, _patch: unknown) => pending("kbs", "update"),
    delete: (_id: string) => pending("kbs", "delete"),
    query: (_id: string, _input: unknown) => pending("kbs", "query"),
    ingest: (_id: string, _input: unknown) => pending("kbs", "ingest"),
  };

  readonly documents = {
    list: (_kbId: string) => pending("documents", "list"),
    get: (_kbId: string, _docId: string) => pending("documents", "get"),
    update: (_kbId: string, _docId: string, _patch: unknown) => pending("documents", "update"),
    delete: (_kbId: string, _docId: string) => pending("documents", "delete"),
    chunks: (_kbId: string, _docId: string) => pending("documents", "chunks"),
    updateChunk: (_kbId: string, _docId: string, _chunkId: string, _patch: unknown) =>
      pending("documents", "updateChunk"),
    deleteChunk: (_kbId: string, _docId: string, _chunkId: string) =>
      pending("documents", "deleteChunk"),
    include: (_kbId: string, _docId: string, _input: unknown) => pending("documents", "include"),
    upsert: (_kbId: string, _input: unknown) => pending("documents", "upsert"),
  };

  readonly keywords = {
    list: (_kbId: string) => pending("keywords", "list"),
    put: (_kbId: string, _input: unknown) => pending("keywords", "put"),
    delete: (_kbId: string, _keywordId: string) => pending("keywords", "delete"),
    extract: (_kbId: string, _input: unknown) => pending("keywords", "extract"),
  };

  readonly clusters = {
    list: (_kbId: string) => pending("clusters", "list"),
    status: (_kbId: string) => pending("clusters", "status"),
    recluster: (_kbId: string) => pending("clusters", "recluster"),
  };

  readonly tags = {
    definitions: (_kbId: string) => pending("tags", "definitions"),
    put: (_kbId: string, _input: unknown) => pending("tags", "put"),
    delete: (_kbId: string, _tagId: string) => pending("tags", "delete"),
    usage: (_kbId: string) => pending("tags", "usage"),
    nextAvailableSlot: (_kbId: string) => pending("tags", "nextAvailableSlot"),
  };

  readonly endpoints = {
    get: () => pending("endpoints", "get"),
    put: (_input: unknown) => pending("endpoints", "put"),
  };

  readonly webhooks = {
    get: () => pending("webhooks", "get"),
    put: (_input: unknown) => pending("webhooks", "put"),
  };

  /** `GET /v1/events` as an async iterator of SSE payloads. TASK-004. */
  events(): AsyncIterable<unknown> {
    return pending("events", "()");
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}
