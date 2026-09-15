// `actana-search endpoint` — the model a knowledge base embeds and reasons with.
//
//   endpoint add --kind embedding|inference --provider <p> --model <m>
//                [--template <t>] [--dimensions <n>] [--base-url <u>]
//                [--label <l>] [--external-id <id>] [--profile <name>]
//                --key-stdin
//   endpoint ls [--profile <name>] [--json]
//
// **The key comes in on stdin and nowhere else.** `--key-stdin` is a flag, not a
// value, because an API key passed as an argument is in `ps`, in the shell
// history, and in every process listing on the machine for as long as the
// command runs. A pipe is in none of them. There is deliberately no `--key`.
//
// **These are client-side verbs, over mTLS through the SDK** — `GET` and
// `PUT /v1/endpoints`, with the redeemed profile as the credential (CONTEXT
// rule 4). They went through the admin Unix socket for exactly as long as there
// was no authenticated route to reach: TASK-005 landed the registry before
// TASK-004 landed `PUT /v1/endpoints`, and `POST /admin/endpoints` was the
// stopgap that let an operator give a standalone instance an embedding key at
// all. Both are gone. The row is the same row either way — one contract, two
// sources (ADR 0004) — and the client's own certificate is now what says which
// paired client the endpoint belongs to, which is why there is no `--client`
// any more: an operator cannot register an endpoint against somebody else's
// client by mistyping an id.
//
// **`PUT /v1/endpoints` is declarative, so `add` is a read-modify-write.** The
// body is the set of endpoints the client wants to exist, and anything left out
// of it is reconciled away (unless a KB is bound to it). So `add` reads the
// current set, appends to it, and pushes the whole thing back. The endpoints
// already there are re-declared **without** their keys, which the registry
// reads as "said nothing about it" and leaves the sealed ciphertext alone —
// that property is what makes this verb safe rather than a way to blank every
// key on the instance.
//
// **A mirrored endpoint is not added here at all.** In wired mode the catalog is
// a mirror the paired client pushes and the key never crosses; there is no
// operator gesture for it, and an `endpoint add` against a client that has
// declared a resolver would be writing a row that client is about to overwrite.
// It is refused with the sentence rather than attempted.

import type { EndpointDeclaration, GetEndpointsResponse } from "@actana/search/contracts";
import type { SearchClient } from "@actana/search/client";
import { parseInteger, type ParsedArgs } from "./cli-args.ts";
import { formatJson, formatTable, orDash } from "./cli-output.ts";
import type { SearchCliDeps } from "./cli-deps.ts";
import { withClient } from "./kb-command.ts";
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE } from "./exit-codes.ts";

export const ENDPOINT_HELP = `actana-search endpoint — the models a knowledge base uses

These verbs run on a machine that has paired (\`actana-search pair redeem\`).
The endpoint belongs to the paired client the certificate identifies.

Usage
  actana-search endpoint add --kind embedding --provider openai \\
      --model text-embedding-3-small --dimensions 1536 --key-stdin
  actana-search endpoint ls [--profile <name>] [--json]

Flags
  --kind <k>          embedding or inference
  --provider <id>     openai, voyage, google, cohere, mistral, …
  --template <id>     the request shape, when it differs from the provider name
  --model <name>      the provider-side model
  --dimensions <n>    vector width — required for an embedding endpoint
  --base-url <url>    an OpenAI-compatible endpoint behind another URL
  --label <name>      what to call it in a listing
  --external-id <id>  your own stable id for it, which is what a later push
                      updates rather than duplicating (default: derived from
                      the kind, the provider and the model)
  --profile <name>    which stored credential to use (default: the last paired)
  --key-stdin         read the provider key from stdin. The ONLY way to pass
                      one: an argument would be in ps and in the shell history
  --json              machine-readable output
  -h, --help          show this help

Passing the key
  echo -n "$OPENAI_API_KEY" | actana-search endpoint add --kind embedding \\
    --provider openai --model text-embedding-3-small --dimensions 1536 --key-stdin

  The key is sealed with SEARCH_ENCRYPTION_KEY on the instance and is never
  printed back — \`endpoint ls\` reports whether a row has one, not what it is.

Wired instances
  When this client mirrors its own catalog (PUT /v1/endpoints with a
  \`mirrored\` source), its endpoints have no key on this side at all: the
  instance asks the client's resolver for one per job and forgets it within a
  minute. There is nothing to add by hand, and \`endpoint add\` says so rather
  than writing a row the next push would replace.`;

