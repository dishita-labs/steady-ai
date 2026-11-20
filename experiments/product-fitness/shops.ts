/**
 * Shops Exa is restricted to (`includeDomains`), and how each one shapes a product URL.
 *
 * US retailers only: the checklist rests on US standards (ADA, UL). Big-box and pharmacy chains
 * for reach, plus a few medical-supply and maker shops that carry the ADA-rated lines the big
 * stores don't. A domain without a known product-URL pattern relies on Exa's page type alone.
 *
 * Trade-off: restricting domains removes listicles and blogs, but also every shop not listed.
 * A good product from an unlisted shop can't be found, so this list is a product decision.
 */

import type { ProductType } from "./checklist";

export interface Shop {
  domain: string;
  /** Matches a single-product URL on this shop. Undefined: unknown, trust Exa's page type. */
  productUrl?: RegExp;
}

export const SHOPS: Record<string, Shop> = {
  "amazon.com": { domain: "amazon.com", productUrl: /\/(?:dp|gp\/product)\/[A-Z0-9]{10}/ },
  "homedepot.com": { domain: "homedepot.com", productUrl: /\/p\/[^/]+\/\d+/ },
  "lowes.com": { domain: "lowes.com", productUrl: /\/pd\/[^/]+\/\d+/ },
  "walmart.com": { domain: "walmart.com", productUrl: /\/ip\/(?:[^/]+\/)?\d+/ },
  "target.com": { domain: "target.com", productUrl: /\/p\/[^/]+\/-\/A-\d+/ },
  // Both formats seen: /site/<slug>/<sku>.p (older) and /product/<slug>/<SKU> (2026).
  "bestbuy.com": { domain: "bestbuy.com", productUrl: /\/site\/[^/]+\/\d+\.p|\/product\/[^/]+\/[A-Z0-9]+/ },
  "cvs.com": { domain: "cvs.com", productUrl: /\/shop\/[^/]+-prodid-\d+/ },
  "walgreens.com": { domain: "walgreens.com", productUrl: /\/store\/c\/[^/]+\/ID=[^/]+-product/ },
  "vitalitymedical.com": { domain: "vitalitymedical.com" },
  "vivehealth.com": { domain: "vivehealth.com", productUrl: /\/products\/[^/?#]+/ },
  "moen.com": { domain: "moen.com", productUrl: /\/products\/[^/?#]+/ },
  "healthcraftproducts.com": { domain: "healthcraftproducts.com", productUrl: /\/product\/[^/?#]+/ },
};

const BIG_BOX = ["amazon.com", "homedepot.com", "lowes.com", "walmart.com", "target.com"];

export const SHOPS_FOR: Record<ProductType, string[]> = {
  grab_bar: [...BIG_BOX, "vitalitymedical.com", "vivehealth.com", "moen.com", "healthcraftproducts.com"],
  non_slip_bath_mat: [...BIG_BOX, "cvs.com", "walgreens.com", "vitalitymedical.com", "vivehealth.com"],
  plug_in_night_light: [...BIG_BOX, "bestbuy.com", "walgreens.com"],
};

export function shopFor(url: string): Shop | undefined {
  let host: string;
  try {
    host = new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return undefined;
  }
  return Object.values(SHOPS).find((s) => host === s.domain || host.endsWith(`.${s.domain}`));
}

/** true / false when the shop's URL pattern is known; undefined when it isn't. */
export function isProductUrl(url: string): boolean | undefined {
  const shop = shopFor(url);
  if (!shop?.productUrl) return undefined;
  return shop.productUrl.test(new URL(url).pathname);
}
