/**
 * `deploy/healthcheck.mjs` — the container probe, both roles.
 *
 * The probe is not part of this package; it is the one file the image copies
 * out of `deploy/` (ADR 0010 D10) and the only code in this repository that
 * nothing else imports, which is exactly why it was broken in production and
 * green in CI. Two ways it was broken, and this suite is one assertion per way:
 *
 *   1. **It was not in the image at all** — `HEALTHCHECK` ran
 *      `/app/deploy/healthcheck.mjs` and `deploy/` was never copied. That is a
 *      `Dockerfile` fact and the docker build proves it, not a test.
 *   2. **`SEARCH_ROLE=worker` threw before it dialled anything.** The role
 *      dispatch sat above the RESP helpers it uses, so the hoisted
 *      `probeRedis()` ran inside their temporal dead zone and every worker
 *      container was permanently unhealthy with `ReferenceError: Cannot access
 *      'command' before initialization`. A unit test of the module alone would
 *      not have caught that — the bug was in the *order of the file* — so the
 *      behavioural half **spawns** the probe, the way Docker does, and asserts
 *      both roles reach their socket.
 *
 * The encoding half imports the module. The specifier is built at run time on
 * purpose: `deploy/` is outside this package's `tsconfig`, and a literal import
 * of a `.mjs` with no types would be a typecheck failure rather than a test.
 *
 * @vitest-environment node
 */
import { spawn } from "node:child_process";
import * as net from "node:net";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

const PROBE = path.resolve(import.meta.dirname, "../../../../deploy/healthcheck.mjs");

type ProbeModule = {
  isWorkerRole(role: string | undefined): boolean;
  bulk(value: string): string;
  command(...args: string[]): string;
  respPayload(credentials: { username: string; password: string }): string;
};

let probe: ProbeModule;

beforeAll(async () => {
  probe = (await import(pathToFileURL(PROBE).href)) as ProbeModule;
});

/** What the probe printed, and what it exited with. */
type Run = { code: number | null; stdout: string; stderr: string };

