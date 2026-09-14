#!/usr/bin/env node
// Container health probe.
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
// It does not check the worker. A worker that has stopped taking jobs is a
// queue-depth question, not a liveness one, and restarting the container is the
// wrong answer to it (ADR 0010).

import { readFileSync } from "node:fs";
import * as https from "node:https";
import * as path from "node:path";

const port = Number.parseInt(process.env.SEARCH_PORT ?? "7443", 10);
const host = process.env.SEARCH_HEALTHCHECK_HOST ?? "localhost";
const timeoutMs = Number.parseInt(process.env.SEARCH_HEALTHCHECK_TIMEOUT_MS ?? "4000", 10);
const stateDir = process.env.SEARCH_STATE_DIR ?? "/var/lib/actana-search";

const fail = (why) => {
  console.error(`unhealthy: ${why}`);
  process.exit(1);
};

/** The instance's CA certificate, or null before it has written one. */
function loadCa() {
  try {
    const material = JSON.parse(readFileSync(path.join(stateDir, "material.json"), "utf8"));
    return typeof material?.caCert === "string" && material.caCert ? material.caCert : null;
  } catch {
    return null;
  }
}

const ca = loadCa();
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
