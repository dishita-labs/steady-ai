/**
 * Stage 2: GLiNER2.5 Decide answers each checklist question over each chunk of each page.
 *
 * Batch-texts mode (as in the hazard experiment): ONE question per request, over up to
 * BATCH_TEXTS chunks, `extract(model, items[], { outputSchema: { q } })`. A page's answer to an
 * item is the max P(yes) over its chunks, because a product page states a spec once, somewhere.
 * Chunks with P(yes) ≥ threshold are the evidence passages handed to the numeric parser.
 */

import { chunkText, toTypedAnswer, type DecideQuestion } from "../../src/lib/product-decisions";
import { envOr } from "../../src/lib/config";
import { getSieClient } from "../../src/lib/sie";
import { questionsOf, type ChecklistItem } from "./checklist";
import { readText, type CollectedPage, type ReadSource } from "./collect";

export const CHUNK_CHARS = 1400;
export const BATCH_TEXTS = 16;

export interface ChunkRead {
  chunk: number;
  /** P(yes), or null when the call failed. */
  pYes: number | null;
}

export interface ItemRead {
  url: string;
  itemId: string;
  chunks: ChunkRead[];
}

export interface DecideRun {
  /** url → chunk texts, so the parser and the report can quote them. */
  chunks: Record<string, string[]>;
  reads: ItemRead[];
  requests: number;
  /** Requests that failed for good. A failed batch is retried one text at a time first. */
  failedRequests: { itemId: string; error: string; url?: string; chunk?: number }[];
}

async function mapLimit<T>(items: T[], limit: number, fn: (t: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  }));
}

/** `source`: read the verified seller sheet ("sheet") or the whole page ("page"). Empty text → no reads. */
export async function decidePages(pages: CollectedPage[], items: ChecklistItem[], source: ReadSource, concurrency = 4): Promise<DecideRun> {
  const model = envOr("sie-decide", "SIE_DECIDE_MODEL");
  const chunks = Object.fromEntries(pages.map((p) => [p.url, chunkText(readText(p, source), CHUNK_CHARS)]));
  const flat = pages.flatMap((p) => chunks[p.url].map((text, chunk) => ({ url: p.url, chunk, text })));
  const reads = new Map<string, ItemRead>();
  for (const p of pages) for (const it of items) reads.set(`${p.url}|${it.id}`, { url: p.url, itemId: it.id, chunks: [] });

  // One job per (question, batch). An item with several questions gets one chunk read per
  // question; `maxYes` takes the max over all of them ("any of").
  const jobs = items.flatMap((item) =>
    questionsOf(item).flatMap((question) => {
      const out: { item: ChecklistItem; question: string; batch: typeof flat }[] = [];
      for (let i = 0; i < flat.length; i += BATCH_TEXTS) out.push({ item, question, batch: flat.slice(i, i + BATCH_TEXTS) });
      return out;
    }),
  );
  const failedRequests: DecideRun["failedRequests"] = [];
  await mapLimit(jobs, concurrency, async ({ item, question, batch }) => {
    const q: DecideQuestion = { type: "noul", instructions: question };
    const opts = { outputSchema: { q }, adapterOptions: { overflow_policy: "error" as const } };
    const yesOf = (data: unknown) => toTypedAnswer("q", q, (data as Record<string, unknown> | undefined)?.q).probabilities.yes ?? null;
    const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
    let pYes: (number | null)[];
    try {
      const res = await getSieClient().extract(model, batch.map((b) => ({ text: b.text })), opts);
      pYes = res.map((r) => yesOf(r.data));
    } catch {
      // One bad text fails the whole batch; isolate it so the other texts still get read.
      pYes = [];
      for (const b of batch) {
        try {
          pYes.push(yesOf((await getSieClient().extract(model, { text: b.text }, opts)).data));
        } catch (e) {
          failedRequests.push({ itemId: item.id, error: message(e), url: b.url, chunk: b.chunk });
          pYes.push(null);
        }
      }
    }
    batch.forEach((b, i) => reads.get(`${b.url}|${item.id}`)!.chunks.push({ chunk: b.chunk, pYes: pYes[i] ?? null }));
  });
  for (const r of reads.values()) r.chunks.sort((a, b) => a.chunk - b.chunk);
  return { chunks, reads: [...reads.values()], requests: jobs.length, failedRequests };
}

/** Max P(yes) over a page's chunks; null if every call for it failed. */
export function maxYes(r: ItemRead): number | null {
  const ps = r.chunks.map((c) => c.pYes).filter((p): p is number => p !== null);
  return ps.length ? Math.max(...ps) : null;
}