function runProbe(env: Record<string, string>): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [PROBE], {
      // A clean environment plus what the case is about: the developer's own
      // `SEARCH_*` variables must not decide which port the probe dials.
      env: { PATH: process.env.PATH ?? "", SEARCH_HEALTHCHECK_TIMEOUT_MS: "2000", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/**
 * The same probe, **imported rather than run** — `node -e` loading it as an
 * ordinary module, which is the one thing a spawned entry point cannot be.
 *
 * Both halves of the guard are false here, and for the two different reasons
 * it has two halves: `import.meta.main` because this module is not the entry
 * point, and `process.argv[1] === import.meta.filename` because `-e` leaves
 * `process.argv[1]` unset.
 */
function runImported(env: Record<string, string>): Promise<Run> {
  const wrapper =
    "import(process.env.PROBE_URL).then(" +
    "() => process.stdout.write('imported-and-did-not-probe'), " +
    "(err) => { process.stderr.write(String(err)); process.exit(3) })";
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["-e", wrapper], {
      env: {
        PATH: process.env.PATH ?? "",
        PROBE_URL: pathToFileURL(PROBE).href,
        SEARCH_HEALTHCHECK_TIMEOUT_MS: "2000",
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/** Sockets opened by a test, closed whatever it did. */
const servers: net.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

/**
 * A Redis, as much of one as `PING` needs: it answers `reply` to whatever
 * arrives. Resolves with the port it is listening on.
 */
async function fakeRedis(reply: string): Promise<number> {
  const server = net.createServer((socket) => {
    socket.on("data", () => socket.write(reply));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as net.AddressInfo).port;
}

/** A port nothing is listening on: opened, its number taken, then closed. */
async function closedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe("the RESP the worker probe writes", () => {
  it("encodes a bulk string with its byte length, not its character count", () => {
    expect(probe.bulk("PING")).toBe("$4\r\nPING\r\n");
    // Two bytes per `é` in UTF-8, and Redis counts bytes.
    expect(probe.bulk("é")).toBe("$2\r\né\r\n");
  });

  it("encodes PING as a one-element RESP array", () => {
    expect(probe.command("PING")).toBe("*1\r\n$4\r\nPING\r\n");
  });

  it("pipelines AUTH before PING, with and without a username", () => {
    expect(probe.respPayload({ username: "", password: "" })).toBe("*1\r\n$4\r\nPING\r\n");
    expect(probe.respPayload({ username: "", password: "s3cret" })).toBe(
      "*2\r\n$4\r\nAUTH\r\n$6\r\ns3cret\r\n*1\r\n$4\r\nPING\r\n",
    );
    expect(probe.respPayload({ username: "default", password: "s3cret" })).toBe(
      "*3\r\n$4\r\nAUTH\r\n$7\r\ndefault\r\n$6\r\ns3cret\r\n*1\r\n$4\r\nPING\r\n",
    );
  });

  it("reads the role the way the compose file writes it", () => {
    expect(probe.isWorkerRole("worker")).toBe(true);
    expect(probe.isWorkerRole(" Worker ")).toBe(true);
    expect(probe.isWorkerRole("api")).toBe(false);
    expect(probe.isWorkerRole("")).toBe(false);
    expect(probe.isWorkerRole(undefined)).toBe(false);
  });
});

describe("SEARCH_ROLE=worker probes Redis", () => {
  it("exits 0 when Redis answers +PONG", async () => {
    const port = await fakeRedis("+PONG\r\n");
    const run = await runProbe({
      SEARCH_ROLE: "worker",
      SEARCH_REDIS_URL: `redis://127.0.0.1:${port}`,
    });
    expect(run.stderr).toBe("");
    expect(run.code).toBe(0);
  });

  /**
   * The regression test for the blocker.
   *
   * What made it a blocker is that the probe never got as far as the socket:
   * whatever Redis was doing, the answer was a `ReferenceError` and a
   * permanently unhealthy container. So the assertion is on the *shape* of the
   * failure — a refused connection, named — as much as on the exit code.
   */
  it("exits 1 naming the refused connection, and not a ReferenceError", async () => {
    const port = await closedPort();
    const run = await runProbe({
      SEARCH_ROLE: "worker",
      SEARCH_REDIS_URL: `redis://127.0.0.1:${port}`,
    });
    expect(run.stderr).not.toMatch(/ReferenceError/);
    expect(run.stderr).toMatch(new RegExp(`unhealthy: redis at 127\\.0\\.0\\.1:${port}`));
    expect(run.stderr).toMatch(/ECONNREFUSED/);
    expect(run.code).toBe(1);
  });

  it("exits 1 when Redis answers an error instead of a PONG", async () => {
    const port = await fakeRedis("-NOAUTH Authentication required.\r\n");
    const run = await runProbe({
      SEARCH_ROLE: "worker",
      SEARCH_REDIS_URL: `redis://127.0.0.1:${port}`,
    });
    expect(run.stderr).toMatch(/refused PING \(-NOAUTH/);
    expect(run.code).toBe(1);
  });

  it("exits 1 when SEARCH_REDIS_URL is not a URL", async () => {
    const run = await runProbe({ SEARCH_ROLE: "worker", SEARCH_REDIS_URL: "not a url" });
    expect(run.stderr).toMatch(/SEARCH_REDIS_URL is not a URL/);
    expect(run.code).toBe(1);
  });
});

describe("every other role probes the API", () => {
  /**
   * The other half of "the probe knows which role it is in": an unset
   * `SEARCH_ROLE` must dial `GET /v1/health` on `SEARCH_PORT` and must not
   * touch `SEARCH_REDIS_URL`. A closed port is enough to tell which one it
   * went for, and it also proves this branch does not throw before dialling.
   */
  it("exits 1 naming the port it could not reach, and not a ReferenceError", async () => {
    const port = await closedPort();
    const run = await runProbe({
      SEARCH_PORT: String(port),
      SEARCH_HEALTHCHECK_HOST: "127.0.0.1",
      // If the API branch ever probed Redis instead, this would be the +PONG
      // that made the test pass for the wrong reason. It is a closed port.
      SEARCH_REDIS_URL: `redis://127.0.0.1:${port}`,
      SEARCH_STATE_DIR: path.join(import.meta.dirname, "no-such-state-dir"),
    });
    expect(run.stderr).not.toMatch(/ReferenceError/);
    expect(run.stderr).toMatch(/unhealthy: .*ECONNREFUSED/);
    expect(run.code).toBe(1);
  });
});

/**
 * The guard on the dispatch, from the other side.
 *
 * Every case above spawns the file, so every case above has
 * `import.meta.main === true` and exercises one branch of
 * `import.meta.main ?? process.argv[1] === import.meta.filename`. This is the
 * other branch: the module imported, as the encoding half of this suite
 * imports it, and as anything that ever wants `respPayload` will. A guard that
 * stopped holding would turn that import into a live Redis probe and an
 * `process.exit()` in the middle of somebody's test run.
 *
 * **What is still not asserted, and cannot be here.** The `??` exists because
 * `import.meta.main` does not exist below Node 24.2 — and `engines` admits
 * 24.0 — where the property is `undefined` and the `process.argv[1]`
 * comparison is the whole of the answer. There is no way to make a real
 * `import.meta.main` undefined on a runtime that has it, short of rewriting
 * the module's source through a loader hook, which would be a test of the
 * rewrite. So the fallback's *true* branch is covered only by running this
 * suite on such a runtime.
 */
describe("the dispatch runs only when the file is the entry point", () => {
  it("does nothing at all when the module is imported instead of run", async () => {
    // The environment of a worker container that is one dispatch away from
    // dialling: if the guard let go, this is an ECONNREFUSED and an exit 1.
    const port = await closedPort();
    const run = await runImported({
      SEARCH_ROLE: "worker",
      SEARCH_REDIS_URL: `redis://127.0.0.1:${port}`,
    });
    expect(run.stdout).toBe("imported-and-did-not-probe");
    expect(run.stderr).toBe("");
    expect(run.code).toBe(0);
  });

  it("does nothing on the API branch either", async () => {
    const port = await closedPort();
    const run = await runImported({
      SEARCH_PORT: String(port),
      SEARCH_HEALTHCHECK_HOST: "127.0.0.1",
      SEARCH_STATE_DIR: path.join(import.meta.dirname, "no-such-state-dir"),
    });
    expect(run.stdout).toBe("imported-and-did-not-probe");
    expect(run.stderr).toBe("");
    expect(run.code).toBe(0);
  });
});
