/**
 * The socket path limit, and the sentence an operator gets instead of `EINVAL`.
 *
 * The proof run pointed `SEARCH_STATE_DIR` at a 130-byte directory. `bind(2)`
 * refused it, the admin listener died with `listen EINVAL … /admin.sock` at step
 * 5 of `boot()`, and nothing in the message or the documentation said that a
 * Unix domain socket path has a length limit at all.
 *
 * The boundary asserted here was measured rather than read: on this machine a
 * bind at 104 bytes succeeds and one at 105 is `EINVAL`, which is `sun_path`
 * being 104 bytes on macOS with no room demanded for the terminator. Linux's
 * is 108 and, through libuv's `UV_PIPE_NO_TRUNCATE` bound, an unterminated
 * 108-byte path binds and 109 is `EINVAL` (measured under `node:24-slim`, libuv
 * 1.52.1). The binding half of that is asserted
 * against a real socket below, so the constant cannot drift from the kernel.
 */
import * as net from "node:net";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ADMIN_SOCKET_FILENAME,
  adminSocketPath,
  adminSocketPathProblem,
  socketPathProblem,
  SUN_PATH_MAX_BYTES,
} from "./admin-socket.ts";

const cleanup: string[] = [];

afterEach(() => {
  for (const dir of cleanup.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * A path of exactly `bytes` bytes, ending in `admin.sock`, inside a temp
 * directory that exists — a bind into a directory that does not would fail for
 * a reason that is not the one under test.
 */
function pathOfLength(bytes: number): string {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "sockpath-"));
  cleanup.push(base);
  const fixed = Buffer.byteLength(path.join(base, "x", ADMIN_SOCKET_FILENAME), "utf8");
  const dir = path.join(base, "x".repeat(bytes - fixed + 1));
  fs.mkdirSync(dir, { recursive: true });
  const full = adminSocketPath(dir);
  expect(Buffer.byteLength(full, "utf8")).toBe(bytes);
  return full;
}

describe("the admin socket path", () => {
  it("is admin.sock inside the state directory", () => {
    expect(adminSocketPath("/var/lib/search")).toBe("/var/lib/search/admin.sock");
  });

  it("accepts a path at the limit and refuses one past it", () => {
    expect(socketPathProblem(pathOfLength(SUN_PATH_MAX_BYTES))).toBeNull();
    expect(socketPathProblem(pathOfLength(SUN_PATH_MAX_BYTES + 1))).toMatch(
      new RegExp(`is ${SUN_PATH_MAX_BYTES + 1} bytes`),
    );
  });

  /** Every fact an operator needs to fix it, in the message. */
  it("says the length, the limit, the path, and both ways out", () => {
    const problem = socketPathProblem(pathOfLength(SUN_PATH_MAX_BYTES + 26));
    expect(problem).toContain("EINVAL");
    expect(problem).toContain(String(SUN_PATH_MAX_BYTES));
    expect(problem).toContain(ADMIN_SOCKET_FILENAME);
    expect(problem).toContain("SEARCH_STATE_DIR");
    expect(problem).toContain("SEARCH_ADMIN_PORT");
  });

  /** `sun_path` holds bytes, so a name with an accent in it is longer than it looks. */
  it("counts bytes rather than characters", () => {
    const over = `/tmp/${"é".repeat(SUN_PATH_MAX_BYTES / 2)}`;
    expect(over.length).toBeLessThan(SUN_PATH_MAX_BYTES);
    expect(socketPathProblem(over)).not.toBeNull();
  });

  it("asks the same question about a state directory", () => {
    const dir = "/x".repeat(SUN_PATH_MAX_BYTES);
    expect(adminSocketPathProblem(dir)).not.toBeNull();
    expect(adminSocketPathProblem("/var/lib/search")).toBeNull();
  });

  /**
   * The constant against the kernel.
   *
   * A limit this file only asserted against itself would be a limit that drifts:
   * the whole point is the number `bind(2)` uses. So one bind at the limit and
   * one past it, and the refusal has to be the `EINVAL` this guard exists to
   * pre-empt.
   */
  it("is the length the kernel actually enforces", async () => {
    const bind = (socketPath: string) =>
      new Promise<string>((resolve) => {
        const server = net.createServer();
        server.on("error", (err: NodeJS.ErrnoException) => resolve(err.code ?? "ERROR"));
        server.listen(socketPath, () => server.close(() => resolve("OK")));
      });

    expect(await bind(pathOfLength(SUN_PATH_MAX_BYTES))).toBe("OK");
    expect(await bind(pathOfLength(SUN_PATH_MAX_BYTES + 1))).toBe("EINVAL");
  });
});
