/**
 * Every SSE response the app sends goes through `sseStream`, so proxies stream it instead of
 * buffering it. The app runs behind cloudflared (Cloudflare Tunnel), and may sit behind nginx.
 *
 * - `Content-Type: text/event-stream`: what cloudflared and Cloudflare look at to stream a
 *   response and flush each chunk.
 * - `Cache-Control: no-cache, no-transform`: `no-transform` stops intermediaries from
 *   compressing or rewriting the body, which would buffer it.
 * - `X-Accel-Buffering: no`: turns off nginx proxy buffering for this response.
 * - An SSE comment sent first: Node holds the status line and headers until the first body byte.
 *   Without it, a stream with nothing to send yet (the case stream waits up to 10 s for its case
 *   row) shows the proxy no response at all. Clients ignore comment lines.
 */

import { ServerSentEventGenerator } from "@starfederation/datastar-sdk/web";

export const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache, no-transform",
  "X-Accel-Buffering": "no",
} as const;

const PREAMBLE = new TextEncoder().encode(": stream open\n\n");

export function sseStream(onStart: (sse: ServerSentEventGenerator) => Promise<void> | void): Response {
  const res = ServerSentEventGenerator.stream(onStart, { responseInit: { headers: SSE_HEADERS } });
  const reader = res.body!.getReader();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(PREAMBLE);
    },
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return new Response(body, { status: res.status, headers: res.headers });
}
