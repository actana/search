#!/usr/bin/env node
// Container health probe, for both of the roles this image runs (ADR 0010 D2).
//
// **`SEARCH_ROLE=worker` probes Redis; anything else probes the API.** The image
// carries one `HEALTHCHECK`, and the split deployment runs the *same image* a
// second time with `command: [..., worker.ts]` and `ports: []`. That container
// has no listener on 7443, so an API probe there is a container that is
// permanently unhealthy while doing its job perfectly — which in compose means
// `--wait` never returns, a `depends_on: service_healthy` never fires, and an
// orchestrator restarts a healthy worker in a loop. Docker gives no way to
// override a healthcheck per service other than replacing it, so the probe is
// what knows about the roles.
//
// A worker's liveness is "can it still reach the queue it recovers through".
// That is Redis, and it is asked the way a client would: `PING`, over the same
// `SEARCH_REDIS_URL` the worker dials. Not queue *depth* — a backlog is a
// capacity question and restarting the container is the wrong answer to it
// (ADR 0010) — and not the database, which the API probe does not check either.
//
// ## The API role
//
// `GET /v1/health` — the second of the two open paths (ADR 0008 D5). It grants
// nothing, mutates nothing, reads no client, and answers `{ ok, schemaVersion }`,
// which is exactly what a probe with no client certificate is allowed to learn.
// A health check that needed a credential is a health check the thing that
// restarts the process cannot run.
//
// **It pins the instance's own CA when it can.** The CA certificate is inside
// `$SEARCH_STATE_DIR/material.json`, which this process can read because it runs
// in the container as the user that owns it. Pinning against it is what turns
// "something answered TLS on 7443" into "the instance I am supposed to be
// watching answered". The hostname is `localhost`, because every server
// certificate this repository issues carries `localhost` and `127.0.0.1` in its
// SANs (`packages/shared/src/pairing/cert-material.ts`) whatever else the
// operator configured.
//
// **Without the material it falls back to the handshake alone.** That is the
// first seconds of a fresh container, before the instance has written its own
// identity, and a probe that failed then would restart an instance that is
// starting correctly. The fallback is `rejectUnauthorized: false`, which is
// honest about what it proves — the listener is up — and it is not the path
// taken once there is state.
//
// It does not check the worker. Split out, the worker has the probe above; in
// the combined process a worker that has stopped taking jobs is a queue-depth
// question rather than a liveness one, and restarting the container is the
// wrong answer to it (ADR 0010).

import { readFileSync } from "node:fs";
import * as https from "node:https";
import * as net from "node:net";
import * as path from "node:path";
import * as tls from "node:tls";

const timeoutMs = Number.parseInt(process.env.SEARCH_HEALTHCHECK_TIMEOUT_MS ?? "4000", 10);

const fail = (why) => {
  console.error(`unhealthy: ${why}`);
  process.exit(1);
};

/** Whether `SEARCH_ROLE` selects the worker probe. Anything else is the API. */
export function isWorkerRole(role) {
  return (role ?? "").trim().toLowerCase() === "worker";
}

// ---------------------------------------------------------------------------
// The worker role
// ---------------------------------------------------------------------------

/**
 * One RESP bulk-string argument.
 *
 * A `function` declaration and not a `const` arrow, which is the whole of a bug
 * every worker container this image produced had: the role dispatch used to sit
 * *above* these two helpers, so `probeRedis()` — hoisted, as a declaration —
 * ran while `command` was still in its temporal dead zone and the probe died
 * with `ReferenceError: Cannot access 'command' before initialization`. Docker
 * reads that as unhealthy, forever, on a worker that is working perfectly. The
 * dispatch is at the bottom of the file now, and these are declarations too, so
 * neither half of that can come back on its own.
 */
export function bulk(value) {
  return `$${Buffer.byteLength(value)}\r\n${value}\r\n`;
}

/** A RESP array command, e.g. `command("PING")`. */
export function command(...args) {
  return `*${args.length}\r\n` + args.map(bulk).join("");
}

/**
 * The bytes the worker probe writes: an `AUTH` when the URL carries
 * credentials, then the `PING`.
 *
 * Its own function so the encoding is testable without a socket — the probe
 * itself ends in `process.exit`, which a unit test cannot call twice.
 */
export function respPayload({ username, password }) {
  const auth = password
    ? username
      ? command("AUTH", username, password)
      : command("AUTH", password)
    : "";
  return auth + command("PING");
}

/**
 * `PING` the queue's Redis and expect `+PONG`.
 *
 * Hand-rolled RESP over a socket rather than through ioredis: this file runs
 * with no dependencies of its own so that a probe cannot be broken by a
 * `--prod` install that left something out, and `PING` is nine bytes.
 *
 * `AUTH` first when the URL carries credentials — pipelined with the `PING`, so
 * a password-protected Redis is one round trip like an open one, and a refused
 * password shows up as the absence of `+PONG`.
 */
