/**
 * Stage 2: GLiNER2.5 Decide answers each checklist question over each page, through the shared
 * reader (`src/lib/product-fitness/read.ts`, the same code the workflow runs). This wrapper only
 * keys reads by URL and picks the text to read: the verified seller sheet or the whole page.
 */

import type { ChecklistItem } from "../../src/lib/product-fitness/checklist";
import { maxYes, readChecklist, type ChunkRead } from "../../src/lib/product-fitness/read";
import { readText, type CollectedPage, type ReadSource } from "./collect";

export { maxYes };
export type { ChunkRead };

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

/** `source`: read the verified seller sheet ("sheet") or the whole page ("page"). Empty text → no reads. */
export async function decidePages(pages: CollectedPage[], items: ChecklistItem[], source: ReadSource, concurrency = 4): Promise<DecideRun> {
  const r = await readChecklist(pages.map((p) => ({ key: p.url, text: readText(p, source) })), items, { concurrency });
  return {
    chunks: r.chunks,
    reads: r.reads.map(({ key, itemId, chunks }) => ({ url: key, itemId, chunks })),
    requests: r.requests,
    failedRequests: r.failedRequests.map(({ key, ...f }) => ({ ...f, url: key })),
  };
}
