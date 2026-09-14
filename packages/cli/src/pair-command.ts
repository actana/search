// `actana-search pair` — both ends of short-code enrollment, in one noun.
//
//   pair new [--label <name>] [--scope read|write|admin] [--kbs a,b] [--ttl 5m]
//   pair ls [--json]
//   pair revoke <id>
//   pair redeem <address> <ticket> [--fingerprint <sha256>] [--profile <name>]
//
// **Three of these run on the instance and one runs on the client.** Control
// splits the two across `actana pair` and `actana core pair` for exactly that
// reason, and its header says why it matters: one binary carrying both means
// the only thing separating them is which words the operator types, so the help
// has to make the machine obvious or the mistake is silent. Here they share a
// noun because `redeem` is unmistakably the far end of `new` — it takes the
// thing `new` printed — and the help says which machine each belongs on.
//
// **The code exists in exactly one place: the terminal `pair new` printed it
// on.** What the instance persists is a keyed digest, so `pair ls` *cannot*
// print a code — there is none in the store to print. That is the design
// working, not an omission, and `pair-command.test.ts` asserts it against a
// real admin socket rather than trusting it.
//
// **What the fingerprint is for.** `pair new` prints the CA fingerprint beside
// the code because the client's first dial is the one dial it cannot verify any
// other way: it holds nothing pinned. A human reads both out, and `redeem`
// checks the CA it is presented against the fingerprint *before* it sends the
// code. Absent is not "skip the check" — the SDK refuses with
// `fingerprint-unconfirmed`, having sent nothing.

import { SearchPairingError, type SearchPairingFailure } from "@actana/search/pairing";
import {
  AdminError,
  listPairedClients,
  listPendingCodes,
  mintPairingCode,
  resolveAdminSocket,
  revokePairing,
} from "./admin-client.ts";
import { parseDuration, parseList, type ParsedArgs } from "./cli-args.ts";
import { absoluteTime, formatJson, formatTable, orDash, relativeTime } from "./cli-output.ts";
import { saveProfile, configDirFor, DEFAULT_PROFILE } from "./cli-config.ts";
import type { SearchCliDeps } from "./cli-deps.ts";
import {
  EXIT_FAILURE,
  EXIT_OK,
  EXIT_PAIR_CERTIFICATE_INVALID,
  EXIT_PAIR_CORE_ERROR,
  EXIT_PAIR_FINGERPRINT_MISMATCH,
  EXIT_PAIR_FINGERPRINT_UNCONFIRMED,
  EXIT_PAIR_HOSTNAME_MISMATCH,
  EXIT_PAIR_MALFORMED_RESPONSE,
  EXIT_PAIR_NO_CA,
  EXIT_PAIR_NOT_PAIRABLE,
  EXIT_PAIR_RATE_LIMITED,
  EXIT_PAIR_REFUSED,
  EXIT_PAIR_REJECTED,
  EXIT_PAIR_UNREACHABLE,
  EXIT_USAGE,
} from "./exit-codes.ts";

export const PAIR_HELP = `actana-search pair — enroll a client on a Search instance

Three of these verbs run ON THE INSTANCE, and one runs on the machine being
paired. The instance-side verbs reach it through its admin Unix socket, which is
mode 0600 — reaching it IS the credential, so they only work as the user the
instance runs as.

Usage
  actana-search pair new [--label <name>] [--scope <s>] [--kbs <a,b>] [--ttl <d>]
                                  mint a one-time code and print it   (instance)
  actana-search pair ls [--json]  pending codes, and the clients paired (instance)
  actana-search pair revoke <id>  unpair a client, or cancel a code     (instance)
  actana-search pair redeem <address> <ticket> [--fingerprint <fp>]
                                  spend a code and store the credential  (client)

Flags
  --label <name>        what to call the machine being paired
  --scope <s>           read | write | admin (default: admin)
  --kbs <a,b>           limit the paired client to these knowledge bases
  --ttl <duration>      how long the code stays good — 30s, 5m, 2h (default: 5m)
  --fingerprint <fp>    the CA fingerprint read out beside the code   (redeem)
  --session <id>        the pairing session, if the ticket does not carry it
  --profile <name>      which stored credential to write              (redeem)
  --admin-socket <path> the instance's admin socket
  --json                machine-readable output — ls
  -h, --help            show this help

Minting a code
  \`pair new\` prints three things: the ticket, the instance's CA fingerprint,
  and when it expires. Read the ticket AND the fingerprint out to whoever is at
  the client — the client checks the fingerprint against the certificate the
  instance presents before it sends the code, which is what makes that first
  dial verifiable when the client has nothing pinned yet.

  The code is printed once and never stored. The instance keeps only a keyed
  digest, so nothing — \`pair ls\` included — can print it again. A lost code is
  re-minted, not recovered.

Redeeming one
  \`pair redeem\` runs on the machine being paired. It generates a private key
  locally, never sends it, and stores what comes back under
  ~/.actana-search/cli.json, mode 0600, as a profile.

    actana-search pair redeem search.internal:7443 <session>:XXXX-XXXX \\
      --fingerprint AA:BB:...

Revoking
  \`revoke\` takes a paired client's id or a pending code's session id. Pointed
  at a client it unpairs the machine and its certificate stops working; pointed
  at a pending code it cancels the code before anyone spends it.`;

