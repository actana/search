// `actana-search endpoint` — the model a knowledge base embeds and reasons with.
//
//   endpoint add --kind embedding|inference --provider <p> --model <m>
//                [--template <t>] [--dimensions <n>] [--base-url <u>]
//                [--label <l>] [--client <id>] --key-stdin
//   endpoint ls [--client <id>] [--json]
//
// **The key comes in on stdin and nowhere else.** `--key-stdin` is a flag, not a
// value, because an API key passed as an argument is in `ps`, in the shell
// history, and in every process listing on the machine for as long as the
// command runs. A pipe is in none of them. There is deliberately no `--key`.
//
// **These talk to the admin Unix socket, so they run on the instance** — see
// `admin-client.ts` and ADR 0008 D6. That is a stopgap and it is marked as one
// in `packages/search/src/api/admin-server.ts`: registering an endpoint is an
// authenticated `PUT /v1/endpoints` over mTLS once TASK-004 lands, and this verb
// moves to it then. What does not change is the shape — one contract, two
// sources (ADR 0004) — so an endpoint registered through the socket today is the
// same row `PUT /v1/endpoints` writes tomorrow.
//
// **A mirrored endpoint is not added here at all.** In wired mode the catalog is
// a mirror the paired client pushes and the key never crosses; there is no
// operator gesture for it, and an `endpoint add --mirrored` would be a way to
// create a row the client would immediately overwrite.

import { createAdminEndpoint, listAdminEndpoints } from "./admin-client.ts";
import { parseInteger, type ParsedArgs } from "./cli-args.ts";
import { formatJson, formatTable, orDash } from "./cli-output.ts";
import type { SearchCliDeps } from "./cli-deps.ts";
import { reportAdmin, socketFor } from "./pair-command.ts";
import { EXIT_OK, EXIT_USAGE } from "./exit-codes.ts";

export const ENDPOINT_HELP = `actana-search endpoint — the models a knowledge base uses

These verbs run ON THE INSTANCE, through its admin Unix socket.

Usage
  actana-search endpoint add --kind embedding --provider openai \\
      --model text-embedding-3-small --dimensions 1536 --key-stdin
  actana-search endpoint ls [--client <id>] [--json]

Flags
  --kind <k>          embedding or inference
  --provider <id>     openai, voyage, google, cohere, mistral, …
  --template <id>     the request shape, when it differs from the provider name
  --model <name>      the provider-side model
  --dimensions <n>    vector width — required for an embedding endpoint
  --base-url <url>    an OpenAI-compatible endpoint behind another URL
  --label <name>      what to call it in a listing
  --client <id>       which paired client it belongs to (only needed when
                      more than one is paired)
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
  When a paired client mirrors its own catalog (PUT /v1/endpoints), its
  endpoints appear here as \`mirrored\` and have no key on this side at all: the
  instance asks that client's resolver for one per job and forgets it within a
  minute. There is nothing to add by hand.`;

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

  const client = deps.adminClient(socketFor(deps, flags));
  try {
    const { endpoint } = await createAdminEndpoint(client, {
      ...(flags.client ? { pairedClientId: flags.client } : {}),
      kind,
      provider: flags.provider,
      ...(flags.template ? { template: flags.template } : {}),
      model: flags.model,
      ...(dimensions === null ? {} : { dimensions }),
      ...(flags.baseUrl ? { baseUrl: flags.baseUrl } : {}),
      ...(flags.label ? { label: flags.label } : {}),
      apiKey,
    });
    if (flags.json) {
      deps.out(formatJson(endpoint));
      return EXIT_OK;
    }
    deps.out(`Registered ${endpoint.kind} endpoint ${endpoint.id}.`);
    deps.out(`Provider       ${endpoint.provider} (${endpoint.template})`);
    deps.out(`Model          ${orDash(endpoint.model)}`);
    if (endpoint.dimensions) deps.out(`Dimensions     ${endpoint.dimensions}`);
    deps.err("The key is sealed on the instance and will not be printed back.");
    return EXIT_OK;
  } catch (err) {
    return reportAdmin(deps, "endpoint add", err);
  }
}

async function endpointLs(deps: SearchCliDeps, flags: ParsedArgs): Promise<number> {
  const client = deps.adminClient(socketFor(deps, flags));
  try {
    const result = await listAdminEndpoints(client, flags.client);
    if (flags.json) {
      deps.out(formatJson(result));
      return EXIT_OK;
    }
    if (result.endpoints.length === 0) {
      deps.out(`No endpoints are registered for ${result.pairedClientId}.`);
      return EXIT_OK;
    }
    for (const line of formatTable(
      ["ID", "KIND", "PROVIDER", "MODEL", "DIMS", "SOURCE", "KEY"],
      result.endpoints.map((e) => [
        e.id,
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
  } catch (err) {
    return reportAdmin(deps, "endpoint ls", err);
  }
}
