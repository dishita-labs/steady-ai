/**
 * Page-level checks on an Exa result, before any GLiNER question.
 */

import type { VerifiedSheet } from "./sheet";
import { isProductUrl } from "./shops";

/**
 * Is this a single-product page? From Exa's page type and, where the shop's URL shape is known,
 * the URL. (GLiNER can't do it: "Is this text a shop listing for a single product?" scored 0.84
 * on a listicle; experiments/product-fitness/README.md.)
 */
export function productPageCheck(p: { url: string; sheet?: VerifiedSheet }): { ok: true } | { ok: false; reason: string } {
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