/** Dispatch a `pair` sub-verb. `argv` is everything after `pair`. */
export async function runPairCommand(
  deps: SearchCliDeps,
  flags: ParsedArgs,
  rest: string[],
): Promise<number> {
  const verb = rest[0];
  if (verb === undefined || flags.help) {
    deps.out(PAIR_HELP);
    // No verb is a question, not a mistake — but it is also not an answer.
    return verb === undefined ? EXIT_USAGE : EXIT_OK;
  }

  switch (verb) {
    case "new":
      return pairNew(deps, flags);
    case "ls":
    case "list":
      return pairLs(deps, flags);
    case "revoke":
      return pairRevoke(deps, flags, rest.slice(1));
    case "redeem":
      return pairRedeem(deps, flags, rest.slice(1));
    default:
      deps.err(`actana-search pair: unknown verb "${verb}".`);
      deps.err("Verbs: new, ls, revoke, redeem. `actana-search pair --help` explains them.");
      return EXIT_USAGE;
  }
}

// ─── new ────────────────────────────────────────────────────────────────────

const SCOPES = new Set(["read", "write", "admin"]);

async function pairNew(deps: SearchCliDeps, flags: ParsedArgs): Promise<number> {
  const scope = flags.scope ?? "admin";
  if (!SCOPES.has(scope)) {
    deps.err(`actana-search pair new: --scope is read, write or admin — "${scope}" is not.`);
    return EXIT_USAGE;
  }
  let ttlMs: number | undefined;
  if (flags.ttl) {
    const parsed = parseDuration(flags.ttl);
    if ("error" in parsed) {
      deps.err(`actana-search pair new: ${parsed.error}.`);
      return EXIT_USAGE;
    }
    ttlMs = parsed.ms;
  }

  const client = deps.adminClient(socketFor(deps, flags));
  let minted;
  try {
    minted = await mintPairingCode(client, {
      ...(flags.label ? { label: flags.label } : {}),
      scope,
      kbIds: parseList(flags.kbs),
      ...(ttlMs === undefined ? {} : { ttlMs }),
    });
  } catch (err) {
    return reportAdmin(deps, "pair new", err);
  }

  if (flags.json) {
    // The code IS in the `--json` payload, and that is the point of the verb:
    // an enrollment script that could not read what it just minted would have
    // to scrape it off a terminal.
    deps.out(formatJson(minted));
    return EXIT_OK;
  }

  // stderr is the prose, so a script reading stdout gets the facts and nothing
  // else — the same split Control's `pair new` keeps.
  deps.err("Read the ticket AND the fingerprint out to the machine you are pairing.");
  deps.err("The code is printed once — this instance keeps only a digest of it.");

  deps.out(`Ticket         ${minted.ticket}`);
  deps.out(`CA fingerprint ${minted.caFingerprint}`);
  deps.out(
    `Expires        ${absoluteTime(minted.expiresAt)} (${relativeTime(minted.expiresAt, deps.now())})`,
  );
  deps.out(`Scope          ${minted.scope}`);
  if (minted.kbIds?.length) deps.out(`Knowledge bases ${minted.kbIds.join(", ")}`);
  deps.out(`Endpoint       ${minted.endpoint}`);
  deps.out(`Session        ${minted.sessionId}`);

  if (deps.stdoutIsTty) {
    deps.err("");
    deps.err("On the machine being paired:");
    deps.err(
      `  actana-search pair redeem ${hostOf(minted.endpoint)} ${minted.ticket} \\\n` +
        `    --fingerprint ${minted.caFingerprint}`,
    );
  }
  deps.err(`Cancel it before it is used with \`actana-search pair revoke ${minted.sessionId}\`.`);
  return EXIT_OK;
}

