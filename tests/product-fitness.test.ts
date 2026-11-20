/**
 * Pure parts of the product-fitness experiment: checklist integrity, the numeric parser, and the
 * ranking rules. No Exa or SIE calls; the P(yes) values below are hand-written inputs.
 */

import { describe, expect, it } from "vitest";
import { REQUIREMENT_RULES } from "../src/lib/rules/requirements";
import { CHECKLISTS, PRODUCT_TYPES, questionsOf } from "../experiments/product-fitness/checklist";
import { checkNumeric, parseInches, parseQuantity } from "../experiments/product-fitness/extract";
import { SILVER, silverLabel } from "../experiments/product-fitness/labels";
import { rankPage, sortRankings, type ItemInput } from "../experiments/product-fitness/rank";
import { rankingAgreement } from "../experiments/product-fitness/score";

describe("checklist", () => {
  const all = PRODUCT_TYPES.flatMap((t) => CHECKLISTS[t].items);

  it("asks only positive, single-concept questions (GLiNER can't read negation)", () => {
    for (const it of all) {
      for (const q of questionsOf(it)) {
        expect(q, it.id).not.toMatch(/\b(not|no|without|never|lacks?|missing|n't)\b/i);
        expect(q.trim().endsWith("?"), it.id).toBe(true);
      }
    }
  });

  it("cites a source with a URL for every item, and has a silver pattern for it", () => {
    for (const it of all) {
      expect(it.sources.length, it.id).toBeGreaterThan(0);
      for (const s of it.sources) expect(s.url, it.id).toMatch(/^https?:\/\//);
      expect(SILVER[it.id], it.id).toBeDefined();
    }
    expect(new Set(all.map((i) => i.id)).size).toBe(all.length);
  });

  it("starts each product's queries with what production actually searches", () => {
    for (const t of PRODUCT_TYPES) {
      const rule = REQUIREMENT_RULES.find((r) => r.id === CHECKLISTS[t].ruleId);
      expect(rule?.productType, t).toBe(t);
      expect(CHECKLISTS[t].queries[0]).toBe(rule!.searchQuery);
    }
  });

  it("puts the ADA 250 lb strength requirement on the grab bar as a gate", () => {
    const w = CHECKLISTS.grab_bar.items.find((i) => i.id === "gb.weight_capacity")!;
    expect(w).toMatchObject({ kind: "gate", numeric: { quantity: "weight_lb", min: 250 } });
  });
});

describe("numeric parser", () => {
  it("reads inch formats", () => {
    expect(parseInches("1-1/4")).toBe(1.25);
    expect(parseInches("1 1/2")).toBe(1.5);
    expect(parseInches("1¼")).toBe(1.25);
    expect(parseInches("1.25")).toBe(1.25);
  });

  it("finds weight capacity only near a capacity word, and drops shipping weights", () => {
    expect(parseQuantity("Supports up to 500 lbs. Item weight: 2.5 lbs", "weight_lb").map((p) => p.value)).toEqual([500]);
    expect(parseQuantity("Load capacity 150 kg", "weight_lb")[0].value).toBe(331);
    expect(parseQuantity("Package weight 3 lb", "weight_lb")).toEqual([]);
  });

  it("finds diameters and wall clearance in inches or mm", () => {
    expect(parseQuantity('Tube diameter: 1-1/4" stainless', "diameter_in")[0].value).toBe(1.25);
    expect(parseQuantity("32 mm diameter tube", "diameter_in")[0].value).toBeCloseTo(1.26, 2);
    expect(parseQuantity("1.5 in clearance from the wall", "clearance_in")[0].value).toBe(1.5);
  });

  it("passes if any stated variant passes, fails if all fail, unknown if none", () => {
    const spec = { quantity: "weight_lb" as const, min: 250 };
    expect(checkNumeric(["Holds 200 lbs; heavy-duty model supports up to 500 lbs"], spec).status).toBe("pass");
    expect(checkNumeric(["Weight capacity: 200 lbs"], spec)).toMatchObject({ status: "fail", value: 200 });
    expect(checkNumeric(["Sturdy and strong"], spec).status).toBe("unknown");
  });
});

describe("ranking", () => {
  const gb = CHECKLISTS.grab_bar;
  const page = (url: string, exaRank = 1) => ({ url, title: url, exaRank });
  const yes = (evidence = ""): ItemInput => ({ pYes: 0.9, evidence: [evidence] });
  const no: ItemInput = { pYes: 0.1, evidence: [] };
  const allGatesMet = { "gb.is_grab_bar": yes(), "gb.weight_capacity": yes("Supports up to 500 lbs"), "gb.screw_mounted": yes(), "gb.suction_mount": no };

  it("eligible only when every gate is met with evidence", () => {
    const r = rankPage(gb, page("a"), allGatesMet);
    expect(r.outcome).toBe("eligible");
    expect(r.gatesMet).toBe(3);
  });

  it("a yes on weight capacity without a parsable number is needs_verification, never a pass", () => {
    const r = rankPage(gb, page("a"), { ...allGatesMet, "gb.weight_capacity": yes("Extremely sturdy, holds lots of weight") });
    expect(r.outcome).toBe("needs_verification");
    expect(r.reasons.join()).toMatch(/250 lb/);
  });

  it("a stated capacity under 250 lb rejects", () => {
    expect(rankPage(gb, page("a"), { ...allGatesMet, "gb.weight_capacity": yes("Weight capacity: 200 lbs") }).outcome).toBe("reject");
  });

  it("a suction mount rejects even when everything else is met", () => {
    const r = rankPage(gb, page("a"), { ...allGatesMet, "gb.suction_mount": yes() });
    expect(r.outcome).toBe("reject");
    expect(r.reasons[0]).toMatch(/suction/i);
  });

  it("missing reads count as not shown", () => {
    expect(rankPage(gb, page("a"), {}).outcome).toBe("needs_verification");
  });

  it("orders by outcome, then preferred score, then Exa rank", () => {
    const eligibleLow = rankPage(gb, page("low", 1), allGatesMet);
    const eligibleHigh = rankPage(gb, page("high", 5), { ...allGatesMet, "gb.diameter": yes("1-1/4 in diameter"), "gb.stainless": yes() });
    const unverified = rankPage(gb, page("unv", 2), {});
    expect(sortRankings([unverified, eligibleLow, eligibleHigh]).map((r) => r.url)).toEqual(["high", "low", "unv"]);
    expect(eligibleHigh.score).toBe(3);
  });

  it("agreement counts the dangerous error and compares top-k with Exa's order", () => {
    const model = [rankPage(gb, page("a", 2), allGatesMet), rankPage(gb, page("b", 1), {})];
    const ref = [rankPage(gb, page("a", 2), { ...allGatesMet, "gb.suction_mount": yes() }), rankPage(gb, page("b", 1), allGatesMet)];
    const a = rankingAgreement(model, ref, 1);
    expect(a.eligibleButRejected).toBe(1);
    expect(a.topK).toMatchObject({ model: 0, exaOrder: 1, referenceEligible: 1 });
  });
});

describe("silver labels", () => {
  it("returns a snippet for a match and 'no' otherwise", () => {
    expect(silverLabel("gb.suction_mount", "Installs with powerful suction cups, no drilling")).toMatchObject({ label: "yes" });
    expect(silverLabel("nl.motion_sensor", "Dusk to dawn sensor").label).toBe("no");
  });
});

describe("product pages, shops and sheets", () => {
  const sheet = (pageType: "single_product" | "article_or_review_list" = "single_product") => ({ pageType, productName: "Moen Grab Bar", description: [], specs: [], dropped: [], quotes: 0 });

  it("keeps a page only if Exa says single product and the shop's product-URL shape matches", async () => {
    const { productPageCheck } = await import("../experiments/product-fitness/collect");
    expect(productPageCheck({ url: "https://www.homedepot.com/p/MOEN-Grab-Bar/203993365", sheet: sheet() })).toEqual({ ok: true });
    expect(productPageCheck({ url: "https://www.homedepot.com/b/Bath-Grab-Bars/N-5yc1vZcfvs", sheet: sheet() })).toMatchObject({ ok: false, reason: /product URL/ });
    expect(productPageCheck({ url: "https://www.amazon.com/dp/B001EHXEPG", sheet: sheet("article_or_review_list") })).toMatchObject({ ok: false, reason: /article/ });
    expect(productPageCheck({ url: "https://www.vitalitymedical.com/tub-treads.html", sheet: sheet() })).toEqual({ ok: true }); // no known URL shape: Exa decides
    expect(productPageCheck({ url: "https://www.bestbuy.com/product/dazzed-corner-2-pack-plug-in-night-light/J3LJHZFPVT", sheet: sheet() })).toEqual({ ok: true });
    expect(productPageCheck({ url: "https://www.amazon.com/dp/B001EHXEPG" })).toMatchObject({ ok: false, reason: /no product sheet/ });
  });

  it("restricts every product to shops it can match, and starts with the big-box stores", async () => {
    const { SHOPS, SHOPS_FOR } = await import("../experiments/product-fitness/shops");
    for (const t of PRODUCT_TYPES) for (const d of SHOPS_FOR[t]) expect(SHOPS[d], d).toBeDefined();
    expect(SHOPS_FOR.grab_bar).toContain("homedepot.com");
  });

  it("keeps only quotes that are verbatim on the page, and the page title when the name isn't", async () => {
    const { verifySheet, sheetText, parseSheet } = await import("../experiments/product-fitness/sheet");
    const page = "Moen Home Care 24 in. Grab Bar\nSupports up to 500 lbs when installed properly.\nBar Diameter (in.) 1.25\nReviews: super easy to install, love it";
    const parsed = parseSheet(JSON.stringify({ pageType: "single_product", productName: "Moen Deluxe Grab Bar", sellerDescription: ["Supports up to 500 lbs  when installed properly.", "Holds 1,000 lbs."], specifications: [{ name: "Bar Diameter (in.)", value: "1.25" }] }))!;
    const v = verifySheet(parsed, page, "Moen Home Care 24 in. Grab Bar");
    expect(v.description).toEqual(["Supports up to 500 lbs  when installed properly."]);
    expect(v.dropped).toEqual(["Holds 1,000 lbs.", "name: Moen Deluxe Grab Bar"]);
    expect(v.productName).toBe("Moen Home Care 24 in. Grab Bar");
    expect(sheetText(v)).not.toMatch(/easy to install/);
    expect(parseSheet("not json")).toBeUndefined();
  });

  it("reads units from spec-row names, and ignores another part's diameter", () => {
    expect(parseQuantity("Bar Diameter (in.): 1.25", "diameter_in")[0].value).toBe(1.25);
    expect(parseQuantity("Escutcheon Diameter (in.): 1.25", "diameter_in")).toEqual([]);
    expect(parseQuantity("Escutcheon diameter 3 in", "diameter_in")).toEqual([]);
    expect(parseQuantity("Weight Capacity (lb.): 500", "weight_lb")[0].value).toBe(500);
    expect(parseQuantity("Product Weight (lb.): 2.1", "weight_lb")).toEqual([]);
  });

  it("rejects a page the product check excluded, whatever its reads", () => {
    const r = rankPage(CHECKLISTS.plug_in_night_light, { url: "https://x.com/a", title: "5 Best Night Lights", exaRank: 1, notProduct: "Exa page type: article_or_review_list" }, {});
    expect(r).toMatchObject({ outcome: "reject", reasons: ["not a product page: Exa page type: article_or_review_list"] });
  });
});

describe("page text", () => {
  it("drops fenced JSON-LD blocks that overflow Decide's window, keeps the prose", async () => {
    const { pageText } = await import("../experiments/product-fitness/collect");
    const text = 'Password?\n\n```json\n{"@context":"https:\\/\\/schema.org","@type":"BreadcrumbList"}\n```\n\nTub treads with adhesive backing.';
    const out = pageText({ title: "Safety treads", text });
    expect(out).not.toContain("schema.org");
    expect(out).toContain("adhesive backing");
  });
});
