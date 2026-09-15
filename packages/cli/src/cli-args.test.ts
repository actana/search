/**
 * Flag parsing.
 *
 * Small surface, and the cases that matter are the ones a hand-written parser
 * gets wrong: a flag after a positional, `--` ending flag parsing, `=`-joined
 * values, a value flag given nothing, and an unknown flag being *recorded*
 * rather than thrown — the parser never throws, because the verb is the layer
 * that knows what the flag was for.
 *
 * @vitest-environment node
 */
import { describe, expect, it } from "vitest";
import {
  parseArgs,
  parseDuration,
  parseFraction,
  parseInteger,
  parseList,
} from "./cli-args.ts";

describe("parseArgs", () => {
  it("separates nouns and verbs from flags", () => {
    const parsed = parseArgs(["pair", "new", "--label", "laptop", "--scope", "write"]);
    expect(parsed.positionals).toEqual(["pair", "new"]);
    expect(parsed.label).toBe("laptop");
    expect(parsed.scope).toBe("write");
  });

  it("takes a flag before the positionals as well as after", () => {
    // Somebody who has just been told a flag exists types it where they are
    // looking, which is not always the end of the line.
    expect(parseArgs(["--json", "pair", "ls"]).json).toBe(true);
    expect(parseArgs(["pair", "ls", "--json"]).json).toBe(true);
    expect(parseArgs(["pair", "--json", "ls"]).positionals).toEqual(["pair", "ls"]);
  });

  it("reads --flag=value as well as --flag value", () => {
    expect(parseArgs(["--profile=staging"]).profile).toBe("staging");
    expect(parseArgs(["--profile", "staging"]).profile).toBe("staging");
  });

  it("stops parsing flags after --", () => {
    const parsed = parseArgs(["query", "kb-1", "--", "--top-k is in the question"]);
    expect(parsed.positionals).toEqual(["query", "kb-1", "--top-k is in the question"]);
    expect(parsed.topK).toBeNull();
  });

  it("treats a bare dash as a positional", () => {
    expect(parseArgs(["ingest", "kb-1", "-"]).positionals).toEqual(["ingest", "kb-1", "-"]);
  });

  it("records a value flag given nothing instead of throwing", () => {
    const parsed = parseArgs(["pair", "new", "--label"]);
    expect(parsed.missingValue).toBe("--label");
    expect(parsed.positionals).toEqual(["pair", "new"]);
  });

  it("records the first missing value only, so the message names one thing", () => {
    const parsed = parseArgs(["--label", "--scope"]);
    // `--scope` is consumed as `--label`'s value, which is a mistake the
    // operator made and not one this parser can unpick — what matters is that
    // it does not throw and does not invent a second complaint.
    expect(parsed.label).toBe("--scope");
    expect(parsed.missingValue).toBeNull();
  });

  it("records unknown flags in order", () => {
    const parsed = parseArgs(["pair", "ls", "--colour", "--loud"]);
    expect(parsed.unknown).toEqual(["--colour", "--loud"]);
  });

  it("knows --key-stdin is a boolean, not a key", () => {
    // There is deliberately no `--key`: a key in an argument is in ps and in
    // the shell history.
    const parsed = parseArgs(["endpoint", "add", "--key-stdin"]);
    expect(parsed.keyStdin).toBe(true);
    expect(Object.keys(parsed)).not.toContain("key");
  });

  it("reads -h, --help, -V, -v and --version", () => {
    expect(parseArgs(["-h"]).help).toBe(true);
    expect(parseArgs(["--help"]).help).toBe(true);
    expect(parseArgs(["-V"]).version).toBe(true);
    expect(parseArgs(["-v"]).version).toBe(true);
    expect(parseArgs(["--version"]).version).toBe(true);
  });

  it("carries every value flag into its own field", () => {
    const parsed = parseArgs([
      "--admin-socket", "/tmp/a.sock",
      "--profile", "p",
      "--label", "l",
      "--scope", "admin",
      "--kbs", "a,b",
      "--ttl", "5m",
      "--fingerprint", "AA:BB",
      "--session", "s-1",
      "--external-id", "e-1",
      "--kind", "embedding",
      "--provider", "openai",
      "--template", "openai",
      "--model", "m",
      "--dimensions", "1536",
      "--base-url", "https://x",
      "--top-k", "5",
      "--keyword-weight", "0.3",
    ]);
    expect(parsed).toMatchObject({
      adminSocket: "/tmp/a.sock",
      profile: "p",
      label: "l",
      scope: "admin",
      kbs: "a,b",
      ttl: "5m",
      fingerprint: "AA:BB",
      session: "s-1",
      externalId: "e-1",
      kind: "embedding",
      provider: "openai",
      template: "openai",
      model: "m",
      dimensions: "1536",
      baseUrl: "https://x",
      topK: "5",
      keywordWeight: "0.3",
    });
  });
});

