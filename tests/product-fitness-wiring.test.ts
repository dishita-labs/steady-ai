/**
 * The product-fitness checklist wired into the requirement rules and the rules engine.
 * Pure: hand-written GLiNER P(yes) values and seller sheets shaped like real Exa sheets
 * (2026-11-20 run), real requirement rules, real engine. No Exa or SIE calls.
 */

import { describe, expect, it } from "vitest";
import { deriveAttributes } from "../src/lib/product-fitness/attributes";
import { ATTRIBUTES, CHECKLISTS, checklistConstraints, PRODUCT_TYPES } from "../src/lib/product-fitness/checklist";
import { evaluateCandidate, selectForPurchase } from "../src/lib/rules/engine";
import { deriveRequirements, REQUIREMENT_RULES } from "../src/lib/rules/requirements";
import type { HazardFinding, ProductCandidate } from "../src/types/domain";

const at = "2026-11-20T12:00:00.000Z";
const gb = CHECKLISTS.grab_bar;

/** P(yes) for every grab-bar item: gates and good preferred items yes, the suction red flag no. */
const goodReads = (over: Record<string, number> = {}) => ({
  "gb.is_grab_bar": 0.99,
  "gb.weight_capacity": 0.97,
  "gb.screw_mounted": 0.9,
  "gb.suction_mount": 0.05,
  "gb.diameter": 0.9,
  "gb.wall_clearance": 0.2,
  "gb.ada_compliant": 0.95,
  "gb.textured_grip": 0.1,
  "gb.stainless": 0.98,
  ...over,
});

const MOEN = [
  'Moen Home Care 24" Concealed Screw Grab Bar',
  "Supports up to 500 lbs when installed properly.",
  "SecureMount anchors install in any stud or drywall.",
  "Bar Diameter (in.): 1.25",
  "Material: Stainless Steel",
  "Complies with ADA specifications.",
].join("\n");

function requirement() {
  const hazard: HazardFinding = {
    id: "haz_1", caseId: "case_1", imageId: "img_1", category: "H09", label: "present", summary: "No grab bar.",
    visibleEvidence: ["bare wall"], severity: "high", notEstablishedFromPhoto: [], humanAssessmentRequired: false,
    professionalAssessmentRecommended: true, source: { provider: "sie-decide", at },
  };
  return deriveRequirements("case_1", [hazard]).requirements[0];
}

function candidate(id: string, attributes: ProductCandidate["attributes"], searchRank = 1): ProductCandidate {
  return { id, caseId: "case_1", requirementIds: [requirement().id], title: id, url: `https://www.homedepot.com/p/x/${id}`, attributes, evidenceIds: ["ev_sheet"], discoveredBy: { provider: "exa", query: "q", at }, searchRank, status: "discovered" };
}

describe("requirement rules from the checklist", () => {
  it("gives the grab bar rule the cited gates as mandatory constraints", () => {
    const { mandatory } = checklistConstraints("grab_bar");
    expect(mandatory.map((c) => [c.attribute, c.op, c.value, c.unit])).toEqual([
      ["product_type", "eq", "grab_bar", undefined],
      ["load_lb", "gte", 250, "lb"],
      ["mount_type", "eq", "fixed", undefined],
    ]);
    expect(mandatory[1].rationale).toMatch(/ADA Standards §609\.8/);
  });

  it("puts constraints on every shopping rule, with stable ids", () => {
    for (const rule of REQUIREMENT_RULES) expect(rule.mandatory.length, rule.id).toBeGreaterThan(0);
    expect(requirement().mandatory.map((c) => c.id)).toEqual(["R-H09-grab-bar.m0", "R-H09-grab-bar.m1", "R-H09-grab-bar.m2"]);
    expect(requirement().preferred.length).toBeGreaterThan(0);
  });

  it("makes every red flag write an attribute a gate checks, and gives every item an attribute", () => {
    for (const t of PRODUCT_TYPES) {
      const items = CHECKLISTS[t].items;
      for (const it of items) expect(ATTRIBUTES[it.id], it.id).toBeDefined();
      const gateAttrs = new Set(items.filter((i) => i.kind === "gate").map((i) => ATTRIBUTES[i.id].name));
      for (const rf of items.filter((i) => i.kind === "red_flag")) expect(gateAttrs.has(ATTRIBUTES[rf.id].name), rf.id).toBe(true);
    }
  });
});

