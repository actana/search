// What the CLI needs from the world, as one injected bag.
//
// Control's `cli-deps.ts`, cut down to this program's surface and here for the
// same reason: `runSearchCli` takes every side effect as a dependency and
// returns an exit code instead of calling `process.exit`, so dispatch, flag
// validation, output and exit codes are exercised by unit tests rather than by
// a subprocess. `index.ts` is the only file in this package that knows about
// `process`.
//
// The bag has two halves, marked below, because the two kinds of verb reach
// different machines. `pair new`, `pair ls` and `pair revoke` run **on the
// machine that IS the instance** and go through the admin Unix socket;
// `pair redeem`, `status`, `endpoint`, `kb`, `ingest` and `query` run on a
// **client** machine and go over mTLS through the SDK. Two halves, one help
// text, one command — the same arrangement Control landed on.
//
// `endpoint add|ls` were in the first half until `PUT /v1/endpoints` existed;
// they are in the second now, which is why `adminClient` is the operator half's
// only entry and `clientFor` carries one more verb.

import type { SearchClient } from "@actana/search/client";
import type { PairWithSearchOptions } from "@actana/search/pairing";
import type { SearchRegistrationBlob } from "@actana/search/registration-blob";
import type { AdminClient } from "./admin-client.ts";

export type SearchCliDeps = {
  /** `process.argv.slice(2)`. */
  argv: string[];
  env: NodeJS.ProcessEnv;
  home: string;
  /** Ordinary output. One call per line; the line carries no newline. */
  out: (line: string) => void;
  /** Errors and prose. Never a credential this CLI was not asked to print. */
  err: (line: string) => void;
  /**
   * `--verbose`, on stderr, where it cannot corrupt the stdout a `--json`
   * consumer is parsing.
   */
  verbose: (line: string) => void;
  /** Epoch ms. Only the relative-time lines read it. */
  now: () => number;
  /**
   * Whether stdout is a terminal.
   *
   * Cosmetics only. Nothing about *what* a verb does may read it — a command
   * that behaved differently down a pipe is a command no script can trust.
   */
  stdoutIsTty: boolean;
  /** Read stdin to end. Only called when a verb was told to (`--key-stdin`). */
  readStdin: () => Promise<string>;
  /** Read a file for `ingest`. */
  readFile: (path: string) => Promise<Buffer>;

  // ─── the operator half: this machine's own instance ──────────────────────

  /** Open a client on the admin Unix socket. */
  adminClient: (socketPath: string) => AdminClient;

  // ─── the client half: an instance this machine has paired with ───────────

  /**
   * How `pair redeem` reaches an instance it has **no credential for yet**.
   *
   * Its own dependency rather than a method on a client, because it is the one
   * call made before there is anything to authenticate with: the dial is
   * unverified by construction, what pins it is a fingerprint a human read out,
   * and what comes back is the credential everything else here assumes exists.
   */
  pair: (options: PairWithSearchOptions) => Promise<SearchRegistrationBlob>;
  /** Build an mTLS client from a stored registration blob. */
  clientFor: (blob: SearchRegistrationBlob) => SearchClient;
};
