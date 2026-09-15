// `actana-search` — dispatch.
//
// One function, every side effect injected, an exit code returned rather than
// `process.exit` called (`cli-deps.ts`). `index.ts` is the only file in this
// package that knows about `process`, which is what makes every verb, every
// flag refusal and every exit code reachable from a unit test without a
// subprocess.
//
// **Two machines, one command.** `pair new|ls|revoke` run on the machine that IS
// the instance and reach it through a 0600 Unix socket; `pair redeem`,
// `status`, `endpoint`, `kb`, `ingest` and `query` run on a paired machine and
// go over mTLS through `@actana/search`. The help says which is which on every
// verb, because the only thing separating them is which words an operator
// types. `endpoint` was on the first list until `PUT /v1/endpoints` existed to
// put it on the second.

import { SEARCH_PROTOCOL_VERSION } from "@actana/search/index";
import { parseArgs, type ParsedArgs } from "./cli-args.ts";
import type { SearchCliDeps } from "./cli-deps.ts";
import { ENDPOINT_HELP, runEndpointCommand } from "./endpoint-command.ts";
import {
  INGEST_HELP,
  KB_HELP,
  QUERY_HELP,
  runIngestCommand,
  runKbCommand,
  runQueryCommand,
  runStatusCommand,
  STATUS_HELP,
} from "./kb-command.ts";
import { PAIR_HELP, runPairCommand } from "./pair-command.ts";
import { EXIT_OK, EXIT_USAGE } from "./exit-codes.ts";

export { SEARCH_PROTOCOL_VERSION };

export const HELP = `actana-search — pair with a Search instance, and use it

Usage
  actana-search <noun> <verb> [flags]

On the instance (through its admin Unix socket, mode 0600)
  pair new [--label <n>] [--scope <s>] [--kbs <a,b>] [--ttl <d>]
                              mint a one-time pairing code and print it
  pair ls [--json]            pending codes, and the clients already paired
  pair revoke <id>            unpair a client, or cancel a pending code

On a paired machine (mTLS, through @actana/search)
  pair redeem <address> <ticket> [--fingerprint <fp>] [--profile <name>]
                              spend a code and store the credential
  status [--json]             is this credential good, and what does it grant
  endpoint add --kind <k> --provider <p> --model <m> --key-stdin
                              register a model endpoint with a literal key
  endpoint ls [--json]        the endpoints this client has, and where their
                              keys come from
  kb ls | kb create <name> | kb rm <id>
  ingest <kb> <file>          put a document into a knowledge base
  query <kb> "<text>" [--top-k <n>] [--keyword-weight <0..1>]

Flags
  --profile <name>      which stored credential to use (default: last paired)
  --admin-socket <path> the instance's admin socket, overriding
                        SEARCH_ADMIN_SOCKET and $SEARCH_STATE_DIR/admin.sock
  --json                machine-readable output. Every listing honours it
  --verbose             explain the steps, on stderr
  -h, --help            show this help; \`<noun> --help\` shows the noun's
  -V, -v, --version     print the version

Getting started
  On the instance:   actana-search pair new --label laptop
  On the laptop:     actana-search pair redeem <host>:7443 <ticket> \\
                       --fingerprint <the fingerprint it printed>
                     actana-search status

Nothing this command prints is a provider key, and nothing it accepts as an
argument is one — \`endpoint add\` reads a key from stdin (--key-stdin) so it is
never in ps or in a shell history.`;

/** Nouns that take a verb after them. */
const NOUN_HELP: Record<string, string> = {
  pair: PAIR_HELP,
  endpoint: ENDPOINT_HELP,
  kb: KB_HELP,
  ingest: INGEST_HELP,
  query: QUERY_HELP,
  status: STATUS_HELP,
};

/** Run one invocation. Returns the exit code; never exits the process. */
export async function runSearchCli(deps: SearchCliDeps): Promise<number> {
  const flags = parseArgs(deps.argv);

  if (flags.missingValue) {
    deps.err(`actana-search: ${flags.missingValue} needs a value.`);
    return EXIT_USAGE;
  }
  if (flags.unknown.length > 0) {
    deps.err(`actana-search: unknown flag ${flags.unknown[0]}.`);
    deps.err("`actana-search --help` lists them.");
    return EXIT_USAGE;
  }

  const [noun, ...rest] = flags.positionals;

  if (flags.version && !noun) {
    deps.out(`actana-search (protocol ${SEARCH_PROTOCOL_VERSION})`);
    return EXIT_OK;
  }

  if (!noun) {
    deps.out(HELP);
    // Help asked for is an answer; help fallen back to is not.
    return flags.help ? EXIT_OK : EXIT_USAGE;
  }

  if (flags.help && NOUN_HELP[noun] && rest.length === 0) {
    deps.out(NOUN_HELP[noun]!);
    return EXIT_OK;
  }

  switch (noun) {
    case "help":
      deps.out(rest[0] && NOUN_HELP[rest[0]] ? NOUN_HELP[rest[0]]! : HELP);
      return EXIT_OK;
    case "pair":
      return runPairCommand(deps, flags, rest);
    case "endpoint":
    case "endpoints":
      return runEndpointCommand(deps, flags, rest);
    case "status":
      return runStatusCommand(deps, flags);
    case "kb":
    case "kbs":
      return runKbCommand(deps, flags, rest);
    case "ingest":
      return runIngestCommand(deps, flags, rest);
    case "query":
      return runQueryCommand(deps, flags, rest);
    default:
      deps.err(`actana-search: "${noun}" is not a command.`);
      deps.err("Commands: pair, endpoint, status, kb, ingest, query.");
      return EXIT_USAGE;
  }
}

/** Re-exported so a test can assert on what was parsed without a second import. */
export type { ParsedArgs };
