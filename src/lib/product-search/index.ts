/**
 * Product research boundary (Exa).
 *
 * Read from Exa's docs on 2026-11-20 and NOT yet exercised by a real call (`exa-js` 2.29.0, not installed yet):
 *   - auth: EXA_API_KEY
 *   - exa.search(query, { numResults, includeDomains, contents: { text, highlights, summary } })
 *     (`searchAndContents` is deprecated)
 *   - exa.getContents(urls, { text, highlights, summary })
 *   - there is no "product" search category
 *
 * Rules: keep every source URL; never fill in a price, spec or seller that isn't in retrieved content.
 * Prices and availability are stale until verified at the retailer.
 */

import { notImplemented } from "@/lib/integrations";
import type { RequirementId } from "@/types/domain";

export interface ProductSearchQuery {
  requirementId: RequirementId;
  query: string;
  numResults?: number;
  includeDomains?: string[];
}

export interface RetrievedPage {
  url: string;
  title?: string;
  /** Verbatim page text, when requested. */
  text?: string;
  highlights?: string[];
  /** Provider-generated summary. Store as evidence kind "summary", never as a verbatim quote. */
  summary?: string;
  publishedDate?: string;
  providerResultId?: string;
  retrievedAt: string;
}

export interface ProductSearchProvider {
  search(q: ProductSearchQuery): Promise<RetrievedPage[]>;
  getContents(urls: string[]): Promise<RetrievedPage[]>;
}

export function getProductSearchProvider(): ProductSearchProvider {
  return {
    search: () => notImplemented("exa", "search"),
    getContents: () => notImplemented("exa", "getContents"),
  };
}
