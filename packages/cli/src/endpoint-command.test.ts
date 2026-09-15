/**
 * `endpoint add` — and what it sends about the endpoints it is *not* adding.
 *
 * `PUT /v1/endpoints` is declarative: the body is the set the client wants to
 * exist, and anything left out of it is reconciled away. So `add` is a
 * read-modify-write, and the re-declared rows are the part worth a test —
 * because a mistake there edits endpoints the operator did not name.
 *
 * The one this suite exists for: `model` and `label` fell back to `provider`
 * when a row had neither, so every `endpoint add` silently rewrote the `model`
 * of every other model-less endpoint on the instance to the string `openai`. A
 * model is the field that decides what a stored vector means; a push that
 * changes it changes what a corpus is.
 *
 * The client is a stub rather than a server: what is under test is the body
 * this verb builds, which is an argument to `endpoints.put`.
 *
 * @vitest-environment node
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SearchClient } from "@actana/search/client";
import type {
  Endpoint,
  GetEndpointsResponse,
  PutEndpointsRequest,
} from "@actana/search/contracts";
import type { SearchRegistrationBlob } from "@actana/search/registration-blob";
import { runSearchCli } from "./cli.ts";
import { configDirFor, DEFAULT_PROFILE, saveProfile } from "./cli-config.ts";
import type { SearchCliDeps } from "./cli-deps.ts";
import { EXIT_FAILURE, EXIT_OK } from "./exit-codes.ts";

const blob: SearchRegistrationBlob = {
  endpoint: "https://search.internal:7443",
  label: "laptop",
  caCert: "-----BEGIN CERTIFICATE-----\nca\n-----END CERTIFICATE-----",
  clientCert: "-----BEGIN CERTIFICATE-----\nclient\n-----END CERTIFICATE-----",
  clientKey: "-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----",
  bearer: "inert",
};

/** An endpoint as `GET /v1/endpoints` answers it, with the nulls it may carry. */
function endpoint(over: Partial<Endpoint> = {}): Endpoint {
  return {
    id: "ep-1",
    externalId: "cli-embedding-openai-text-embedding-3-small",
    kind: "embedding",
    provider: "openai",
    template: "openai",
    model: "text-embedding-3-small",
    dimensions: 1536,
    baseUrl: null,
    label: "primary",
    source: "local",
    hasKey: true,
    config: {},
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...over,
  };
}

let home: string;
let pushed: PutEndpointsRequest[];
let listed: GetEndpointsResponse;

/** A `SearchClient` with only the two methods this verb calls. */
function stubClient(): SearchClient {
  return {
    baseUrl: blob.endpoint,
    endpoints: {
      get: async () => listed,
      put: async (body: PutEndpointsRequest) => {
        pushed.push(body);
        return {
          endpoints: body.endpoints.map((e, i) => ({ id: `ep-new-${i}`, externalId: e.externalId })),
        };
      },
    },
    close: async () => {},
  } as unknown as SearchClient;
}

function deps(argv: string[], stdin = "sk-a-provider-key-0123456789") {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    argv,
    env: {} as NodeJS.ProcessEnv,
    home,
    out: (line: string) => void stdout.push(line),
    err: (line: string) => void stderr.push(line),
    verbose: () => {},
    now: () => Date.parse("2026-09-15T12:00:00.000Z"),
    stdoutIsTty: false,
    readStdin: async () => stdin,
    readFile: async () => Buffer.from(""),
    adminClient: () => {
      throw new Error("not used by these verbs");
    },
    pair: async () => {
      throw new Error("not used by these verbs");
    },
    clientFor: () => stubClient(),
    stdout,
    stderr,
  } satisfies SearchCliDeps & { stdout: string[]; stderr: string[] };
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "actana-search-endpoint-"));
  saveProfile(configDirFor(home), DEFAULT_PROFILE, blob);
  pushed = [];
  listed = { source: { kind: "local" }, endpoints: [] };
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

const ADD = [
  "endpoint",
  "add",
  "--kind",
  "embedding",
  "--provider",
  "voyage",
  "--model",
  "voyage-3",
  "--dimensions",
  "1024",
  "--key-stdin",
];

