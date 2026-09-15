/**
 * `pair new`, `pair ls` and `pair revoke` against a **real Unix socket** with a
 * stand-in instance behind it.
 *
 * A fake server rather than a mocked `AdminClient`, because the things worth
 * asserting are on the wire: that the request carries
 * `content-type: application/json` and no `Origin` — the two halves of the
 * server's browser defence (ADR 0008 D6) — and that a socket nothing is
 * listening on produces a sentence an operator can act on rather than
 * "connect ENOENT".
 *
 * And one thing that is not on the wire at all: **`pair ls` cannot print a
 * code.** The instance stores only a keyed digest, so there is nothing to print;
 * this asserts it rather than trusting it.
 *
 * @vitest-environment node
 */
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AdminClient } from "./admin-client.ts";
import { runSearchCli } from "./cli.ts";
import type { SearchCliDeps } from "./cli-deps.ts";
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE } from "./exit-codes.ts";

type Received = {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: unknown;
};

const TICKET = "sess-abc:7K4M-2QPX";
const FINGERPRINT = "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99";

let dir: string;
let socketPath: string;
let server: http.Server | undefined;
let received: Received[];
let routes: Record<string, { status: number; body: unknown }>;

/** Stand in for the instance's admin listener on a real socket. */
async function listen(): Promise<void> {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      received.push({
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: raw === "" ? undefined : JSON.parse(raw),
      });
      const route = routes[`${req.method} ${(req.url ?? "").split("?")[0]}`];
      const answer = route ?? { status: 404, body: { code: "not-found", error: "no route" } };
      res.writeHead(answer.status, { "content-type": "application/json" });
      res.end(JSON.stringify(answer.body));
    });
  });
  await new Promise<void>((resolve) => server!.listen(socketPath, resolve));
}

/** A dependency bag whose output is collected rather than printed. */
function deps(argv: string[]): SearchCliDeps & { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    argv,
    env: { SEARCH_ADMIN_SOCKET: socketPath } as NodeJS.ProcessEnv,
    home: dir,
    out: (line) => void stdout.push(line),
    err: (line) => void stderr.push(line),
    verbose: () => {},
    now: () => Date.parse("2026-09-15T12:00:00.000Z"),
    stdoutIsTty: false,
    readStdin: async () => "",
    readFile: async () => Buffer.from(""),
    adminClient: (p) => new AdminClient(p, { timeoutMs: 2_000 }),
    pair: async () => {
      throw new Error("not used by these verbs");
    },
    clientFor: () => {
      throw new Error("not used by these verbs");
    },
    stdout,
    stderr,
  };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "actana-search-admin-"));
  socketPath = path.join(dir, "admin.sock");
  received = [];
  routes = {};
});

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("pair new", () => {
  beforeEach(async () => {
    routes["POST /admin/pair/new"] = {
      status: 200,
      body: {
        sessionId: "sess-abc",
        code: "7K4M-2QPX",
        ticket: TICKET,
        expiresAt: "2026-09-15T12:05:00.000Z",
        caFingerprint: FINGERPRINT,
        endpoint: "https://search.internal:7443",
        scope: "admin",
        kbIds: null,
      },
    };
    await listen();
  });

  it("mints a code and prints the ticket, the fingerprint and the expiry", async () => {
    const d = deps(["pair", "new", "--label", "laptop"]);
    expect(await runSearchCli(d)).toBe(EXIT_OK);

    const stdout = d.stdout.join("\n");
    expect(stdout).toContain(`Ticket         ${TICKET}`);
    expect(stdout).toContain(`CA fingerprint ${FINGERPRINT}`);
    expect(stdout).toContain("in 5m");
    expect(stdout).toContain("Session        sess-abc");

    // The prose is on stderr, so a script reading stdout gets the facts only.
    expect(d.stderr.join("\n")).toContain("Read the ticket AND the fingerprint");
  });

  it("sends the label, scope, kb list and ttl the operator asked for", async () => {
    const d = deps([
      "pair", "new",
      "--label", "laptop",
      "--scope", "write",
      "--kbs", "kb-1, kb-2",
      "--ttl", "2h",
    ]);
    expect(await runSearchCli(d)).toBe(EXIT_OK);
    expect(received[0]!.body).toEqual({
      label: "laptop",
      scope: "write",
      kbIds: ["kb-1", "kb-2"],
      ttlMs: 7_200_000,
    });
  });

  it("sends application/json and no Origin — the server's two browser defences", async () => {
    const d = deps(["pair", "new"]);
    await runSearchCli(d);
    const headers = received[0]!.headers;
    expect(headers["content-type"]).toBe("application/json");
    expect(headers.origin).toBeUndefined();
  });

  it("puts the code in the --json payload, because that is what a script reads", async () => {
    const d = deps(["pair", "new", "--json"]);
    expect(await runSearchCli(d)).toBe(EXIT_OK);
    expect(JSON.parse(d.stdout.join("\n"))).toMatchObject({
      ticket: TICKET,
      caFingerprint: FINGERPRINT,
      sessionId: "sess-abc",
    });
  });

  it("refuses a scope that is not one of the three", async () => {
    const d = deps(["pair", "new", "--scope", "root"]);
    expect(await runSearchCli(d)).toBe(EXIT_USAGE);
    expect(d.stderr.join("\n")).toContain("read, write or admin");
    expect(received).toHaveLength(0);
  });

  it("refuses a ttl that is not a duration, before dialling", async () => {
    const d = deps(["pair", "new", "--ttl", "soon"]);
    expect(await runSearchCli(d)).toBe(EXIT_USAGE);
    expect(received).toHaveLength(0);
  });

  it("prefers --admin-socket over SEARCH_ADMIN_SOCKET", async () => {
    const d = deps(["pair", "new", "--admin-socket", path.join(dir, "elsewhere.sock")]);
    expect(await runSearchCli(d)).toBe(EXIT_FAILURE);
    expect(d.stderr.join("\n")).toContain("elsewhere.sock");
    expect(received).toHaveLength(0);
  });
});

