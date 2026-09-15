// `actana-search kb`, `ingest`, `query`, `status` — the client-side verbs.
//
//   status [--profile <name>] [--json]
//   kb ls | kb create <name> | kb rm <id>
//   ingest <kb> <file>
//   query <kb> "<text>" [--top-k <n>] [--keyword-weight <0..1>]
//
// These run on a **paired** machine: they take the registration blob
// `pair redeem` stored, build an mTLS `SearchClient` from it, and go through the
// SDK. CONTEXT rule 4 — "the SDK is the only way in" — is why there is no
// second HTTP client in this package, and why nothing here knows a route.
//
// **These verbs work.** They call the SDK's typed namespaces (`client.kbs`,
// `client.kbs.ingest`, `client.kbs.query`) against the REST surface TASK-004
// landed. They were written before it existed — the wiring is what TASK-005
// owned — and started working on the merge without being touched, which is what
// writing them against the contract rather than against a route bought.
//
// {@link reportApi} still answers for `not-implemented`, and it is now a
// statement about the *instance* rather than about this build: an older one that
// does not serve a route these verbs call answers with that code, and
// {@link EXIT_UNIMPLEMENTED} is how a script tells "that instance is too old"
// from "you typed it wrong".
//
// `status` is the one that answers "is this credential good?" — `health` and
// `pairStatus`, the first thing anybody asks after pairing.

import { SearchApiError } from "@actana/search/errors";
import type { SearchClient } from "@actana/search/client";
import type { QueryRequest } from "@actana/search/contracts";
import { parseFraction, parseInteger, type ParsedArgs } from "./cli-args.ts";
import { formatJson, formatTable, orDash, relativeTime } from "./cli-output.ts";
import { configDirFor, loadProfileBlob, readCliConfig } from "./cli-config.ts";
import type { SearchCliDeps } from "./cli-deps.ts";
import { EXIT_FAILURE, EXIT_OK, EXIT_UNIMPLEMENTED, EXIT_USAGE } from "./exit-codes.ts";

export const KB_HELP = `actana-search kb — the knowledge bases on a paired instance

These verbs run on a machine that has paired (\`actana-search pair redeem\`).

Usage
  actana-search kb ls [--json]
  actana-search kb create <name> [--json]
  actana-search kb rm <id>

Flags
  --profile <name>   which stored credential to use (default: the last paired)
  --json             machine-readable output
  -h, --help         show this help`;

export const STATUS_HELP = `actana-search status — is this credential good?

Asks the instance for its health and for what this certificate was granted.

Usage
  actana-search status [--profile <name>] [--json]`;

export const INGEST_HELP = `actana-search ingest — put a document into a knowledge base

Usage
  actana-search ingest <kb> <file>

Flags
  --profile <name>   which stored credential to use
  --json             machine-readable output`;

export const QUERY_HELP = `actana-search query — ask a knowledge base

Usage
  actana-search query <kb> "<text>" [--top-k <n>] [--keyword-weight <0..1>]

Flags
  --top-k <n>              how many matches to return (default: the instance's)
  --keyword-weight <0..1>  how much of the score keywords are worth
  --profile <name>         which stored credential to use
  --json                   machine-readable output`;

/**
 * Open a client for the named profile, or say why not.
 *
 * Exported because `endpoint add`/`endpoint ls` are client-side verbs too now
 * that `PUT /v1/endpoints` exists — profile resolution, the mTLS client, the
 * error mapping and the `close()` are the same four lines for all of them, and
 * a second copy in `endpoint-command.ts` is a second place a profile could be
 * resolved differently.
 */
export async function withClient(
  deps: SearchCliDeps,
  flags: ParsedArgs,
  verb: string,
  run: (client: SearchClient) => Promise<number>,
): Promise<number> {
  const configDir = configDirFor(deps.home);
  const loaded = loadProfileBlob(configDir, flags.profile);
  if (!loaded) {
    const config = readCliConfig(configDir);
    const known = Object.keys(config.profiles);
    deps.err(
      `actana-search ${verb}: no credential for profile "${flags.profile ?? config.defaultProfile}".`,
    );
    if (known.length > 0) {
      deps.err(`Profiles on this machine: ${known.join(", ")}.`);
    } else {
      deps.err("Nothing is paired on this machine — run `actana-search pair redeem` first.");
    }
    return EXIT_FAILURE;
  }
  deps.verbose(`Using profile ${loaded.name} → ${loaded.blob.endpoint}`);
  const client = deps.clientFor(loaded.blob);
  try {
    return await run(client);
  } catch (err) {
    return reportApi(deps, verb, err);
  } finally {
    await client.close().catch(() => {});
  }
}