describe("endpoint add", () => {
  it("pushes the declared endpoint beside the set that is already there", async () => {
    listed = { source: { kind: "local" }, endpoints: [endpoint()] };
    const d = deps(ADD);

    expect(await runSearchCli(d)).toBe(EXIT_OK);
    expect(pushed).toHaveLength(1);
    expect(pushed[0]!.endpoints).toHaveLength(2);
    // The existing row, exactly as it is — and with no `apiKey`, which is what
    // leaves its sealed ciphertext alone.
    expect(pushed[0]!.endpoints[0]).toEqual({
      externalId: "cli-embedding-openai-text-embedding-3-small",
      kind: "embedding",
      provider: "openai",
      template: "openai",
      model: "text-embedding-3-small",
      dimensions: 1536,
      label: "primary",
      config: {},
    });
    expect(pushed[0]!.endpoints[0]).not.toHaveProperty("apiKey");
    // And the new one, with the key that arrived on stdin.
    expect(pushed[0]!.endpoints[1]).toMatchObject({
      kind: "embedding",
      provider: "voyage",
      model: "voyage-3",
      dimensions: 1024,
      apiKey: "sk-a-provider-key-0123456789",
    });
  });

  /**
   * The finding. `model: endpoint.model ?? endpoint.provider` and the same for
   * `label` read as harmless defaults and are not: they are an edit to a row
   * the operator did not mention, sent under the `externalId` that makes the
   * push an upsert onto it.
   */
  it("refuses rather than inventing a model for an endpoint that has none", async () => {
    listed = {
      source: { kind: "local" },
      endpoints: [endpoint({ id: "ep-modelless", externalId: "pushed-by-studio", model: null })],
    };
    const d = deps(ADD);

    expect(await runSearchCli(d)).toBe(EXIT_FAILURE);
    // Nothing was sent: a set this verb cannot describe faithfully is a set it
    // must not push.
    expect(pushed).toEqual([]);
    const stderr = d.stderr.join("\n");
    expect(stderr).toContain("cannot be re-declared");
    expect(stderr).toContain("ep-modelless");
    expect(stderr).toContain("--model");
    expect(stderr).not.toContain("--label");
  });

  it("refuses for a missing label too, and names both when both are missing", async () => {
    listed = {
      source: { kind: "local" },
      endpoints: [endpoint({ id: "ep-bare", model: null, label: null })],
    };
    const d = deps(ADD);

    expect(await runSearchCli(d)).toBe(EXIT_FAILURE);
    expect(pushed).toEqual([]);
    expect(d.stderr.join("\n")).toContain("has no --model and no --label");
  });

  it("re-declares a row with a null dimension and a base URL faithfully", async () => {
    // An inference endpoint carries no `dimensions` at all — the contract
    // refuses the pair — and a `baseUrl` is a value, not a default.
    listed = {
      source: { kind: "local" },
      endpoints: [
        endpoint({
          id: "ep-inference",
          externalId: "studio-inference",
          kind: "inference",
          dimensions: null,
          baseUrl: "https://llm.example/v1",
          template: "openai-compatible",
          model: "gpt-4o",
          label: "the reasoner",
          config: { extras: { apiVersion: "2024-02-01" } },
        }),
      ],
    };
    const d = deps(ADD);

    expect(await runSearchCli(d)).toBe(EXIT_OK);
    expect(pushed[0]!.endpoints[0]).toEqual({
      externalId: "studio-inference",
      kind: "inference",
      provider: "openai",
      template: "openai-compatible",
      model: "gpt-4o",
      baseUrl: "https://llm.example/v1",
      label: "the reasoner",
      config: { extras: { apiVersion: "2024-02-01" } },
    });
  });

  it("leaves a row with no externalId out, rather than pushing one it cannot key", async () => {
    // The admin socket's path, which predates the route: unreconciled, and the
    // route leaves it alone for the same reason.
    listed = {
      source: { kind: "local" },
      endpoints: [endpoint({ id: "ep-unkeyed", externalId: null, model: null })],
    };
    const d = deps(ADD);

    // Not a refusal: a row that cannot be re-declared at all is not a row this
    // push is claiming anything about.
    expect(await runSearchCli(d)).toBe(EXIT_OK);
    expect(pushed[0]!.endpoints).toHaveLength(1);
    expect(pushed[0]!.endpoints[0]).toMatchObject({ provider: "voyage" });
  });

  it("refuses to write a key on a client that mirrors its own catalog", async () => {
    listed = {
      source: { kind: "mirrored", resolverUrl: "https://studio.example/resolve", resolverScope: null },
      endpoints: [],
    };
    const d = deps(ADD);

    expect(await runSearchCli(d)).toBe(EXIT_FAILURE);
    expect(pushed).toEqual([]);
    expect(d.stderr.join("\n")).toContain("mirrors its own catalog");
  });
});