describe("parseList", () => {
  it("splits, trims and drops the empties", () => {
    expect(parseList("a, b ,,c")).toEqual(["a", "b", "c"]);
  });
  it("reads absent and empty as null, so a route gets 'all' rather than 'none'", () => {
    expect(parseList(null)).toBeNull();
    expect(parseList("")).toBeNull();
    expect(parseList(" , ")).toBeNull();
  });
});

describe("parseDuration", () => {
  it("reads the suffixes", () => {
    expect(parseDuration("30s")).toEqual({ ms: 30_000 });
    expect(parseDuration("5m")).toEqual({ ms: 300_000 });
    expect(parseDuration("2h")).toEqual({ ms: 7_200_000 });
    expect(parseDuration("1d")).toEqual({ ms: 86_400_000 });
    expect(parseDuration("250ms")).toEqual({ ms: 250 });
  });

  it("reads a bare number as seconds", () => {
    // `--ttl 300` means five minutes. Reading it as milliseconds would mint a
    // code that expired before it could be read out.
    expect(parseDuration("300")).toEqual({ ms: 300_000 });
  });

  it("refuses what is not a duration", () => {
    expect(parseDuration("soon")).toMatchObject({ error: expect.any(String) });
    expect(parseDuration("0")).toMatchObject({ error: expect.any(String) });
    expect(parseDuration("-5m")).toMatchObject({ error: expect.any(String) });
  });
});

describe("parseInteger and parseFraction", () => {
  it("accept what they should", () => {
    expect(parseInteger("1536", "--dimensions")).toEqual({ value: 1536 });
    expect(parseFraction("0.3", "--keyword-weight")).toEqual({ value: 0.3 });
    expect(parseFraction("0", "--keyword-weight")).toEqual({ value: 0 });
    expect(parseFraction("1", "--keyword-weight")).toEqual({ value: 1 });
  });

  it("name the flag in the refusal", () => {
    expect(parseInteger("lots", "--dimensions")).toMatchObject({
      error: expect.stringContaining("--dimensions"),
    });
    expect(parseFraction("2", "--keyword-weight")).toMatchObject({
      error: expect.stringContaining("--keyword-weight"),
    });
    expect(parseInteger("-1", "--top-k")).toMatchObject({ error: expect.any(String) });
  });
});

describe("the help names the flags that work", () => {
  /**
   * The kind of gap that gets a working CLI reported as broken: `-v` was
   * accepted and only `-V` was documented.
   */
  it("documents both short forms of --version", async () => {
    const { HELP } = await import("./cli.ts");
    expect(HELP).toContain("--version");
    expect(HELP).toMatch(/-V, -v, --version/);
    expect(parseArgs(["-V"]).version).toBe(true);
    expect(parseArgs(["-v"]).version).toBe(true);
  });

  it("lists endpoint under the paired-machine verbs, not the instance's", async () => {
    // `endpoint` moved sides when `PUT /v1/endpoints` landed: it is mTLS with a
    // redeemed profile now, and the certificate is the paired client — so there
    // is no `--client` to document either.
    const { HELP } = await import("./cli.ts");
    const [onInstance, onClient] = HELP.split("On a paired machine");
    expect(onInstance).not.toContain("endpoint");
    expect(onClient).toMatch(/endpoint ls \[--json\]/);
    expect(HELP).not.toContain("--client <id>");
    expect(parseArgs(["--client", "c-1"]).unknown).toEqual(["--client"]);
  });
});