export function probeRedis() {
  let url;
  try {
    url = new URL(process.env.SEARCH_REDIS_URL ?? "redis://localhost:6379");
  } catch {
    return fail(`SEARCH_REDIS_URL is not a URL`);
  }
  const secure = url.protocol === "rediss:";
  const port = Number.parseInt(url.port || "6379", 10);
  const host = url.hostname || "localhost";

  const payload = respPayload({
    username: url.username ? decodeURIComponent(url.username) : "",
    password: url.password ? decodeURIComponent(url.password) : "",
  });

  const socket = secure
    ? tls.connect({ host, port, servername: host, rejectUnauthorized: false })
    : net.connect({ host, port });

  let seen = "";
  socket.setTimeout(timeoutMs);
  socket.on(secure ? "secureConnect" : "connect", () => socket.write(payload));
  socket.on("data", (chunk) => {
    seen += chunk.toString("utf8");
    if (seen.includes("+PONG")) {
      socket.destroy();
      process.exit(0);
    }
    // `-NOAUTH`, `-WRONGPASS`, `-ERR` — an answer, and not the one wanted.
    if (seen.startsWith("-") || seen.includes("\r\n-")) {
      socket.destroy();
      // The first line only: never the password, which is not echoed anyway.
      fail(`redis at ${host}:${port} refused PING (${seen.split("\r\n")[0]})`);
    }
  });
  socket.on("timeout", () => {
    socket.destroy();
    fail(`redis at ${host}:${port} did not answer PING within ${timeoutMs}ms`);
  });
  socket.on("error", (err) => fail(`redis at ${host}:${port}: ${err.message}`));
  socket.on("close", () => fail(`redis at ${host}:${port} closed without answering PING`));
}

// ---------------------------------------------------------------------------
// The API role
// ---------------------------------------------------------------------------

/** The instance's CA certificate, or null before it has written one. */
function loadCa(stateDir) {
  try {
    const material = JSON.parse(readFileSync(path.join(stateDir, "material.json"), "utf8"));
    return typeof material?.caCert === "string" && material.caCert ? material.caCert : null;
  } catch {
    return null;
  }
}

export function probeApi() {
  const port = Number.parseInt(process.env.SEARCH_PORT ?? "7443", 10);
  const host = process.env.SEARCH_HEALTHCHECK_HOST ?? "localhost";
  const stateDir = process.env.SEARCH_STATE_DIR ?? "/var/lib/actana-search";

  const ca = loadCa(stateDir);
  const request = https.request(
    {
      host,
      port,
      path: "/v1/health",
      method: "GET",
      headers: { accept: "application/json" },
      timeout: timeoutMs,
      ...(ca ? { ca, rejectUnauthorized: true } : { rejectUnauthorized: false }),
    },
    (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        if (response.statusCode !== 200) {
          return fail(`/v1/health answered ${response.statusCode}`);
        }
        let body;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          return fail("/v1/health answered 200 with something that was not JSON");
        }
        // `ok: false` is the instance saying it is not well. Believe it.
        if (body?.ok !== true) return fail(`/v1/health reports not ok: ${JSON.stringify(body)}`);
        process.exit(0);
      });
    },
  );

  request.on("timeout", () => {
    request.destroy();
    fail(`/v1/health did not answer within ${timeoutMs}ms`);
  });
  request.on("error", (err) => fail(err.message));
  request.end();
}

// ---------------------------------------------------------------------------
// The dispatch
// ---------------------------------------------------------------------------

/**
 * Last, so that nothing it calls can be in a temporal dead zone, and guarded so
 * the module can be imported by a test without probing anything.
 *
 * `import.meta.main` is true exactly when this file is the entry point, which
 * is what `HEALTHCHECK CMD ["node", "/app/deploy/healthcheck.mjs"]` makes it.
 * A test that imports the module gets the helpers and no exit; the probe's real
 * behaviour is asserted by spawning this file, because a guard that silently
 * stopped matching would be a health check that always passes.
 *
 * **And it is `undefined` below Node 24.2**, where the property does not exist
 * — so on an older runtime than this repo's floor the guard was simply false,
 * the probe never ran, and `node healthcheck.mjs` exited 0 without opening a
 * socket: a health check that passes for a container that is not listening,
 * which is the worst answer of the three. `process.argv[1]` compared against
 * this file is the same question asked the way every Node version can answer
 * it, and `??` keeps `import.meta.main` as the primary where it exists.
 */
if (import.meta.main ?? process.argv[1] === import.meta.filename) {
  if (isWorkerRole(process.env.SEARCH_ROLE)) probeRedis();
  else probeApi();
}
