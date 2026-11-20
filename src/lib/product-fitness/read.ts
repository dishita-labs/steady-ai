/**
 * GLiNER2.5 Decide reads the checklist over texts (seller sheets, or whole pages in the
 * experiment's comparison mode).
 *
 * Batch-texts mode (as in the hazard experiment): ONE question per request, over up to
 * BATCH_TEXTS chunks, `extract(model, items[], { outputSchema: { q } })`. An item's answer for a
 * text is the max P(yes) over its chunks and over the item's questions ("any of"). A failed batch
 * is retried one text at a time, so one bad chunk loses only its own reads.
 */

import { envOr } from "../config";
import { chunkText, toTypedAnswer, type DecideQuestion } from "../product-decisions";
import { getSieClient } from "../sie";
import { questionsOf, type ChecklistItem } from "./checklist";

export const CHUNK_CHARS = 1400;
export const BATCH_TEXTS = 16;

export interface ChunkRead {
  chunk: number;
  /** Which of the item's questions (index into `questionsOf(item)`). */
  question: number;
  /** P(yes), or null when the call failed for good. */
  pYes: number | null;
}

export interface ItemRead {
  key: string;
  itemId: string;
  chunks: ChunkRead[];
}

export interface ChecklistRead {
  /** key → chunk texts. */
  chunks: Record<string, string[]>;
  reads: ItemRead[];
  requests: number;
  failedRequests: { itemId: string; error: string; key?: string; chunk?: number }[];
  model: string;
}

export interface ReadOptions {
  concurrency?: number;
  /** Errors this returns true for are rethrown (the workflow step retries); others become null reads. */
  rethrow?: (e: unknown) => boolean;
}

async function mapLimit<T>(items: T[], limit: number, fn: (t: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]);
    }),
  );
}

export async function readChecklist(texts: { key: string; text: string }[], items: ChecklistItem[], opts: ReadOptions = {}): Promise<ChecklistRead> {
  const model = envOr("sie-decide", "SIE_DECIDE_MODEL");
  const chunks = Object.fromEntries(texts.map((t) => [t.key, t.text.trim() ? chunkText(t.text, CHUNK_CHARS) : []]));
  const flat = texts.flatMap((t) => chunks[t.key].map((text, chunk) => ({ key: t.key, chunk, text })));
  const reads = new Map<string, ItemRead>();
  for (const t of texts) for (const it of items) reads.set(`${t.key}|${it.id}`, { key: t.key, itemId: it.id, chunks: [] });

  const jobs = items.flatMap((item) =>
    questionsOf(item).flatMap((text, question) => {
      const out: { item: ChecklistItem; text: string; question: number; batch: typeof flat }[] = [];
      for (let i = 0; i < flat.length; i += BATCH_TEXTS) out.push({ item, text, question, batch: flat.slice(i, i + BATCH_TEXTS) });
      return out;
    }),
  );
  const failedRequests: ChecklistRead["failedRequests"] = [];
  const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
  await mapLimit(jobs, opts.concurrency ?? 4, async ({ item, text, question, batch }) => {
    const q: DecideQuestion = { type: "noul", instructions: text };
    const extractOpts = { outputSchema: { q }, adapterOptions: { overflow_policy: "error" as const } };
    const yesOf = (data: unknown) => toTypedAnswer("q", q, (data as Record<string, unknown> | undefined)?.q).probabilities.yes ?? null;
    let pYes: (number | null)[];
    try {
      const res = await getSieClient().extract(model, batch.map((b) => ({ text: b.text })), extractOpts);
      pYes = res.map((r) => yesOf(r.data));
    } catch (batchError) {
      if (opts.rethrow?.(batchError)) throw batchError;
      pYes = [];
      for (const b of batch) {
        try {
          pYes.push(yesOf((await getSieClient().extract(model, { text: b.text }, extractOpts)).data));
        } catch (e) {
          if (opts.rethrow?.(e)) throw e;
          failedRequests.push({ itemId: item.id, error: message(e), key: b.key, chunk: b.chunk });
          pYes.push(null);
        }
      }
    }
    batch.forEach((b, i) => reads.get(`${b.key}|${item.id}`)!.chunks.push({ chunk: b.chunk, question, pYes: pYes[i] ?? null }));
  });
  for (const r of reads.values()) r.chunks.sort((a, b) => a.chunk - b.chunk || a.question - b.question);
  return { chunks, reads: [...reads.values()], requests: jobs.length, failedRequests, model };
}

/** Max P(yes) over a text's chunks and the item's questions; null if every call failed. */
export function maxYes(r: Pick<ItemRead, "chunks">): number | null {
  const ps = r.chunks.map((c) => c.pYes).filter((p): p is number => p !== null);
  return ps.length ? Math.max(...ps) : null;
}
