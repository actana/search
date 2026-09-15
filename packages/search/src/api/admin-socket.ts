/**
 * Where the admin socket lives, and whether the kernel will accept the path.
 *
 * A leaf module with two imports from `node:` and nothing else, because both
 * `config.ts` — which validates `SEARCH_STATE_DIR` before anything is opened —
 * and `api/admin-server.ts` — which opens it — need this, and `config.ts` is
 * imported by half the tree.
 *
 * **Why the length check exists.** A Unix domain socket path is not an ordinary
 * path: it is copied into `sockaddr_un.sun_path`, a fixed-size array, and a
 * longer one is refused by `bind(2)` with `EINVAL`. The proof run named a
 * 130-byte state directory, and the failure it got was
 * `listen EINVAL … /admin.sock` at **step 5 of `boot()`** — after the migrations
 * had run, after the identity was minted and after the API listener was already
 * answering `/v1/health`. Nothing about `EINVAL` says "your path is too long",
 * and nothing in the documentation said the limit existed.
 */

import * as os from "node:os";
import * as path from "node:path";

/** The socket's name inside `SEARCH_STATE_DIR`. */
export const ADMIN_SOCKET_FILENAME = "admin.sock";

/** Where the admin socket lives for a given state directory. */
export function adminSocketPath(stateDir: string): string {
  return path.join(stateDir, ADMIN_SOCKET_FILENAME);
}

/**
 * The most bytes a Unix socket path may have, for this platform.
 *
 * `sun_path` is 104 bytes on macOS and the BSDs and 108 on Linux, and the bound
 * that decides it is libuv's rather than the kernel's terminator rule: Node
 * binds through `uv_pipe_bind2` with `UV_PIPE_NO_TRUNCATE`, which refuses only a
 * name longer than `sizeof(sun_path)` and copies one that fills the array
 * without a trailing NUL. Linux accepts that unterminated 108-byte path (its
 * `unix(7)` address length carries the size), so 108 binds and 109 is `EINVAL`
 * — measured under `node:24-slim`, libuv 1.52.1. macOS likewise binds at 104 and
 * refuses 105. Anything else gets the smaller of the two, which is the safe
 * guess.
 */
export const SUN_PATH_MAX_BYTES = os.platform() === "linux" ? 108 : 104;

/**
 * What is wrong with this socket path, or `null`.
 *
 * Bytes, not characters: `sun_path` holds the encoded path, so a directory name
 * with an accent in it is longer than it looks. Both callers pass the path they
 * are about to bind — `config.ts` builds it from `SEARCH_STATE_DIR`,
 * `admin-server.ts` has been handed one — so the number in the message is the
 * number the bind would have measured.
 */
export function socketPathProblem(socketPath: string): string | null {
  const bytes = Buffer.byteLength(socketPath, "utf8");
  if (bytes <= SUN_PATH_MAX_BYTES) return null;
  return (
    `the socket path is ${bytes} bytes (${socketPath}), and a Unix domain socket path may be at ` +
    `most ${SUN_PATH_MAX_BYTES} on ${os.platform()} (the size of sun_path) — binding a longer one fails ` +
    "with EINVAL. Point SEARCH_STATE_DIR at a shorter directory (its own path has " +
    `${SUN_PATH_MAX_BYTES - ADMIN_SOCKET_FILENAME.length - 1} bytes to spend), or set ` +
    "SEARCH_ADMIN_PORT to put the admin surface on a loopback port instead."
  );
}

/** The same question about a state directory's `admin.sock`. */
export function adminSocketPathProblem(stateDir: string): string | null {
  return socketPathProblem(adminSocketPath(stateDir));
}
