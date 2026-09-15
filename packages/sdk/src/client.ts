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

import { randomBytes } from "node:crypto";
import { Agent, request as undiciRequest } from "undici";
import type { Dispatcher } from "undici";
import { SearchApiError } from "./errors.ts";
import {
  searchConnectionFromBlob,
  type SearchRegistrationBlob,
} from "./registration-blob.ts";
import type { SearchHealth, SearchPairStatus } from "./pairing-wire.ts";
import type {
  AttachChunkKeywordRequest,
  Capabilities,
  Chunk,
  ChunkKeywordResponse,
  ClusteringStatus,
  CreateKbRequest,
  DeleteChunkResponse,
  DeleteDocumentResponse,
  DeleteKbResponse,
  DeleteKeywordResponse,
  DeleteTagDefinitionResponse,
  DeleteWebhookResponse,
  ExtractKeywordsRequest,
  ExtractKeywordsResponse,
  GetEndpointsResponse,
  GetWebhookResponse,
  IncludeDocumentRequest,
  IncludeDocumentResponse,
  IngestJsonRequest,
  IngestResponse,
  Keyword,
  KnowledgeBase,
  ListChunksQuery,
  ListChunksResponse,
  ListClustersQuery,
  ListClustersResponse,
  ListDocumentsQuery,
  ListDocumentsResponse,
  ListKbsQuery,
  ListKbsResponse,
  ListKeywordsQuery,
  ListKeywordsResponse,
  ListTagDefinitionsResponse,
  NextAvailableSlotQuery,
  NextAvailableSlotResponse,
  PutEndpointsRequest,
  PutEndpointsResponse,
  PutKeywordRequest,
  PutTagDefinitionsRequest,
  PutTagDefinitionsResponse,
  PutWebhookRequest,
  QueryRequest,
  QueryResponse,
  ReclusterResponse,
  SearchDocument,
  SearchEvent,
  TagDefinition,
  TagUsage,
  TagUsageResponse,
  UpdateChunkRequest,
  UpdateDocumentRequest,
  UpdateKbRequest,
  UpsertDocumentRequest,
  UpsertDocumentResponse,
} from "./contracts.ts";


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
      /**
       * Encoded here rather than handed over as a `FormData`.
       *
       * `undici.request` — the dispatch-level API this client uses, because it
       * is the one that takes a `dispatcher` and therefore the one mTLS
       * material can reach — does **not** accept a `FormData` body. Only
       * `fetch` does, and `fetch` has no typed per-request dispatcher. Passing
       * one anyway sends a request with no body at all, which the far side
       * eventually answers `408` on: a failure mode with no error in it.
       *
       * So the envelope is written out here, and the boundary is ours.
       */
      const encoded = await encodeMultipart(options.multipart);
      headers["content-type"] = encoded.contentType;
      body = encoded.body;
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
  capabilities(): Promise<Capabilities> {
    return this.request<Capabilities>("GET", "/v1/capabilities");
  }

  /** `GET /v1/pair/status`. Who this certificate is, and what it was granted. */
  pairStatus(): Promise<SearchPairStatus> {
    return this.request<SearchPairStatus>("GET", "/v1/pair/status");
  }

  // ── The namespaces ────────────────────────────────────────────────────────
  //
  // Every signature below is `z.infer`red from `@actana/search/contracts`,
  // which is the same object the instance validates the request with (ADR
  // 0009). A field this client can send is a field that route accepts, by
  // construction rather than by review.

  readonly kbs = {
    /** `GET /v1/kbs`. */
    list: async (query: ListKbsQuery = {}): Promise<KnowledgeBase[]> => {
      const answer = await this.request<ListKbsResponse>("GET", "/v1/kbs", {
        query: { ...(query.scope === undefined ? {} : { scope: query.scope }) },
      });
      return answer.knowledgeBases;
    },

    /** `POST /v1/kbs`. */
    create: (input: CreateKbRequest): Promise<KnowledgeBase> =>
      this.request<KnowledgeBase>("POST", "/v1/kbs", { json: input }),

    /** `GET /v1/kbs/:id`. 404 for a KB that is not this client's (ADR 0009). */
    get: (kbId: string): Promise<KnowledgeBase> =>
      this.request<KnowledgeBase>("GET", `/v1/kbs/${encodeURIComponent(kbId)}`),

    /** `PATCH /v1/kbs/:id`. */
    update: (kbId: string, patch: UpdateKbRequest): Promise<KnowledgeBase> =>
      this.request<KnowledgeBase>("PATCH", `/v1/kbs/${encodeURIComponent(kbId)}`, { json: patch }),

    /** `DELETE /v1/kbs/:id`. A soft delete: the KB becomes archived. */
    delete: (kbId: string): Promise<DeleteKbResponse> =>
      this.request<DeleteKbResponse>("DELETE", `/v1/kbs/${encodeURIComponent(kbId)}`),

    /**
     * `POST /v1/kbs/:id/query`.
     *
     * The return type follows `mode`: the default is the hybrid rank, and
     * `mode: "v1-tags"` is the pre-v2 tag-filter-then-vector path. Both are
     * served; neither is a reimplementation of the other.
     */
    query: (kbId: string, input: QueryRequest): Promise<QueryResponse> =>
      this.request<QueryResponse>("POST", `/v1/kbs/${encodeURIComponent(kbId)}/query`, {
        json: input,
      }),

    /**
     * `POST /v1/kbs/:id/documents` — the ingest.
     *
     * Three shapes, and they are three different pipelines rather than three
     * spellings of one: `{ file }` uploads bytes as `multipart/form-data` and
     * runs the resumable worker flow over them, `{ url }` has the instance
     * fetch them and do the same, and `{ text }` takes the `ingestDocument`
     * path. Asynchronous in all three: what comes back is a document id and a
     * status to poll, or to wait for on {@link SearchClient.events}.
     *
     * `documentId` is the caller's own id for the document, carried on all
     * three shapes (a form part on the multipart one), and the answer echoes
     * it: the same id twice in one KB is an idempotent re-ingest and the same id
     * in a different KB is a `409`.
     */
    ingest: (kbId: string, input: IngestInput): Promise<IngestResponse> => {
      const path = `/v1/kbs/${encodeURIComponent(kbId)}/documents`;
      if ("file" in input) {
        return this.request<IngestResponse>("POST", path, {
          multipart: ingestFormData(input),
        });
      }
      return this.request<IngestResponse>("POST", path, { json: input });
    },
  };

  readonly documents = {
    /** `GET /v1/kbs/:id/documents`. */
    list: (kbId: string, query: ListDocumentsQuery = {}): Promise<ListDocumentsResponse> =>
      this.request<ListDocumentsResponse>(
        "GET",
        `/v1/kbs/${encodeURIComponent(kbId)}/documents`,
        { query: query as Record<string, string | number | boolean | undefined> },
      ),

    /** `GET /v1/kbs/:id/documents/:docId`. Poll this for `processingStatus`. */
    get: (kbId: string, documentId: string): Promise<SearchDocument> =>
      this.request<SearchDocument>("GET", documentPath(kbId, documentId)),

    /** `PATCH /v1/kbs/:id/documents/:docId`. */
    update: (
      kbId: string,
      documentId: string,
      patch: UpdateDocumentRequest,
    ): Promise<SearchDocument> =>
      this.request<SearchDocument>("PATCH", documentPath(kbId, documentId), { json: patch }),

    /** `DELETE /v1/kbs/:id/documents/:docId`. */
    delete: (kbId: string, documentId: string): Promise<DeleteDocumentResponse> =>
      this.request<DeleteDocumentResponse>("DELETE", documentPath(kbId, documentId)),

    /** `GET …/documents/:docId/chunks`. */
    chunks: (
      kbId: string,
      documentId: string,
      query: ListChunksQuery = {},
    ): Promise<ListChunksResponse> =>
      this.request<ListChunksResponse>("GET", `${documentPath(kbId, documentId)}/chunks`, {
        query: query as Record<string, string | number | boolean | undefined>,
      }),

    /** `PATCH …/chunks/:chunkId`. Changing `content` re-embeds the chunk. */
    updateChunk: (
      kbId: string,
      documentId: string,
      chunkId: string,
      patch: UpdateChunkRequest,
    ): Promise<Chunk> =>
      this.request<Chunk>(
        "PATCH",
        `${documentPath(kbId, documentId)}/chunks/${encodeURIComponent(chunkId)}`,
        { json: patch },
      ),

    /** `DELETE …/chunks/:chunkId`. */
    deleteChunk: (
      kbId: string,
      documentId: string,
      chunkId: string,
    ): Promise<DeleteChunkResponse> =>
      this.request<DeleteChunkResponse>(
        "DELETE",
        `${documentPath(kbId, documentId)}/chunks/${encodeURIComponent(chunkId)}`,
      ),

    /** `POST …/documents/:docId/include` — the searchable-or-not toggle. */
    include: (
      kbId: string,
      documentId: string,
      input: IncludeDocumentRequest,
    ): Promise<IncludeDocumentResponse> =>
      this.request<IncludeDocumentResponse>(
        "POST",
        `${documentPath(kbId, documentId)}/include`,
        { json: input },
      ),

    /** `POST /v1/kbs/:id/documents/upsert` — replace-by-identity, or create. */
    upsert: (kbId: string, input: UpsertDocumentRequest): Promise<UpsertDocumentResponse> =>
      this.request<UpsertDocumentResponse>(
        "POST",
        `/v1/kbs/${encodeURIComponent(kbId)}/documents/upsert`,
        { json: input },
      ),
  };

  readonly keywords = {
    /** `GET /v1/kbs/:id/keywords`. */
    list: async (kbId: string, query: ListKeywordsQuery = {}): Promise<Keyword[]> => {
      const answer = await this.request<ListKeywordsResponse>(
        "GET",
        `/v1/kbs/${encodeURIComponent(kbId)}/keywords`,
        { query: query as Record<string, string | number | boolean | undefined> },
      );
      return answer.keywords;
    },

    /** `PUT /v1/kbs/:id/keywords`. Create, or return the canonical row. */
    put: (kbId: string, input: PutKeywordRequest): Promise<Keyword> =>
      this.request<Keyword>("PUT", `/v1/kbs/${encodeURIComponent(kbId)}/keywords`, {
        json: input,
      }),

    /** `DELETE /v1/kbs/:id/keywords/:keywordId`. */
    delete: (kbId: string, keywordId: string): Promise<DeleteKeywordResponse> =>
      this.request<DeleteKeywordResponse>(
        "DELETE",
        `/v1/kbs/${encodeURIComponent(kbId)}/keywords/${encodeURIComponent(keywordId)}`,
      ),

    /** `POST /v1/kbs/:id/extract-keywords`. Enqueues; does not extract. */
    extract: (kbId: string, input: ExtractKeywordsRequest): Promise<ExtractKeywordsResponse> =>
      this.request<ExtractKeywordsResponse>(
        "POST",
        `/v1/kbs/${encodeURIComponent(kbId)}/extract-keywords`,
        { json: input },
      ),

    /** `PUT …/chunks/:chunkId/keywords` — attach one keyword by hand. */
    attachToChunk: (
      kbId: string,
      documentId: string,
      chunkId: string,
      input: AttachChunkKeywordRequest,
    ): Promise<ChunkKeywordResponse> =>
      this.request<ChunkKeywordResponse>(
        "PUT",
        `${documentPath(kbId, documentId)}/chunks/${encodeURIComponent(chunkId)}/keywords`,
        { json: input },
      ),

    /** `DELETE …/chunks/:chunkId/keywords/:keywordId`. */
    detachFromChunk: (
      kbId: string,
      documentId: string,
      chunkId: string,
      keywordId: string,
    ): Promise<{ id: string; deleted: true }> =>
      this.request(
        "DELETE",
        `${documentPath(kbId, documentId)}/chunks/${encodeURIComponent(chunkId)}` +
          `/keywords/${encodeURIComponent(keywordId)}`,
      ),
  };

  readonly clusters = {
    /** `GET /v1/kbs/:id/clusters`. Centroids only when asked for. */
    list: (kbId: string, query: ListClustersQuery = {}): Promise<ListClustersResponse> =>
      this.request<ListClustersResponse>("GET", `/v1/kbs/${encodeURIComponent(kbId)}/clusters`, {
        query: query as Record<string, string | number | boolean | undefined>,
      }),

    /** `GET /v1/kbs/:id/clustering-status`. */
    status: (kbId: string): Promise<ClusteringStatus> =>
      this.request<ClusteringStatus>(
        "GET",
        `/v1/kbs/${encodeURIComponent(kbId)}/clustering-status`,
      ),

    /** `POST /v1/kbs/:id/recluster`. Enqueues a fit. */
    recluster: (kbId: string): Promise<ReclusterResponse> =>
      this.request<ReclusterResponse>(
        "POST",
        `/v1/kbs/${encodeURIComponent(kbId)}/recluster`,
      ),
  };

  readonly tags = {
    /** `GET /v1/kbs/:id/tag-definitions`. */
    definitions: async (kbId: string): Promise<TagDefinition[]> => {
      const answer = await this.request<ListTagDefinitionsResponse>(
        "GET",
        `/v1/kbs/${encodeURIComponent(kbId)}/tag-definitions`,
      );
      return answer.definitions;
    },

    /** `PUT /v1/kbs/:id/tag-definitions` — the bulk create-or-rename. */
    put: (
      kbId: string,
      input: PutTagDefinitionsRequest,
    ): Promise<PutTagDefinitionsResponse> =>
      this.request<PutTagDefinitionsResponse>(
        "PUT",
        `/v1/kbs/${encodeURIComponent(kbId)}/tag-definitions`,
        { json: input },
      ),

    /** `DELETE /v1/kbs/:id/tag-definitions/:tagId`. */
    delete: (kbId: string, tagId: string): Promise<DeleteTagDefinitionResponse> =>
      this.request<DeleteTagDefinitionResponse>(
        "DELETE",
        `/v1/kbs/${encodeURIComponent(kbId)}/tag-definitions/${encodeURIComponent(tagId)}`,
      ),

    /** `GET /v1/kbs/:id/tag-usage`. */
    usage: async (kbId: string): Promise<TagUsage[]> => {
      const answer = await this.request<TagUsageResponse>(
        "GET",
        `/v1/kbs/${encodeURIComponent(kbId)}/tag-usage`,
      );
      return answer.usage;
    },

    /** `GET /v1/kbs/:id/next-available-slot?fieldType=…`. `null` when full. */
    nextAvailableSlot: (
      kbId: string,
      fieldType: NextAvailableSlotQuery["fieldType"],
    ): Promise<NextAvailableSlotResponse> =>
      this.request<NextAvailableSlotResponse>(
        "GET",
        `/v1/kbs/${encodeURIComponent(kbId)}/next-available-slot`,
        { query: { fieldType } },
      ),
  };

  readonly endpoints = {
    /** `GET /v1/endpoints`. Never carries a key. */
    get: (): Promise<GetEndpointsResponse> =>
      this.request<GetEndpointsResponse>("GET", "/v1/endpoints"),

    /** `PUT /v1/endpoints`. The push, keyed by each endpoint's `externalId`. */
    put: (input: PutEndpointsRequest): Promise<PutEndpointsResponse> =>
      this.request<PutEndpointsResponse>("PUT", "/v1/endpoints", { json: input }),
  };

  readonly webhooks = {
    /** `GET /v1/webhooks`. */
    get: (): Promise<GetWebhookResponse> =>
      this.request<GetWebhookResponse>("GET", "/v1/webhooks"),

    /** `PUT /v1/webhooks`. Replaces the hook, ledger and all. */
    put: (input: PutWebhookRequest): Promise<{ webhook: GetWebhookResponse["webhook"] }> =>
      this.request("PUT", "/v1/webhooks", { json: input }),

    /** `DELETE /v1/webhooks`. */
    delete: (): Promise<DeleteWebhookResponse> =>
      this.request<DeleteWebhookResponse>("DELETE", "/v1/webhooks"),
  };

  /**
   * `GET /v1/events` as an async iterator.
   *
   * Yields one {@link SearchEvent} per `event:`/`data:` frame and swallows the
   * heartbeat comments, so a caller writes `for await (const event of
   * search.events())` and sees only events. Break out of the loop, or abort the
   * signal, to close the connection.
   *
   * In-process on the instance's side: a second Search instance's events do not
   * arrive here. A delivery that has to survive a disconnect is a webhook.
   */
  async *events(options: { signal?: AbortSignal } = {}): AsyncGenerator<SearchEvent> {
    const url = new URL("/v1/events", this.baseUrl);
    const headers: Record<string, string> = { accept: "text/event-stream" };
    if (this.insecureClientId) headers["x-paired-client"] = this.insecureClientId;

    let response;
    try {
      response = await undiciRequest(url, {
        method: "GET",
        dispatcher: this.agent,
        headers,
        // An event stream is idle between events by definition, so the
        // body timeout that protects an ordinary request is exactly wrong here.
        headersTimeout: this.timeoutMs,
        bodyTimeout: 0,
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (err) {
      throw new SearchApiError(
        "unreachable",
        0,
        `GET /v1/events could not be opened: ${err instanceof Error ? err.message : String(err)}`,
        undefined,
        { cause: err },
      );
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      const text = await response.body.text();
      const failure = (safeJson(text) ?? {}) as { code?: unknown; message?: unknown };
      throw new SearchApiError(
        typeof failure.code === "string" ? failure.code : `http-${response.statusCode}`,
        response.statusCode,
        typeof failure.message === "string" ? failure.message : "the event stream was refused",
      );
    }

    let buffered = "";
    for await (const chunk of response.body) {
      buffered += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      let split = buffered.indexOf("\n\n");
      while (split !== -1) {
        const frame = buffered.slice(0, split);
        buffered = buffered.slice(split + 2);
        const event = parseSseFrame(frame);
        if (event) yield event;
        split = buffered.indexOf("\n\n");
      }
    }
  }
}

/** `/v1/kbs/:kbId/documents/:docId`, escaped. */
function documentPath(kbId: string, documentId: string): string {
  return `/v1/kbs/${encodeURIComponent(kbId)}/documents/${encodeURIComponent(documentId)}`;
}

/** What {@link SearchClient.kbs.ingest} takes: bytes, a URL, or text. */
export type IngestInput =
  | (Omit<IngestJsonRequest, "text" | "url"> & {
      /** The bytes. A `Blob`, a `Buffer`, or any `Uint8Array`. */
      file: Blob | Uint8Array;
    })
  | IngestJsonRequest;

/**
 * Build the multipart body for a file ingest.
 *
 * `FormData` and `Blob` are Node's own globals here (they are undici's, which
 * is what this client dispatches through), so no polyfill and no dependency:
 * undici sets the boundary and streams the parts itself.
 */
function ingestFormData(
  input: Omit<IngestJsonRequest, "text" | "url"> & { file: Blob | Uint8Array },
): FormData {
  const form = new FormData();
  const blob =
    input.file instanceof Blob
      ? input.file
      : new Blob([new Uint8Array(input.file)], {
          type: input.mimeType ?? "application/octet-stream",
        });
  form.append("file", blob, input.filename);
  form.append("filename", input.filename);
  if (input.documentId !== undefined) form.append("documentId", input.documentId);
  if (input.mimeType !== undefined) form.append("mimeType", input.mimeType);
  if (input.metadata !== undefined) form.append("metadata", JSON.stringify(input.metadata));
  if (input.includedInKb !== undefined) form.append("includedInKb", String(input.includedInKb));
  for (const [slot, value] of Object.entries(input.tags ?? {})) {
    if (value !== undefined) form.append(slot, String(value));
  }
  return form;
}

/**
 * One SSE frame into an event, or `null` for a comment.
 *
 * Only `data:` is read: the `event:` line repeats what is inside the payload,
 * and trusting the payload means one definition of the event rather than two
 * that can disagree.
 */
function parseSseFrame(frame: string): SearchEvent | null {
  const data = frame
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (data === "") return null;
  try {
    return JSON.parse(data) as SearchEvent;
  } catch {
    return null;
  }
}

/**
 * A `FormData` as the bytes of a `multipart/form-data` body.
 *
 * Deliberately small: the parts this surface sends are a file and a handful of
 * short strings. Every part is written with `content-disposition`, a file part
 * carries its `content-type`, and the boundary is random per request so it
 * cannot appear in the content by coincidence.
 */
async function encodeMultipart(form: FormData): Promise<{ contentType: string; body: Buffer }> {
  const boundary = `----actana-search-${randomBytes(16).toString("hex")}`;
  const parts: Buffer[] = [];
  for (const [name, value] of form.entries()) {
    parts.push(Buffer.from(`--${boundary}\r\n`));
    if (typeof value === "string") {
      parts.push(
        Buffer.from(`content-disposition: form-data; name="${escapeQuotes(name)}"\r\n\r\n`),
      );
      parts.push(Buffer.from(value, "utf8"));
    } else {
      const filename = escapeQuotes(value.name ?? name);
      parts.push(
        Buffer.from(
          `content-disposition: form-data; name="${escapeQuotes(name)}"; filename="${filename}"\r\n` +
            `content-type: ${value.type || "application/octet-stream"}\r\n\r\n`,
        ),
      );
      parts.push(Buffer.from(await value.arrayBuffer()));
    }
    parts.push(Buffer.from("\r\n"));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    body: Buffer.concat(parts),
  };
}

/** A quote inside a part name would end the quoted string early. */
function escapeQuotes(value: string): string {
  return value.replace(/"/g, "%22").replace(/[\r\n]/g, "");
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}
