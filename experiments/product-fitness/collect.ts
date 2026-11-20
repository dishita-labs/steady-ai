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
import type { ProductChecklist, ProductType } from "./checklist";
import { SHEET_QUERY, SHEET_SCHEMA, parseSheet, sheetText, verifySheet, type VerifiedSheet } from "./sheet";
import { isProductUrl, SHOPS_FOR } from "./shops";

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

/**
 * Is this a single-product page? Decided before any GLiNER question, from Exa's page type and,
 * where the shop's URL shape is known, the URL. (GLiNER can't do it: "Is this text a shop
 * listing for a single product?" scored 0.84 on a listicle; see README.)
 */
export function productPageCheck(p: Pick<CollectedPage, "url" | "sheet">): { ok: true } | { ok: false; reason: string } {
  if (!p.sheet) return { ok: false, reason: "no product sheet from Exa" };
  if (p.sheet.pageType !== "single_product") return { ok: false, reason: `Exa page type: ${p.sheet.pageType}` };
  if (isProductUrl(p.url) === false) return { ok: false, reason: "not a product URL for this shop" };
  return { ok: true };
}

/**
 * Page markup Exa sometimes returns inside the text: fenced code blocks (JSON-LD breadcrumbs,
 * product schema). Not product prose, and dense enough in tokens to overflow Decide's 512-token
 * window (seen 2026-11-20 on a schema.org breadcrumb).
 */
export function stripMarkup(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\{[^{}]*"@(?:context|type)"[\s\S]*?\}\s*(?=\n|$)/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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