/**
 * Report an SDK failure and pick an exit code.
 *
 * `not-implemented` is the one that gets a paragraph: it is not the operator's
 * mistake and it is not this command being broken, it is the instance not
 * serving that route — so the sentence has to name the instance and say what to
 * do about it.
 */
export function reportApi(deps: SearchCliDeps, verb: string, err: unknown): number {
  if (err instanceof SearchApiError && err.code === "not-implemented") {
    deps.err(`actana-search ${verb}: that instance does not serve this route.`);
    deps.err(
      "This command is wired to the current contract, so the instance is the older half — " +
        "`actana-search status` prints its schema version.",
    );
    return EXIT_UNIMPLEMENTED;
  }
  if (err instanceof SearchApiError) {
    deps.err(`actana-search ${verb}: ${err.message}`);
    if (err.code === "unreachable") {
      deps.err("The instance did not answer. Check it is running and reachable from here.");
    }
    if (err.status === 403) {
      deps.err("This certificate's scope does not cover that. `pair ls` on the instance shows it.");
    }
    return EXIT_FAILURE;
  }
  deps.err(`actana-search ${verb}: ${err instanceof Error ? err.message : String(err)}`);
  return EXIT_FAILURE;
}

// ─── status ─────────────────────────────────────────────────────────────────

export async function runStatusCommand(
  deps: SearchCliDeps,
  flags: ParsedArgs,
): Promise<number> {
  if (flags.help) {
    deps.out(STATUS_HELP);
    return EXIT_OK;
  }
  return withClient(deps, flags, "status", async (client) => {
    const health = await client.health();
    const pair = await client.pairStatus();
    if (flags.json) {
      deps.out(formatJson({ endpoint: client.baseUrl, health, pair }));
      return EXIT_OK;
    }
    deps.out(`Instance       ${client.baseUrl}`);
    deps.out(`Health         ${health.ok ? "ok" : "not ok"} (schema ${health.schemaVersion})`);
    const status = pair as unknown as Record<string, unknown>;
    deps.out(`Client         ${orDash(status.id as string)}`);
    deps.out(`Label          ${orDash(status.label as string)}`);
    deps.out(`Scope          ${orDash(status.scope as string)}`);
    const kbIds = status.kbIds as string[] | null | undefined;
    deps.out(`Knowledge bases ${kbIds?.length ? kbIds.join(", ") : "all"}`);
    if (typeof status.certNotAfter === "string") {
      deps.out(
        `Certificate    expires ${relativeTime(status.certNotAfter, deps.now())}`,
      );
    }
    return EXIT_OK;
  });
}

// ─── kb ─────────────────────────────────────────────────────────────────────

export async function runKbCommand(
  deps: SearchCliDeps,
  flags: ParsedArgs,
  rest: string[],
): Promise<number> {
  const verb = rest[0];
  if (verb === undefined || flags.help) {
    deps.out(KB_HELP);
    return verb === undefined ? EXIT_USAGE : EXIT_OK;
  }

  switch (verb) {
    case "ls":
    case "list":
      return withClient(deps, flags, "kb ls", async (client) => {
        const result = (await client.kbs.list()) as unknown as {
          kbs?: Array<Record<string, unknown>>;
        };
        const kbs = result?.kbs ?? [];
        if (flags.json) {
          deps.out(formatJson(kbs));
          return EXIT_OK;
        }
        if (kbs.length === 0) {
          deps.out("No knowledge bases.");
          return EXIT_OK;
        }
        for (const line of formatTable(
          ["ID", "NAME", "DOCUMENTS", "CHUNKS"],
          kbs.map((kb) => [
            String(kb.id ?? ""),
            String(kb.name ?? ""),
            orDash(kb.documentCount as number),
            orDash(kb.chunkCount as number),
          ]),
        )) {
          deps.out(line);
        }
        return EXIT_OK;
      });

    case "create": {
      const name = rest[1];
      if (!name) {
        deps.err("actana-search kb create: give the knowledge base a name.");
        return EXIT_USAGE;
      }
      return withClient(deps, flags, "kb create", async (client) => {
        const kb = (await client.kbs.create({ name })) as unknown as Record<string, unknown>;
        deps.out(flags.json ? formatJson(kb) : `Created ${String(kb.id)} (${name}).`);
        return EXIT_OK;
      });
    }

    case "rm":
    case "delete": {
      const id = rest[1];
      if (!id) {
        deps.err("actana-search kb rm: name the knowledge base to delete.");
        return EXIT_USAGE;
      }
      return withClient(deps, flags, "kb rm", async (client) => {
        await client.kbs.delete(id);
        deps.out(flags.json ? formatJson({ deleted: id }) : `Deleted ${id}.`);
        return EXIT_OK;
      });
    }

    default:
      deps.err(`actana-search kb: unknown verb "${verb}".`);
      deps.err("Verbs: ls, create, rm.");
      return EXIT_USAGE;
  }
}

