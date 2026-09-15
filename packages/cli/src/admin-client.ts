// The operator's half: HTTP over the instance's admin Unix socket.
//
// `POST /admin/pair/new`, `GET /admin/pair/clients`, `GET /admin/pair/codes`,
// `POST /admin/pair/revoke`, and `GET /admin/pair/codes`.
//
// **This surface has no authentication, and that is the design** (ADR 0008 D6).
// The socket is mode 0600 inside a 0700 directory, so reaching it *is* the
// credential — the same guarantee a Core's `pairing.json` has, expressed the
// same way. Which is why these verbs only work **on the machine that is the
// instance**, and why there is no `--host` flag: an admin surface you could
// point at another machine would be one whose guard had been removed.
//
// Two details of the server's hardening decide how this client is written, and
// both are deliberate on its side (`packages/search/src/api/admin-server.ts`):
//
//   * **`content-type: application/json` on every request, GET included.** The
//     server refuses anything else. That is what makes a cross-origin `fetch`
//     from a browser tab preflight — and the server answers no `OPTIONS`.
//   * **No `Origin` header, ever.** The server refuses any request carrying
//     one, because a browser attaches it and a CLI does not. Node's `http`
//     module sends none.
//
// `node:http` over a `socketPath` rather than `fetch`: `fetch` has no Unix
// socket in Node without a custom dispatcher, and a dispatcher is a dependency
// this package would be installing to send four requests.

import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";

/** The socket's name inside the state directory. Mirrors the server's constant. */
export const ADMIN_SOCKET_FILENAME = "admin.sock";

/** What the instance said when it refused. */
export class AdminError extends Error {
  override readonly name = "AdminError";
  readonly status: number;
  readonly code: string;
  readonly detail: unknown;

  // Fields assigned in the body: this repository runs under Node's type
  // stripping, which cannot erase a constructor parameter property.
  constructor(code: string, status: number, message: string, detail: unknown = undefined) {
    super(message);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

/**
 * Where the admin socket is, in the order an operator would expect:
 * `--admin-socket`, then `SEARCH_ADMIN_SOCKET`, then
 * `$SEARCH_STATE_DIR/admin.sock`, then `~/.actana-search/admin.sock` — which is
 * `SEARCH_STATE_DIR`'s own default, so an instance started with no
 * configuration at all is still reachable with no flags.
 */
export function resolveAdminSocket(options: {
  flag?: string | null;
  env?: NodeJS.ProcessEnv;
  home?: string;
}): string {
  const env = options.env ?? process.env;
  if (options.flag) return options.flag;
  if (env.SEARCH_ADMIN_SOCKET) return env.SEARCH_ADMIN_SOCKET;
  const stateDir = env.SEARCH_STATE_DIR ?? path.join(options.home ?? os.homedir(), ".actana-search");
  return path.join(stateDir, ADMIN_SOCKET_FILENAME);
}

export type AdminRequest = {
  method: "GET" | "POST";
  path: string;
  body?: unknown;
  timeoutMs?: number;
};

/** The default per-request budget. Nothing on this socket is slow. */
export const ADMIN_TIMEOUT_MS = 10_000;

/** A client bound to one socket path. */
export class AdminClient {
  readonly socketPath: string;
  private readonly timeoutMs: number;

  constructor(socketPath: string, options: { timeoutMs?: number } = {}) {
    this.socketPath = socketPath;
    this.timeoutMs = options.timeoutMs ?? ADMIN_TIMEOUT_MS;
  }

  /** One request. A non-2xx becomes an {@link AdminError}. */
  request<T>(req: AdminRequest): Promise<T> {
    const payload = req.body === undefined ? "" : JSON.stringify(req.body);
    return new Promise<T>((resolve, reject) => {
      const request = http.request(
        {
          socketPath: this.socketPath,
          path: req.path,
          method: req.method,
          headers: {
            // On every request, GET included: the server reads this and nothing
            // else, and a CORS-simple type would be a type a browser could send
            // without a preflight.
            "content-type": "application/json",
            accept: "application/json",
            "content-length": Buffer.byteLength(payload),
          },
          timeout: req.timeoutMs ?? this.timeoutMs,
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            const status = response.statusCode ?? 0;
            let parsed: unknown;
            try {
              parsed = text === "" ? undefined : JSON.parse(text);
            } catch {
              parsed = { raw: text };
            }
            if (status >= 200 && status < 300) return resolve(parsed as T);
            const failure = (parsed ?? {}) as {
              code?: unknown;
              error?: unknown;
              message?: unknown;
              detail?: unknown;
            };
            reject(
              new AdminError(
                typeof failure.code === "string" ? failure.code : `http-${status}`,
                status,
                typeof failure.error === "string"
                  ? failure.error
                  : typeof failure.message === "string"
                    ? failure.message
                    : `${req.method} ${req.path} answered ${status}`,
                failure.detail,
              ),
            );
          });
        },
      );

      request.on("timeout", () => {
        request.destroy(
          new AdminError(
            "timeout",
            0,
            `the instance did not answer on ${this.socketPath} within ${req.timeoutMs ?? this.timeoutMs}ms`,
          ),
        );
      });

      request.on("error", (err: NodeJS.ErrnoException) => {
        if (err instanceof AdminError) return reject(err);
        reject(adminDialError(err, this.socketPath));
      });

      if (payload) request.write(payload);
      request.end();
    });
  }
}