describe("pair ls", () => {
  beforeEach(async () => {
    routes["GET /admin/pair/clients"] = {
      status: 200,
      body: {
        clients: [
          {
            id: "pc-1",
            label: "actanastudio",
            platform: "linux",
            scope: "write",
            kbIds: null,
            certSerial: "01",
            certFingerprint: "FF",
            certNotAfter: "2027-09-15T12:00:00.000Z",
            pairedAt: "2026-09-15T11:00:00.000Z",
            revokedAt: null,
          },
        ],
      },
    };
    routes["GET /admin/pair/codes"] = {
      status: 200,
      body: {
        codes: [
          {
            sessionId: "sess-abc",
            label: "laptop",
            scope: "admin",
            kbIds: null,
            expiresAt: "2026-09-15T12:05:00.000Z",
            attempts: 0,
            attemptCap: 5,
            consumedAt: null,
            revokedAt: null,
          },
        ],
      },
    };
    await listen();
  });

  it("lists the paired clients and the pending codes", async () => {
    const d = deps(["pair", "ls"]);
    expect(await runSearchCli(d)).toBe(EXIT_OK);
    const stdout = d.stdout.join("\n");
    expect(stdout).toContain("pc-1");
    expect(stdout).toContain("actanastudio");
    expect(stdout).toContain("sess-abc");
    expect(stdout).toContain("0/5");
  });

  it("cannot print a code, because the instance never stored one", async () => {
    const d = deps(["pair", "ls"]);
    await runSearchCli(d);
    expect(d.stdout.join("\n")).not.toMatch(/\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/);
    expect(d.stderr.join("\n")).toContain("only a digest was stored");
  });

  it("emits both lists under --json", async () => {
    const d = deps(["pair", "ls", "--json"]);
    expect(await runSearchCli(d)).toBe(EXIT_OK);
    const payload = JSON.parse(d.stdout.join("\n"));
    expect(payload.clients).toHaveLength(1);
    expect(payload.codes).toHaveLength(1);
    expect(JSON.stringify(payload)).not.toContain("7K4M");
  });
});

describe("pair revoke", () => {
  beforeEach(async () => {
    routes["POST /admin/pair/revoke"] = {
      status: 200,
      body: {
        revoked: {
          kind: "client",
          id: "pc-1",
          certSerial: "01",
          revokedAt: "2026-09-15T12:00:00.000Z",
        },
      },
    };
    await listen();
  });

  it("revokes by id and says what stopped working", async () => {
    const d = deps(["pair", "revoke", "pc-1"]);
    expect(await runSearchCli(d)).toBe(EXIT_OK);
    expect(received[0]!.body).toEqual({ id: "pc-1" });
    expect(d.stdout.join("\n")).toContain("Unpaired pc-1");
    expect(d.stderr.join("\n")).toContain("stops working now");
  });

  it("asks for an id rather than revoking something unnamed", async () => {
    const d = deps(["pair", "revoke"]);
    expect(await runSearchCli(d)).toBe(EXIT_USAGE);
    expect(received).toHaveLength(0);
  });
});

describe("an instance that is not there", () => {
  it("says so in a sentence an operator can act on", async () => {
    // No server: the socket path does not exist.
    const d = deps(["pair", "ls"]);
    expect(await runSearchCli(d)).toBe(EXIT_FAILURE);
    const stderr = d.stderr.join("\n");
    expect(stderr).toContain("no Search instance is listening");
    expect(stderr).toContain("--admin-socket");
    expect(stderr).not.toContain("ENOENT");
  });

  it("passes the instance's own refusal through", async () => {
    routes["POST /admin/pair/revoke"] = {
      status: 404,
      body: { code: "not-found", error: 'nothing paired or pending is named "ghost"' },
    };
    await listen();
    const d = deps(["pair", "revoke", "ghost"]);
    expect(await runSearchCli(d)).toBe(EXIT_FAILURE);
    expect(d.stderr.join("\n")).toContain('nothing paired or pending is named "ghost"');
  });
});

describe("dispatch", () => {
  it("prints the help and exits 0 when it was asked for", async () => {
    const d = deps(["--help"]);
    expect(await runSearchCli(d)).toBe(EXIT_OK);
    expect(d.stdout.join("\n")).toContain("actana-search — pair with a Search instance");
  });

  it("prints the help and exits 2 when nothing was asked for", async () => {
    const d = deps([]);
    expect(await runSearchCli(d)).toBe(EXIT_USAGE);
  });

  it("refuses an unknown noun and an unknown flag", async () => {
    expect(await runSearchCli(deps(["teleport"]))).toBe(EXIT_USAGE);
    expect(await runSearchCli(deps(["pair", "ls", "--colour"]))).toBe(EXIT_USAGE);
  });

  it("names the flag that was given no value", async () => {
    const d = deps(["pair", "new", "--label"]);
    expect(await runSearchCli(d)).toBe(EXIT_USAGE);
    expect(d.stderr.join("\n")).toContain("--label needs a value");
  });

  it("shows a noun's own help", async () => {
    const d = deps(["endpoint", "--help"]);
    expect(await runSearchCli(d)).toBe(EXIT_OK);
    expect(d.stdout.join("\n")).toContain("--key-stdin");
  });
});