// ─── ingest ─────────────────────────────────────────────────────────────────

export async function runIngestCommand(
  deps: SearchCliDeps,
  flags: ParsedArgs,
  rest: string[],
): Promise<number> {
  if (flags.help) {
    deps.out(INGEST_HELP);
    return EXIT_OK;
  }
  const [kbId, file] = rest;
  if (!kbId || !file) {
    deps.err("actana-search ingest: give a knowledge base and a file.");
    deps.err("  actana-search ingest my-kb ./handbook.md");
    return EXIT_USAGE;
  }

  let bytes: Buffer;
  try {
    bytes = await deps.readFile(file);
  } catch (err) {
    deps.err(`actana-search ingest: ${file} could not be read.`);
    deps.err(err instanceof Error ? err.message : String(err));
    return EXIT_FAILURE;
  }
  const filename = file.split("/").pop() || file;

  return withClient(deps, flags, "ingest", async (client) => {
    const result = (await client.kbs.ingest(kbId, {
      filename,
      // The bytes as text, which is what this verb does: the SDK's multipart
      // branch (`{ file }`) and the route behind it both exist, and reaching
      // for them from here is a change to what `ingest` *is* rather than a
      // doc fix — a PDF read as UTF-8 is a document nobody wants ingested, so
      // it wants the refusal that goes with it.
      text: bytes.toString("utf8"),
    })) as unknown as Record<string, unknown>;
    deps.out(
      flags.json
        ? formatJson(result)
        : `Ingesting ${filename} → ${String(result.documentId)} (${String(result.processingStatus)}).`,
    );
    return EXIT_OK;
  });
}

// ─── query ──────────────────────────────────────────────────────────────────

export async function runQueryCommand(
  deps: SearchCliDeps,
  flags: ParsedArgs,
  rest: string[],
): Promise<number> {
  if (flags.help) {
    deps.out(QUERY_HELP);
    return EXIT_OK;
  }
  const [kbId, ...words] = rest;
  const text = words.join(" ").trim();
  if (!kbId || !text) {
    deps.err("actana-search query: give a knowledge base and something to ask.");
    deps.err('  actana-search query my-kb "parental leave policy"');
    return EXIT_USAGE;
  }

  // Typed as the contract's request rather than a bag: the SDK's `query` takes
  // `QueryRequest` now that TASK-004's surface exists, and a `Record` would
  // have made "did the CLI send a field this instance reads?" unanswerable.
  const body: QueryRequest = { text };
  if (flags.topK) {
    const parsed = parseInteger(flags.topK, "--top-k");
    if ("error" in parsed) {
      deps.err(`actana-search query: ${parsed.error}.`);
      return EXIT_USAGE;
    }
    body.topK = parsed.value;
  }
  if (flags.keywordWeight) {
    const parsed = parseFraction(flags.keywordWeight, "--keyword-weight");
    if ("error" in parsed) {
      deps.err(`actana-search query: ${parsed.error}.`);
      return EXIT_USAGE;
    }
    body.keywordWeight = parsed.value;
  }

  return withClient(deps, flags, "query", async (client) => {
    const result = (await client.kbs.query(kbId, body)) as unknown as {
      matches?: Array<Record<string, unknown>>;
    };
    if (flags.json) {
      deps.out(formatJson(result));
      return EXIT_OK;
    }
    const matches = result?.matches ?? [];
    if (matches.length === 0) {
      deps.out("No matches.");
      return EXIT_OK;
    }
    for (const line of formatTable(
      ["SCORE", "DOCUMENT", "CHUNK", "TEXT"],
      matches.map((m) => [
        typeof m.score === "number" ? m.score.toFixed(4) : orDash(m.score as string),
        String(m.documentName ?? m.documentId ?? ""),
        orDash(m.chunkIndex as number),
        // One line each: a table whose cells wrap is a table nothing can read.
        String(m.content ?? "").replace(/\s+/g, " ").slice(0, 96),
      ]),
    )) {
      deps.out(line);
    }
    return EXIT_OK;
  });
}