describe("attributes: GLiNER yes AND a verified seller quote", () => {
  it("sets each gate from the quote that backs it, citing the sheet evidence", () => {
    const { attributes } = deriveAttributes(gb, goodReads(), MOEN, "ev_sheet");
    const by = Object.fromEntries(attributes.map((a) => [a.name, a]));
    expect(by.product_type).toMatchObject({ value: "grab_bar", evidenceId: "ev_sheet", quote: 'Moen Home Care 24" Concealed Screw Grab Bar' });
    expect(by.load_lb).toMatchObject({ value: 500, unit: "lb", quote: "500 lbs" });
    expect(by.mount_type).toMatchObject({ value: "fixed" });
    expect(by.diameter_in).toMatchObject({ value: 1.25 });
    expect(by.textured_grip).toBeUndefined(); // GLiNER said no
  });

  it("sets nothing from a GLiNER yes without a backing quote", () => {
    const { attributes, trace } = deriveAttributes(gb, goodReads(), "Moen Home Care Grab Bar\nStainless Steel", "ev");
    expect(attributes.find((a) => a.name === "mount_type")).toBeUndefined();
    expect(trace.find((t) => t.itemId === "gb.screw_mounted")?.result).toBe("no_backing_quote");
    expect(trace.find((t) => t.itemId === "gb.weight_capacity")?.result).toBe("no_number");
  });

  it("ignores a keyword GLiNER reads as no ('Unlike suction grab bars…', ACEDSGN)", () => {
    const sheet = `${MOEN}\nUnlike suction grab bars that may fall off unexpectedly, this bar is screwed into studs.`;
    const { attributes } = deriveAttributes(gb, goodReads({ "gb.suction_mount": 0.08 }), sheet, "ev");
    expect(attributes.find((a) => a.name === "mount_type")?.value).toBe("fixed");
  });

  it("lets a backed red flag overwrite the gate it shares, so the engine rejects", () => {
    const sheet = "Suction Grab Bar for Shower\nInstalls in seconds with powerful suction cups, no drilling.\nHolds up to 300 lbs.";
    const { attributes } = deriveAttributes(gb, goodReads({ "gb.suction_mount": 0.95 }), sheet, "ev");
    expect(attributes.find((a) => a.name === "mount_type")).toMatchObject({ value: "suction", quote: expect.stringMatching(/suction/i) });
    const d = evaluateCandidate({ id: "d", requirement: requirement(), candidate: candidate("c", attributes) });
    expect(d.outcome).toBe("rejected");
    expect(d.ruleResults.find((r) => r.attribute === "mount_type")).toMatchObject({ outcome: "fail", observed: "suction", evidenceId: "ev" });
  });
});

describe("engine on derived attributes (eval scenarios A and B)", () => {
  it("A: a stated load under 250 lb rejects, citing the observed value and evidence", () => {
    const sheet = MOEN.replace("Supports up to 500 lbs when installed properly.", "Weight Capacity (lb.): 150");
    const { attributes } = deriveAttributes(gb, goodReads(), sheet, "ev_sheet");
    const d = evaluateCandidate({ id: "d", requirement: requirement(), candidate: candidate("c", attributes) });
    expect(d.outcome).toBe("rejected");
    expect(d.ruleResults.find((r) => r.attribute === "load_lb")).toMatchObject({ outcome: "fail", observed: 150, evidenceId: "ev_sheet" });
  });

  it("B: an unstated load is unknown with no invented value → needs_verification", () => {
    const sheet = MOEN.replace("Supports up to 500 lbs when installed properly.\n", "");
    const { attributes } = deriveAttributes(gb, goodReads(), sheet, "ev_sheet");
    const d = evaluateCandidate({ id: "d", requirement: requirement(), candidate: candidate("c", attributes) });
    expect(d.outcome).toBe("needs_verification");
    const load = d.ruleResults.find((r) => r.attribute === "load_lb")!;
    expect(load.outcome).toBe("unknown");
    // As eval scenario B checks it: nothing observed, no evidence cited.
    expect(load.observed === undefined && load.evidenceId === undefined).toBe(true);
  });

  it("all gates backed → eligible, with preferred items scored", () => {
    const { attributes } = deriveAttributes(gb, goodReads(), MOEN, "ev_sheet");
    const d = evaluateCandidate({ id: "d", requirement: requirement(), candidate: candidate("c", attributes) });
    expect(d.outcome).toBe("eligible");
    // diameter 1.25–2 (2 × 1), ADA (1), stainless (1); not clearance, not textured.
    expect(d.score).toBe(4);
  });
});

describe("selectForPurchase", () => {
  it("picks one eligible product per requirement: best score, then search rank; never an ineligible one", () => {
    const req = requirement();
    const good = deriveAttributes(gb, goodReads(), MOEN, "ev").attributes;
    const better = deriveAttributes(gb, goodReads({ "gb.textured_grip": 0.9 }), `${MOEN}\nKnurled grip for wet hands.`, "ev").attributes;
    const cands = [candidate("a", good, 1), candidate("b", better, 5), candidate("c", good, 2), candidate("x", [], 0)];
    const ds = cands.map((c) => evaluateCandidate({ id: `d_${c.id}`, requirement: req, candidate: c }));
    expect(ds.find((d) => d.candidateId === "x")?.outcome).toBe("needs_verification");
    expect(selectForPurchase(ds, cands).map((d) => d.candidateId)).toEqual(["b"]);
    expect(selectForPurchase(ds.filter((d) => d.candidateId !== "b"), cands).map((d) => d.candidateId)).toEqual(["a"]);
    expect(selectForPurchase(ds.filter((d) => d.candidateId === "x"), cands)).toEqual([]);
  });
});