// ─── ls ─────────────────────────────────────────────────────────────────────

async function pairLs(deps: SearchCliDeps, flags: ParsedArgs): Promise<number> {
  const client = deps.adminClient(socketFor(deps, flags));
  let clients;
  let codes;
  try {
    clients = (await listPairedClients(client)).clients;
    codes = (await listPendingCodes(client)).codes;
  } catch (err) {
    return reportAdmin(deps, "pair ls", err);
  }

  if (flags.json) {
    deps.out(formatJson({ clients, codes }));
    return EXIT_OK;
  }

  if (clients.length === 0) {
    deps.out("No clients are paired with this instance.");
  } else {
    for (const line of formatTable(
      ["ID", "LABEL", "SCOPE", "KBS", "STATUS", "PAIRED"],
      clients.map((c) => [
        c.id,
        orDash(c.label),
        c.scope,
        c.kbIds?.length ? String(c.kbIds.length) : "all",
        c.revokedAt ? "revoked" : "active",
        relativeTime(c.pairedAt, deps.now()),
      ]),
    )) {
      deps.out(line);
    }
  }

  const pending = codes.filter((c) => !c.consumedAt && !c.revokedAt);
  if (pending.length > 0) {
    deps.out("");
    for (const line of formatTable(
      ["SESSION", "LABEL", "SCOPE", "ATTEMPTS", "EXPIRES"],
      pending.map((c) => [
        c.sessionId,
        orDash(c.label),
        c.scope,
        `${c.attempts}/${c.attemptCap}`,
        relativeTime(c.expiresAt, deps.now()),
      ]),
    )) {
      deps.out(line);
    }
    // Said out loud rather than left to be discovered: an operator looking at a
    // list of pending codes is usually looking for the code.
    deps.err("");
    deps.err("Pending codes are listed without their codes — only a digest was stored.");
  }
  return EXIT_OK;
}

// ─── revoke ─────────────────────────────────────────────────────────────────

async function pairRevoke(
  deps: SearchCliDeps,
  flags: ParsedArgs,
  rest: string[],
): Promise<number> {
  const id = rest[0];
  if (!id) {
    deps.err("actana-search pair revoke: name the paired client or the pending code to revoke.");
    deps.err("`actana-search pair ls` lists both.");
    return EXIT_USAGE;
  }
  const client = deps.adminClient(socketFor(deps, flags));
  try {
    const { revoked } = await revokePairing(client, id);
    if (flags.json) {
      deps.out(formatJson(revoked));
      return EXIT_OK;
    }
    if (revoked.kind === "client") {
      deps.out(`Unpaired ${revoked.id} (certificate ${revoked.certSerial}).`);
      deps.err("Its certificate stops working now, including on any request already in flight.");
    } else {
      deps.out(`Cancelled pending code ${revoked.id}.`);
    }
    return EXIT_OK;
  } catch (err) {
    return reportAdmin(deps, "pair revoke", err);
  }
}

// ─── redeem ─────────────────────────────────────────────────────────────────

async function pairRedeem(
  deps: SearchCliDeps,
  flags: ParsedArgs,
  rest: string[],
): Promise<number> {
  const [address, ticket] = rest;
  if (!address || !ticket) {
    deps.err("actana-search pair redeem: give the instance's address and the ticket.");
    deps.err("  actana-search pair redeem search.internal:7443 <session>:XXXX-XXXX \\");
    deps.err("    --fingerprint AA:BB:...");
    return EXIT_USAGE;
  }

  const profile = flags.profile ?? DEFAULT_PROFILE;
  deps.verbose(`Dialling ${address} to read its certificate chain…`);

  let blob;
  try {
    blob = await deps.pair({
      address,
      code: ticket,
      ...(flags.session ? { sessionId: flags.session } : {}),
      expectedCaFingerprint: flags.fingerprint ?? null,
      label: flags.label ?? hostname(deps),
      platform: process.platform,
    });
  } catch (err) {
    return reportPairing(deps, err);
  }

  const configDir = configDirFor(deps.home);
  saveProfile(configDir, profile, blob, {
    ...(flags.fingerprint ? { caFingerprint: flags.fingerprint } : {}),
  });

  if (flags.json) {
    // The blob is **not** in this payload. It is the credential; it belongs in
    // the 0600 file it was just written to and nowhere a pipe can carry it.
    deps.out(formatJson({ profile, endpoint: blob.endpoint, label: blob.label ?? null }));
    return EXIT_OK;
  }
  deps.out(`Paired with ${blob.endpoint}.`);
  deps.out(`Profile        ${profile}`);
  deps.err(`Stored in ${configDir}/cli.json (mode 0600). The private key never left this machine.`);
  deps.err("Check it with `actana-search status`.");
  return EXIT_OK;
}