export async function runEndpointCommand(
  deps: SearchCliDeps,
  flags: ParsedArgs,
  rest: string[],
): Promise<number> {
  const verb = rest[0];
  if (verb === undefined || flags.help) {
    deps.out(ENDPOINT_HELP);
    return verb === undefined ? EXIT_USAGE : EXIT_OK;
  }
  switch (verb) {
    case "add":
      return endpointAdd(deps, flags);
    case "ls":
    case "list":
      return endpointLs(deps, flags);
    default:
      deps.err(`actana-search endpoint: unknown verb "${verb}".`);
      deps.err("Verbs: add, ls.");
      return EXIT_USAGE;
  }
}

/**
 * An endpoint this client already has, as a declaration to push back.
 *
 * **No `apiKey`.** A sealed key stays sealed precisely because this says
 * nothing about it (`models/endpoint-registry.ts`), and a row the instance
 * resolves through a mirror has no key here to say anything about.
 */
function redeclare(endpoint: GetEndpointsResponse["endpoints"][number]): EndpointDeclaration {
  return {
    externalId: endpoint.externalId!,
    kind: endpoint.kind,
    provider: endpoint.provider,
    template: endpoint.template,
    model: endpoint.model ?? endpoint.provider,
    ...(endpoint.dimensions === null ? {} : { dimensions: endpoint.dimensions }),
    ...(endpoint.baseUrl === null ? {} : { baseUrl: endpoint.baseUrl }),
    label: endpoint.label ?? endpoint.provider,
    config: endpoint.config,
  };
}

/**
 * A stable id for an endpoint the operator did not name one for.
 *
 * Derived rather than random, so running the same `endpoint add` twice updates
 * one row instead of accumulating them — which is the same property the push
 * from a wired client relies on.
 */
function derivedExternalId(kind: string, provider: string, model: string): string {
  return `cli-${[kind, provider, model].join("-")}`
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 200);
}

