/**
 * Stage 1: Exa product discovery, through the production provider (`getProductSearchProvider`,
 * src/lib/product-search). Each search is restricted to the product's shops (`shops.ts`) and asks
 * Exa for a structured product sheet per result (`sheet.ts`), which is verified against the page
 * text. Every search is cached on disk by its arguments, so a rerun makes no Exa call.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getProductSearchProvider, type ProductSearchQuery, type RetrievedPage } from "../../src/lib/product-search";
import type { ProductChecklist, ProductType } from "../../src/lib/product-fitness/checklist";
import { productPageCheck, stripMarkup } from "../../src/lib/product-fitness/page";
import { SHEET_QUERY, SHEET_SCHEMA, parseSheet, sheetText, verifySheet, type VerifiedSheet } from "../../src/lib/product-fitness/sheet";
import { SHOPS_FOR } from "../../src/lib/product-fitness/shops";

export { productPageCheck, stripMarkup };

export interface CollectedPage extends RetrievedPage {
  productType: ProductType;
  /** Every query that returned this URL. */
  queries: string[];
  /** Best (lowest) rank across those queries, 1-based. Exa's own order, kept as a baseline. */
  exaRank: number;
  /** The seller's product sheet, with every quote checked against the page text. */
  sheet?: VerifiedSheet;
}

export interface SearchRecord {
  query: string;
  includeDomains: string[];
  cached: boolean;
  latencyMs: number;
  results: number;
}

async function cachedSearch(cacheDir: string, q: Omit<ProductSearchQuery, "requirementId">): Promise<{ pages: RetrievedPage[]; record: SearchRecord }> {
  const key = createHash("sha256").update(JSON.stringify(q)).digest("hex");
  const file = join(cacheDir, `${key}.json`);
  const record = (cached: boolean, latencyMs: number, n: number): SearchRecord => ({ query: q.query, includeDomains: q.includeDomains ?? [], cached, latencyMs, results: n });
  try {
    const hit = JSON.parse(await readFile(file, "utf8")) as { pages: RetrievedPage[]; latencyMs: number };
    return { pages: hit.pages, record: record(true, hit.latencyMs, hit.pages.length) };
  } catch {
    /* not cached */
  }
  const t0 = performance.now();
  const pages = await getProductSearchProvider().search({ requirementId: "experiment", ...q });
  const latencyMs = Math.round(performance.now() - t0);
  await mkdir(cacheDir, { recursive: true });
  await writeFile(file, JSON.stringify({ ...q, at: new Date().toISOString(), latencyMs, pages }));
  return { pages, record: record(false, latencyMs, pages.length) };
}

/** Run every query for one product type, restricted to its shops, and merge results by URL. */
export async function collect(checklist: ProductChecklist, cacheDir: string, numResults = 10): Promise<{ pages: CollectedPage[]; searches: SearchRecord[] }> {
  const byUrl = new Map<string, CollectedPage>();
  const searches: SearchRecord[] = [];
  const includeDomains = SHOPS_FOR[checklist.productType];
  for (const query of checklist.queries) {
    const { pages, record } = await cachedSearch(cacheDir, { query, numResults, includeDomains, extract: { query: SHEET_QUERY, schema: SHEET_SCHEMA } });
    searches.push(record);
    pages.forEach((p, i) => {
      const prev = byUrl.get(p.url);
      if (prev) {
        prev.queries.push(query);
        prev.exaRank = Math.min(prev.exaRank, i + 1);
      } else if (p.text?.trim()) {
        const parsed = parseSheet(p.summary);
        const sheet = parsed && verifySheet(parsed, p.text, p.title ?? "");
        byUrl.set(p.url, { ...p, productType: checklist.productType, queries: [query], exaRank: i + 1, sheet });
      }
    });
  }
  return { pages: [...byUrl.values()], searches };
}

/** The whole page as GLiNER would read it without a sheet: title, then text without markup. */
export function pageText(p: Pick<RetrievedPage, "title" | "text">): string {
  return [p.title, p.text && stripMarkup(p.text)].filter(Boolean).join("\n").trim();
}

/** What GLiNER reads in each mode. "sheet": the verified seller sheet only. "page": everything. */
export type ReadSource = "sheet" | "page";
export function readText(p: CollectedPage, source: ReadSource): string {
  return source === "sheet" ? (p.sheet ? sheetText(p.sheet) : "") : pageText(p);
}