// ─── shared ─────────────────────────────────────────────────────────────────

/** The admin socket this invocation should use. */
export function socketFor(deps: SearchCliDeps, flags: ParsedArgs): string {
  return resolveAdminSocket({ flag: flags.adminSocket, env: deps.env, home: deps.home });
}

/** Report an admin-socket failure and pick an exit code. */
export function reportAdmin(deps: SearchCliDeps, verb: string, err: unknown): number {
  if (err instanceof AdminError) {
    for (const line of err.message.split("\n")) deps.err(`actana-search ${verb}: ${line}`);
    return EXIT_FAILURE;
  }
  deps.err(`actana-search ${verb}: ${err instanceof Error ? err.message : String(err)}`);
  return EXIT_FAILURE;
}

/**
 * Exit codes for the SDK's pairing failures, exhaustively.
 *
 * The `satisfies`-shaped map rather than a switch: a failure added to the SDK's
 * union stops this file compiling until it has a number, which is the property
 * Control's own exhaustive switch buys. A script branching on 14 must keep
 * meaning "that was not the instance you were told about" forever.
 */
const PAIRING_EXITS: Record<SearchPairingFailure, number> = {
  "bad-address": EXIT_USAGE,
  "bad-code": EXIT_USAGE,
  "bad-fingerprint": EXIT_USAGE,
  unreachable: EXIT_PAIR_UNREACHABLE,
  "not-pairable": EXIT_PAIR_NOT_PAIRABLE,
  "no-ca-presented": EXIT_PAIR_NO_CA,
  "fingerprint-unconfirmed": EXIT_PAIR_FINGERPRINT_UNCONFIRMED,
  "fingerprint-mismatch": EXIT_PAIR_FINGERPRINT_MISMATCH,
  "hostname-mismatch": EXIT_PAIR_HOSTNAME_MISMATCH,
  "certificate-invalid": EXIT_PAIR_CERTIFICATE_INVALID,
  refused: EXIT_PAIR_REFUSED,
  "rate-limited": EXIT_PAIR_RATE_LIMITED,
  rejected: EXIT_PAIR_REJECTED,
  "core-error": EXIT_PAIR_CORE_ERROR,
  "malformed-response": EXIT_PAIR_MALFORMED_RESPONSE,
};

function reportPairing(deps: SearchCliDeps, err: unknown): number {
  if (!(err instanceof SearchPairingError)) {
    deps.err(`actana-search pair redeem: ${err instanceof Error ? err.message : String(err)}`);
    return EXIT_FAILURE;
  }
  for (const line of err.message.split("\n")) deps.err(`actana-search pair redeem: ${line}`);
  if (err.failure === "fingerprint-mismatch") {
    deps.err("");
    deps.err("The code was NOT sent. Either something is answering for that address that is not");
    deps.err("the instance you were told about, or the instance has been re-issued and the");
    deps.err("fingerprint you have is stale. Ask for a fresh one and compare again.");
  }
  if (err.failure === "fingerprint-unconfirmed") {
    deps.err("");
    deps.err("The code was NOT sent. Pass --fingerprint with the one `pair new` printed.");
  }
  return PAIRING_EXITS[err.failure] ?? EXIT_FAILURE;
}

/** `https://host:port` → `host:port`, which is what `redeem` takes. */
function hostOf(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return endpoint;
  }
}

/** What this machine calls itself when it pairs, if `--label` said nothing. */
function hostname(deps: SearchCliDeps): string {
  return deps.env.HOSTNAME || deps.env.HOST || "actana-search-cli";
}