/**
 * Turn a socket error into something an operator can act on.
 *
 * The three that actually happen each have a different next step, and "connect
 * ENOENT /Users/…/admin.sock" is not one of them.
 */
function adminDialError(err: NodeJS.ErrnoException, socketPath: string): AdminError {
  if (err.code === "ENOENT") {
    return new AdminError(
      "no-instance",
      0,
      `no Search instance is listening on ${socketPath}.\n` +
        "These verbs run on the machine that IS the instance. Start it, or point at its " +
        "socket with --admin-socket (or SEARCH_ADMIN_SOCKET / SEARCH_STATE_DIR).",
    );
  }
  if (err.code === "EACCES" || err.code === "EPERM") {
    return new AdminError(
      "forbidden",
      0,
      `${socketPath} is not readable by this user.\n` +
        "The admin socket is mode 0600 and reaching it is the credential — run as the user " +
        "the instance runs as.",
    );
  }
  if (err.code === "ECONNREFUSED") {
    return new AdminError(
      "no-instance",
      0,
      `${socketPath} exists but nothing is answering on it — the instance is probably stopped. ` +
        "A stale socket is removed the next time it starts.",
    );
  }
  return new AdminError("admin-error", 0, `${socketPath}: ${err.message}`);
}

// ─── The four pairing routes ────────────────────────────────────────────────

export type MintedCode = {
  sessionId: string;
  code: string;
  /** `<sessionId>:<XXXX-XXXX>` — what an operator reads out as one token. */
  ticket: string;
  expiresAt: string;
  caFingerprint: string;
  endpoint: string;
  scope: string;
  kbIds: string[] | null;
};

export type PairedClientRow = {
  id: string;
  label: string;
  platform: string | null;
  scope: string;
  kbIds: string[] | null;
  certSerial: string;
  certFingerprint: string;
  certNotAfter: string | null;
  pairedAt: string;
  revokedAt: string | null;
};

export type PendingCodeRow = {
  sessionId: string;
  label: string;
  scope: string;
  kbIds: string[] | null;
  expiresAt: string;
  attempts: number;
  attemptCap: number;
  consumedAt: string | null;
  revokedAt: string | null;
};

export type RevokedRow = {
  kind: "client" | "code";
  id: string;
  certSerial?: string;
  revokedAt: string | null;
};

export function mintPairingCode(
  client: AdminClient,
  body: { label?: string; scope?: string; kbIds?: string[] | null; ttlMs?: number },
): Promise<MintedCode> {
  return client.request<MintedCode>({ method: "POST", path: "/admin/pair/new", body });
}

export function listPairedClients(client: AdminClient): Promise<{ clients: PairedClientRow[] }> {
  return client.request({ method: "GET", path: "/admin/pair/clients" });
}

export function listPendingCodes(client: AdminClient): Promise<{ codes: PendingCodeRow[] }> {
  return client.request({ method: "GET", path: "/admin/pair/codes" });
}

export function revokePairing(
  client: AdminClient,
  id: string,
): Promise<{ revoked: RevokedRow }> {
  return client.request({ method: "POST", path: "/admin/pair/revoke", body: { id } });
}
