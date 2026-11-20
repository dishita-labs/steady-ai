/**
 * Product research boundary (Exa, `exa-js`).
 *
 *   exa.search(query, { numResults, includeDomains, contents: { text, highlights } })
 *   exa.getContents(urls, { text, highlights })
 *
 * Rules: keep every source URL; never fill in a price, spec or seller that isn't in retrieved content.
 * Prices and availability are stale until verified at the retailer.
 */

import Exa from "exa-js";
import { requireConfigured } from "../config";
import type { RequirementId } from "../../types/domain";

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
  publishedDate?: string;
  providerResultId?: string;
  /** Exa request ID, for tracing. */
  requestId?: string;
  retrievedAt: string;
}

export interface ProductSearchProvider {
  search(q: ProductSearchQuery): Promise<RetrievedPage[]>;
  getContents(urls: string[]): Promise<RetrievedPage[]>;
}

/** Cap on stored page text per result. Tune after looking at real product pages. */
const MAX_TEXT_CHARS = 8000;
const contents = { text: { maxCharacters: MAX_TEXT_CHARS }, highlights: true } as const;

let exa: Exa | undefined;
function client(): Exa {
  requireConfigured("exa");
  exa ??= new Exa(process.env.EXA_API_KEY);
  return exa;
}

type ExaResult = {
  url: string;
  title: string | null;
  id: string;
  publishedDate?: string;
  text?: string;
  highlights?: string[];
};

function toPage(r: ExaResult, requestId: string, retrievedAt: string): RetrievedPage {
  return {
    url: r.url,
    title: r.title ?? undefined,
    text: r.text,
    highlights: r.highlights,
    publishedDate: r.publishedDate,
    providerResultId: r.id,
    requestId,
    retrievedAt,
  };
}

export function getProductSearchProvider(): ProductSearchProvider {
  return {
    async search({ query, numResults = 5, includeDomains }) {
      const res = await client().search(query, { numResults, includeDomains, contents });
      const at = new Date().toISOString();
      return res.results.map((r) => toPage(r, res.requestId, at));
    },
    async getContents(urls) {
      const res = await client().getContents(urls, contents);
      const at = new Date().toISOString();
      return res.results.map((r) => toPage(r, res.requestId, at));
    },
  };
}
