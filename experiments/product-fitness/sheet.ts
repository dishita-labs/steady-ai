/**
 * The seller's product sheet, extracted by Exa (`contents.summary` with a JSON schema) and then
 * VERIFIED against the page text.
 *
 * Why: product pages carry customer reviews and Q&A, and GLiNER reads them as product claims
 * (a review saying "super easy to install" scored 0.73 for "attaches with suction cups"; see
 * README). The schema asks Exa for the seller's own description and specification rows, copied
 * word for word, and the page type.
 *
 * Exa's summary is model-written, so nothing in it is trusted as is: a description sentence or
 * a spec value is kept only if it appears verbatim in the retrieved page text (after
 * normalizing whitespace, quotes and case). Unverified quotes are dropped and counted.
 */

import { z } from "zod";

export const SHEET_QUERY =
  "Extract the seller's or manufacturer's product information for the main product on this page. Copy text word for word. Ignore customer reviews, ratings, questions and answers, and other products.";

export const SHEET_SCHEMA = {
  type: "object",
  required: ["pageType", "productName", "sellerDescription", "specifications"],
  properties: {
    pageType: {
      type: "string",
      enum: ["single_product", "category_or_search", "article_or_review_list", "other"],
      description: "single_product: the page sells one product (possibly in sizes or finishes). category_or_search: a list of products from a shop. article_or_review_list: an article, guide, or 'best of' list.",
    },
    productName: { type: "string" },
    sellerDescription: {
      type: "array",
      items: { type: "string" },
      description: "Sentences and feature bullets copied word for word from the seller's or manufacturer's product description. Never from customer reviews, questions and answers, or ratings.",
    },
    specifications: {
      type: "array",
      items: { type: "object", required: ["name", "value"], properties: { name: { type: "string" }, value: { type: "string" } } },
      description: "Rows of the product's specification table, copied word for word. Never from customer reviews.",
    },
  },
} as const;

const PageType = z.enum(["single_product", "category_or_search", "article_or_review_list", "other"]);
export const ProductSheet = z.object({
  pageType: PageType,
  productName: z.string().default(""),
  sellerDescription: z.array(z.string()).default([]),
  specifications: z.array(z.object({ name: z.string(), value: z.string() })).default([]),
});
export type ProductSheet = z.infer<typeof ProductSheet>;
export type SheetPageType = z.infer<typeof PageType>;

export interface VerifiedSheet {
  pageType: SheetPageType;
  productName: string;
  description: string[];
  specs: { name: string; value: string }[];
  /** Quotes Exa returned that are not in the page text. */
  dropped: string[];
  quotes: number;
}

export function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[“”″]/g, '"')
    .replace(/[‘’′]/g, "'")
    .replace(/[‐‑‒–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

/** Parse Exa's summary text. Undefined when it is missing or not the expected JSON. */
export function parseSheet(summary: string | undefined): ProductSheet | undefined {
  if (!summary) return undefined;
  try {
    const r = ProductSheet.safeParse(JSON.parse(summary));
    return r.success ? r.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Keep only quotes found verbatim in the page text. For a spec row, the VALUE must be on the
 * page; the name is Exa's label for it and only gives the parser context (a table header such as
 * "Escutcheon Diameter (in.)" is often not contiguous with its value in the text).
 */
export function verifySheet(sheet: ProductSheet, pageText: string, pageTitle = ""): VerifiedSheet {
  const page = normalize(pageText);
  const on = (q: string) => normalize(q).length > 0 && page.includes(normalize(q));
  const description = sheet.sellerDescription.filter(on);
  const specs = sheet.specifications.filter((s) => on(s.value));
  const dropped = [...sheet.sellerDescription.filter((q) => !on(q)), ...sheet.specifications.filter((s) => !on(s.value)).map((s) => `${s.name}: ${s.value}`)];
  // The name must be on the page too; otherwise use the page's own title (from the HTML, not the model).
  const productName = on(sheet.productName) ? sheet.productName : pageTitle;
  if (sheet.productName && productName !== sheet.productName) dropped.push(`name: ${sheet.productName}`);
  return { pageType: sheet.pageType, productName, description, specs, dropped, quotes: sheet.sellerDescription.length + sheet.specifications.length + (sheet.productName ? 1 : 0) };
}

/** What GLiNER and the numeric parser read: name, description, then one "Name: value" line per spec. */
export function sheetText(s: VerifiedSheet): string {
  return [s.productName, ...s.description, ...s.specs.map((x) => `${x.name}: ${x.value}`)].filter((x) => x.trim()).join("\n");
}