async function endpointAdd(deps: SearchCliDeps, flags: ParsedArgs): Promise<number> {
  const kind = flags.kind;
  if (kind !== "embedding" && kind !== "inference") {
    deps.err("actana-search endpoint add: --kind is embedding or inference.");
    return EXIT_USAGE;
  }
  if (!flags.provider) {
    deps.err("actana-search endpoint add: --provider is required (openai, voyage, google, …).");
    return EXIT_USAGE;
  }
  if (!flags.model) {
    deps.err("actana-search endpoint add: --model is required.");
    return EXIT_USAGE;
  }

  let dimensions: number | null = null;
  if (flags.dimensions) {
    const parsed = parseInteger(flags.dimensions, "--dimensions");
    if ("error" in parsed) {
      deps.err(`actana-search endpoint add: ${parsed.error}.`);
      return EXIT_USAGE;
    }
    dimensions = parsed.value;
  }
  if (kind === "embedding" && dimensions === null) {
    deps.err("actana-search endpoint add: an embedding endpoint needs --dimensions.");
    deps.err("A knowledge base's vector column is sized from it and cannot be created without one.");
    return EXIT_USAGE;
  }
  if (kind === "inference" && dimensions !== null) {
    // The contract refuses the pair, so say so here rather than as a 400.
    deps.err("actana-search endpoint add: --dimensions is for an embedding endpoint.");
    return EXIT_USAGE;
  }

  if (!flags.keyStdin) {
    deps.err("actana-search endpoint add: pass the provider key with --key-stdin.");
    deps.err("  echo -n \"$OPENAI_API_KEY\" | actana-search endpoint add … --key-stdin");
    deps.err("There is no --key flag: an argument is in ps and in the shell history.");
    return EXIT_USAGE;
  }
  // Trimmed, because a key piped from `echo` without `-n` carries a newline and
  // a provider answers 401 to a key with a newline in it.
  const apiKey = (await deps.readStdin()).trim();
  if (!apiKey) {
    deps.err("actana-search endpoint add: nothing arrived on stdin.");
    return EXIT_USAGE;
  }

  const externalId =
    flags.externalId?.trim() || derivedExternalId(kind, flags.provider, flags.model);
  const declaration: EndpointDeclaration = {
    externalId,
    kind,
    provider: flags.provider,
    template: flags.template || flags.provider,
    model: flags.model,
    ...(dimensions === null ? {} : { dimensions }),
    ...(flags.baseUrl ? { baseUrl: flags.baseUrl } : {}),
    label: flags.label || `${flags.provider} ${flags.model}`,
    apiKey,
  };

  return withClient(deps, flags, "endpoint add", async (client: SearchClient) => {
    const current = await client.endpoints.get();
    if (current.source.kind === "mirrored") {
      deps.err("actana-search endpoint add: this client mirrors its own catalog.");
      deps.err(
        `Its endpoints come from the resolver at ${current.source.resolverUrl}, and the ` +
          "instance never holds a key for them.",
      );
      deps.err("Register the endpoint with that client and let it push, or declare a local source.");
      return EXIT_FAILURE;
    }

    // The set as it is, minus the one being declared, plus it. A row with no
    // `externalId` cannot be re-declared and is left alone by the route's
    // reconciliation for the same reason.
    const kept = current.endpoints
      .filter((e) => e.externalId !== null && e.externalId !== externalId)
      .map(redeclare);

    const { endpoints } = await client.endpoints.put({
      source: { kind: "local" },
      endpoints: [...kept, declaration],
    });
    const written = endpoints.find((e) => e.externalId === externalId);

    if (flags.json) {
      deps.out(formatJson({ endpoint: written ?? null, externalId }));
      return EXIT_OK;
    }
    deps.out(`Registered ${kind} endpoint ${written?.id ?? "(id not returned)"}.`);
    deps.out(`External id    ${externalId}`);
    deps.out(`Provider       ${flags.provider} (${declaration.template})`);
    deps.out(`Model          ${flags.model}`);
    if (dimensions !== null) deps.out(`Dimensions     ${dimensions}`);
    deps.err("The key is sealed on the instance and will not be printed back.");
    return EXIT_OK;
  });
}

async function endpointLs(deps: SearchCliDeps, flags: ParsedArgs): Promise<number> {
  return withClient(deps, flags, "endpoint ls", async (client: SearchClient) => {
    const result = await client.endpoints.get();
    if (flags.json) {
      deps.out(formatJson(result));
      return EXIT_OK;
    }
    if (result.source.kind === "mirrored") {
      deps.out(`Keys are mirrored from ${result.source.resolverUrl}`);
      deps.out(`Resolver scope ${orDash(result.source.resolverScope)}`);
    } else {
      deps.out("Keys are held by this instance (local).");
    }
    if (result.endpoints.length === 0) {
      deps.out("No endpoints are registered for this client.");
      return EXIT_OK;
    }
    for (const line of formatTable(
      ["ID", "EXTERNAL ID", "KIND", "PROVIDER", "MODEL", "DIMS", "SOURCE", "KEY"],
      result.endpoints.map((e) => [
        e.id,
        orDash(e.externalId),
        e.kind,
        e.provider,
        orDash(e.model),
        orDash(e.dimensions),
        e.source,
        e.hasKey ? "yes" : "no",
      ]),
    )) {
      deps.out(line);
    }
    return EXIT_OK;
  });
}
