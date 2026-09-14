/**
 * `GET /v1/events` — server-sent events, one stream per paired client.
 *
 * The frame is the standard one: `event: <name>` then `data: <json>` then a
 * blank line. A `: heartbeat` comment every fifteen seconds keeps a proxy from
 * deciding the connection is idle and closing it; a comment rather than an
 * event because a client should not have to filter keep-alives out of its own
 * event handling.
 *
 * The stream is scoped by the certificate like every other route (ADR 0003):
 * the subscription is opened against this caller's paired-client id and is
 * handed nothing else. It is also strictly in-process — a second instance's
 * events do not appear here, which is the honest limit of SSE without a broker
 * and the reason the durable path is the webhook.
 */

import { onSearchEvent } from "../../events/emitter.ts";
import { route } from "../http.ts";
import type { SearchRouter } from "../routes.ts";

/** Long enough to be cheap, short enough to beat the usual 30–60 s idle timeout. */
export const SSE_HEARTBEAT_MS = 15_000;

export function registerEventRoutes(router: SearchRouter): void {
  router.add(
    route("GET", "/v1/events", "read", ({ req, res, client }) => {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        connection: "keep-alive",
        // Nagle would hold a single small frame back waiting for company.
        "x-accel-buffering": "no",
      });
      res.write(": open\n\n");

      const unsubscribe = onSearchEvent(client!.id, (event) => {
        res.write(`event: ${event.event}\ndata: ${JSON.stringify(event)}\n\n`);
      });

      const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), SSE_HEARTBEAT_MS);
      // `unref` so an open stream is never what keeps the process alive.
      heartbeat.unref?.();

      const close = (): void => {
        clearInterval(heartbeat);
        unsubscribe();
      };
      req.on("close", close);
      req.on("error", close);
      res.on("close", close);

      /**
       * The handler returns while the response stays open, which is the whole
       * point of the route. The router's `try/catch` is already behind it, and
       * `res.end()` is never called here — the client closing the connection is
       * what ends this stream.
       */
    }),
  );
}
