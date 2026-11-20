/**
 * Records every SIE call made by this process: raw response, latency, and a disk cache so a rerun
 * never repeats a model call it already paid for.
 *
 * It wraps the two methods on the shared client instance (`getSieClient()`), in this process
 * only. Production code (src/lib/sie.ts, src/lib/product-decisions) is used unchanged.
 * A cached call reports the latency measured when it really ran, and is marked `cached`.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getSieClient } from "../../src/lib/sie";

export interface CallRecord {
  method: "chatCompletions" | "extract";
  key: string;
  model: string;
  latencyMs: number;
  cached: boolean;
  ok: boolean;
  error?: string;
  /** Request without image bytes. */
  request: unknown;
  response?: unknown;
}

const stripImages = (v: unknown): unknown =>
  JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "string" && x.startsWith("data:image/") ? `<${x.slice(5, x.indexOf(";"))} ${x.length} chars>` : x)));

export function installRecorder(cacheDir: string) {
  const client = getSieClient() as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
  const log: CallRecord[] = [];

  function wrap(method: CallRecord["method"], modelOf: (args: unknown[]) => string) {
    const original = client[method].bind(client);
    client[method] = async (...args: unknown[]) => {
      const key = createHash("sha256").update(method).update(JSON.stringify(args)).digest("hex");
      const file = join(cacheDir, `${key}.json`);
      const request = stripImages(args);
      try {
        const hit = JSON.parse(await readFile(file, "utf8")) as { response: unknown; latencyMs: number };
        log.push({ method, key, model: modelOf(args), latencyMs: hit.latencyMs, cached: true, ok: true, request, response: hit.response });
        return hit.response;
      } catch {
        /* not cached */
      }
      const t0 = performance.now();
      try {
        const response = await original(...args);
        const latencyMs = Math.round(performance.now() - t0);
        await mkdir(cacheDir, { recursive: true });
        await writeFile(file, JSON.stringify({ method, at: new Date().toISOString(), latencyMs, request, response }));
        log.push({ method, key, model: modelOf(args), latencyMs, cached: false, ok: true, request, response });
        return response;
      } catch (e) {
        // Failures are not cached, so a transient error is retried on the next run.
        log.push({ method, key, model: modelOf(args), latencyMs: Math.round(performance.now() - t0), cached: false, ok: false, error: e instanceof Error ? e.message : String(e), request });
        throw e;
      }
    };
  }

  wrap("chatCompletions", (a) => String((a[0] as { model?: string })?.model));
  wrap("extract", (a) => String(a[0]));
  return {
    /** Calls recorded since the given index. */
    since: (i: number) => log.slice(i),
    get count() {
      return log.length;
    },
  };
}
