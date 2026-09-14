// Flag parsing.
//
// Hand-written and small, mirroring Control's `packages/cli/src/cli-args.ts`
// clause for clause — including the two behaviours that are the whole reason it
// is worth writing rather than installing:
//
//   * **Flags may appear before or after positionals.** `actana-search pair ls
//     --json` and `actana-search --json pair ls` both work, because somebody who
//     has just been told a flag exists types it wherever they are looking.
//   * **`--` ends flag parsing**, so a query that starts with a dash is still a
//     query.
//
// A published CLI whose only runtime dependency is the SDK is a CLI whose
// install is one package deep, and this surface is a dozen booleans and a
// dozen values. The moment that stops being true the trade changes; it is not
// true yet.
//
// **Nothing here throws.** A missing value or an unknown flag is recorded in
// the result and reported by the verb, which is the layer that knows what the
// flag was for.

/** Global flags plus whatever was left over. */
export type ParsedArgs = {
  /** The nouns, verbs and arguments, in order, with flags removed. */
  positionals: string[];
  /** `--json`: machine-readable output. Every listing honours it. */
  json: boolean;
  /** `--verbose`: explain the steps, on stderr. Never prints a credential. */
  verbose: boolean;
  /** `-h` / `--help`. */
  help: boolean;
  /** `-V` / `--version`. */
  version: boolean;

  // ─── reaching an instance ────────────────────────────────────────────────
  /**
   * `--admin-socket <path>` — the instance's admin Unix socket, overriding
   * `SEARCH_ADMIN_SOCKET` and `$SEARCH_STATE_DIR/admin.sock`.
   *
   * The operator verbs (`pair new`, `pair ls`, `pair revoke`, `endpoint add`)
   * run **on the machine that is the instance**: reaching that socket is the
   * credential (ADR 0008 D6), and there is nothing else to authenticate with.
   */
  adminSocket: string | null;
  /** `--profile <name>` — which stored registration blob the mTLS verbs use. */
  profile: string | null;

  // ─── `pair` ──────────────────────────────────────────────────────────────
  /** `--label <name>`: what a paired machine calls itself in `pair ls`. */
  label: string | null;
  /** `--scope read|write|admin`: what the minted code grants (ADR 0003). */
  scope: string | null;
  /** `--kbs a,b`: the KB ids the minted code's client may touch. Empty means all. */
  kbs: string | null;
  /** `--ttl 5m`: how long a minted code stays good. Raw — the verb parses it. */
  ttl: string | null;
  /** `--fingerprint <sha256>`: the CA fingerprint read out beside the code. */
  fingerprint: string | null;
  /** `--session <id>`: the pairing session, when the ticket does not carry it. */
  session: string | null;

  // ─── `endpoint` ──────────────────────────────────────────────────────────
  /** `--client <id>`: which paired client an operator verb acts for. */
  client: string | null;
  /** `--kind embedding|inference`. */
  kind: string | null;
  /** `--provider <id>`: catalog provider — `openai`, `voyage`, `google`, … */
  provider: string | null;
  /** `--template <id>`: the request shape. Defaults to the provider's own name. */
  template: string | null;
  /** `--model <name>`: the provider-side model. */
  model: string | null;
  /** `--dimensions <n>`: vector width. Required for `embedding`. Raw. */
  dimensions: string | null;
  /** `--base-url <url>`: an OpenAI-compatible endpoint behind someone else's URL. */
  baseUrl: string | null;
  /**
   * `--key-stdin`: read the provider key from stdin.
   *
   * The **only** way this CLI accepts a key, and a flag rather than a value for
   * one reason: an argument is in `ps`, in the shell history and in every
   * process listing on the machine. A pipe is in none of them.
   */
  keyStdin: boolean;

  // ─── `query` ─────────────────────────────────────────────────────────────
  /** `--top-k <n>`: how many matches to return. Raw. */
  topK: string | null;
  /** `--keyword-weight <0..1>`: how much of the score keywords are worth. Raw. */
  keywordWeight: string | null;

  /** Flags this build does not know, in the order they appeared. */
  unknown: string[];
  /** A flag that takes a value and was given none, or null. */
  missingValue: string | null;
};

