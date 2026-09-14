#!/usr/bin/env node
// Container health probe.
//
// `GET /health` is behind the same TLS as everything else, and the probe has no
// client certificate — so it checks that the listener answers the handshake at
// all, not that it answers authorised. `rejectUnauthorized: false` is correct
// here and only here: the certificate being verified would be the instance's
// own, by the instance itself, which proves nothing either way.

import { connect } from "node:tls";

const port = Number.parseInt(process.env.SEARCH_PORT ?? "7443", 10);
const host = process.env.SEARCH_HEALTHCHECK_HOST ?? "127.0.0.1";
const timeoutMs = Number.parseInt(process.env.SEARCH_HEALTHCHECK_TIMEOUT_MS ?? "4000", 10);

const socket = connect({ host, port, rejectUnauthorized: false, timeout: timeoutMs });

const fail = (why) => {
  console.error(`unhealthy: ${why}`);
  socket.destroy();
  process.exit(1);
};

socket.on("secureConnect", () => {
  socket.end();
  process.exit(0);
});
socket.on("timeout", () => fail(`no TLS handshake within ${timeoutMs}ms`));
socket.on("error", (err) => fail(err.message));