/** Flags that take a value. */
const VALUE_FLAGS: Record<string, keyof ParsedArgs> = {
  "--admin-socket": "adminSocket",
  "--profile": "profile",
  "--label": "label",
  "--scope": "scope",
  "--kbs": "kbs",
  "--ttl": "ttl",
  "--fingerprint": "fingerprint",
  "--session": "session",
  "--client": "client",
  "--kind": "kind",
  "--provider": "provider",
  "--template": "template",
  "--model": "model",
  "--dimensions": "dimensions",
  "--base-url": "baseUrl",
  "--top-k": "topK",
  "--keyword-weight": "keywordWeight",
};

/** Parse `process.argv.slice(2)`. Never throws; malformed input is in the result. */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    positionals: [],
    json: false,
    verbose: false,
    help: false,
    version: false,
    adminSocket: null,
    profile: null,
    label: null,
    scope: null,
    kbs: null,
    ttl: null,
    fingerprint: null,
    session: null,
    client: null,
    kind: null,
    provider: null,
    template: null,
    model: null,
    dimensions: null,
    baseUrl: null,
    keyStdin: false,
    topK: null,
    keywordWeight: null,
    unknown: [],
    missingValue: null,
  };

  let flagsEnded = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;

    if (flagsEnded || arg === "-" || !arg.startsWith("-")) {
      // A bare `-` is a positional: it is the conventional name for stdin, and
      // `actana-search ingest my-kb -` is a sentence somebody will type.
      parsed.positionals.push(arg);
      continue;
    }

    if (arg === "--") {
      flagsEnded = true;
      continue;
    }

    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg : arg.slice(0, eq);
    const inlineValue = eq === -1 ? null : arg.slice(eq + 1);

    const field = VALUE_FLAGS[name];
    if (field) {
      const value = inlineValue ?? argv[++i] ?? null;
      if (value === null || value === "") {
        parsed.missingValue ??= name;
        continue;
      }
      // Every value flag lands in a `string | null` field; the map is what
      // decides which, so a new flag is one line there and one line in the type.
      (parsed as unknown as Record<string, string>)[field] = value;
      continue;
    }

    switch (name) {
      case "--json":
        parsed.json = true;
        break;
      case "--verbose":
        parsed.verbose = true;
        break;
      case "--key-stdin":
        parsed.keyStdin = true;
        break;
      case "-h":
      case "--help":
        parsed.help = true;
        break;
      case "-V":
      case "--version":
      case "-v":
        parsed.version = true;
        break;
      default:
        parsed.unknown.push(name);
    }
  }

  return parsed;
}

/** A comma-separated list flag, split and trimmed. `null` for absent or empty. */
export function parseList(value: string | null): string[] | null {
  if (!value) return null;
  const items = value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return items.length > 0 ? items : null;
}

/** A parsed duration, or the reason it is not one. */
export type DurationResult = { ms: number } | { error: string };

/**
 * `30s`, `5m`, `2h`, `1d`, or a bare number of **seconds**.
 *
 * Bare-as-seconds rather than bare-as-milliseconds: a person typing `--ttl 300`
 * means five minutes, and a CLI that read it as a third of a second would mint
 * a code that expired before it could be read out.
 */
export function parseDuration(raw: string): DurationResult {
  const match = /^(\d+)\s*(ms|s|m|h|d)?$/i.exec(raw.trim());
  if (!match) {
    return { error: `"${raw}" is not a duration — try 30s, 5m, 2h` };
  }
  const amount = Number.parseInt(match[1]!, 10);
  const unit = (match[2] ?? "s").toLowerCase();
  const scale: Record<string, number> = {
    ms: 1,
    s: 1_000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  };
  const ms = amount * scale[unit]!;
  if (ms <= 0) return { error: "a duration has to be more than nothing" };
  return { ms };
}

/** A positive integer flag, or the reason it is not one. */
export function parseInteger(raw: string, what: string): { value: number } | { error: string } {
  if (!/^\d+$/.test(raw.trim())) {
    return { error: `${what} has to be a whole number — "${raw}" is not` };
  }
  const value = Number.parseInt(raw.trim(), 10);
  if (value <= 0) return { error: `${what} has to be more than zero` };
  return { value };
}

/** A number between 0 and 1, or the reason it is not one. */
export function parseFraction(raw: string, what: string): { value: number } | { error: string } {
  const value = Number.parseFloat(raw.trim());
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    return { error: `${what} is a number between 0 and 1 — "${raw}" is not` };
  }
  return { value };
}
