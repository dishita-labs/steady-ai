/**
 * Unit tests for the hazard-classification experiment's pure parts. No model calls: the GLiNER
 * P(yes) values below are hand-written inputs to the deterministic validator, not model results.
 */

import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ASKED_ITEM_TYPES, ASKED_ROLES, itemQuestion, roleQuestion, type ClassifyResult, type PartRead } from "../src/lib/vision/observe-classify/classify";
import { loadDevelopmentSet, parseDevManifest, steadyPrepDir } from "../experiments/hazard-classification/dataset";
import { CATEGORY_IDS, CATEGORY_SPECS, type ItemType, type PartRole } from "../src/lib/vision/observe-classify/definitions";
import { ObservationOutput, observationPrompt } from "../src/lib/vision/observe-classify/observe";
import { score, type ImagePrediction } from "../experiments/hazard-classification/score";
import { sweep } from "../experiments/hazard-classification/tune";
import { DEFAULT_VALIDATOR, traceProblems, validateClassifications } from "../src/lib/vision/observe-classify/validate";
import { deriveRequirements } from "../src/lib/rules/requirements";
import { validateVisionResult } from "../src/lib/vision";
import type { CategoryLabel, HazardCategoryId, HazardFinding } from "../src/types/domain";

const source = { provider: "sie-decide" as const, model: "test", at: "2026-11-20T00:00:00.000Z" };
type Vis = "full" | "partial" | "obscured";

/** One structure observation per part spec; role and item types given as the "yes" answers. */
function scene(parts: { role: PartRole; vis?: Vis; items?: [string, ItemType | null][] }[], stairDamage?: number) {
  const observations: ObservationOutput["observations"] = parts.map((p, i) => ({
    id: `O${i + 1}`, feature: p.role, description: `${p.role} description`, location: "here", visibility: "full", limitations: [`lim ${i + 1}`],
    parts: [{ part: p.role, visibility: p.vis ?? "full", items: (p.items ?? []).map(([t]) => t) }],
  }));
  const reads: PartRead[] = parts.map((p, i) => ({
    observationId: `O${i + 1}`, partIndex: 0, part: p.role, visibility: p.vis ?? "full",
    roles: Object.fromEntries(ASKED_ROLES.map((r) => [r, r === p.role ? 0.9 : 0.05])),
    items: (p.items ?? []).map(([text, type]) => ({ text, types: Object.fromEntries(ASKED_ITEM_TYPES.map((t) => [t, t === type ? 0.9 : 0.05])) })),
  }));
  const o: ObservationOutput = { roomType: "other_living_area", observations, unknowns: ["out of frame"] };
  const structOf = (r: PartRole) => (r.startsWith("stair") ? "stairs" : r.startsWith("bath") ? "bath" : r === "bedside" ? "bed" : null);
  const structures = Object.fromEntries(parts.map((p, i) => [`O${i + 1}`, { stairs: structOf(p.role) === "stairs" ? 0.9 : 0.05, bath: structOf(p.role) === "bath" ? 0.9 : 0.05, bed: structOf(p.role) === "bed" ? 0.9 : 0.05 }]));
  const cls: ClassifyResult = { parts: reads, stairCondition: Object.fromEntries(observations.map((x) => [x.id, stairDamage ?? 0.05])), structures, lamps: {}, wear: {}, calls: [] };
  return { o, cls, run: (cfg = DEFAULT_VALIDATOR) => validateClassifications(o, cls, source, cfg) };
}

describe("observation prompt stays neutral", () => {
  const p = observationPrompt("bathroom").toLowerCase();
  it("never names a category, a hazard, or a hazard-specific object", () => {
    for (const id of CATEGORY_IDS) expect(p).not.toContain(id.toLowerCase());
    for (const w of ["hazard", "risk", "fall", "handrail", "grab bar", "rug", "mat", "cord", "wire", "cable", "clutter", "lamp", "non-slip", "lighting"]) expect(p, w).not.toMatch(new RegExp(`\\b${w}s?\\b`));
  });
  it("asks for explicit empty lists, unknowns, and no judgements", () => {
    expect(p).toContain("empty list when the part is clearly visible and has nothing");
    expect(p).toContain("is not listed as empty");
    expect(p).toContain("do not judge whether anything is safe or unsafe");
  });
});

describe("GLiNER questions are single positive yes/no questions", () => {
  it("never ask about absence (Decide can't read negation)", () => {
    const qs = [...ASKED_ROLES.map(roleQuestion), ...ASKED_ITEM_TYPES.map(itemQuestion)];
    for (const q of qs) expect(q, q).not.toMatch(/\b(no|not|without|missing|lacks?)\b/i);
  });
});

describe("deterministic evidence validation", () => {
  it("D01-like: both stair sides fully visible and explicitly empty → H02 present, cited", () => {
    const s = scene([{ role: "stair_side" }, { role: "stair_side" }, { role: "stair_treads", items: [["potted plants", "plant_decor"], ["doormat", "rug"]] }]);
    const r = s.run();
    expect(r.categoryLabels.H02).toBe("present");
    expect(r.trace.H02.evidence.map((e) => e.observationId)).toEqual(["O1", "O2"]);
    expect(r.findings.find((f) => f.category === "H02")?.visibleEvidence[0]).toContain("nothing");
    expect(r.categoryLabels.H01).toBe("absent"); // plants are decoration, not loose objects
    expect(r.categoryLabels.H04).toBe("cannot_determine");
    expect(validateVisionResult(r)).toEqual([]);
    expect(traceProblems(r, s.o)).toEqual([]);
  });

  it("a missing handrail seen only on a partially visible side is CANNOT_DETERMINE, not a shopping trigger", () => {
    const r = scene([{ role: "stair_side", vis: "partial" }, { role: "stair_side", items: [["wooden handrail", "handrail"]] }]).run();
    expect(r.trace.H02).toMatchObject({ label: "cannot_determine", reason: "condition_only_partially_visible" });
  });

  it("D05-like: a staircase cut off at top and bottom still shows H02 when both sides are fully in view", () => {
    const s = scene([{ role: "stair_side", items: [["handrail", "handrail"]] }, { role: "stair_side" }]);
    for (const x of s.o.observations) x.visibility = "partial";
    expect(s.run().categoryLabels.H02).toBe("present");
  });

  it("H02 present needs a second side in view: one empty side alone defers", () => {
    expect(scene([{ role: "stair_side" }, { role: "stair_side", vis: "obscured" }]).run().trace.H02).toMatchObject({ label: "cannot_determine" });
  });

  it("D06-like: a damage read on worn paint or stains defers H03 (taxonomy: not visible)", () => {
    const s = scene([{ role: "stair_treads" }], 0.9);
    s.cls.wear = { O1: 0.8 };
    expect(s.run().categoryLabels.H03).toBe("cannot_determine");
  });

  it("H02 absent needs both sides seen with rails; one railed side is not enough", () => {
    expect(scene([{ role: "stair_side", items: [["metal handrail", "handrail"]] }, { role: "stair_side", items: [["metal handrail", "handrail"]] }]).run().categoryLabels.H02).toBe("absent");
    expect(scene([{ role: "stair_side", items: [["metal handrail", "handrail"]] }]).run().categoryLabels.H02).toBe("cannot_determine");
  });

  it("D03-like: tub walls without a grab bar and an empty tub floor → H09 and H10 present", () => {
    const r = scene([{ role: "bath_wall", items: [["soap dish", "fixture"]] }, { role: "bath_floor" }, { role: "open_floor" }]).run();
    expect([r.categoryLabels.H09, r.categoryLabels.H10, r.categoryLabels.H05]).toEqual(["present", "present", "absent"]);
  });

  it("D04-like: bar by the toilet, tub wall only partly visible → H09 CANNOT_DETERMINE", () => {
    const r = scene([{ role: "bath_wall", items: [["grab bar", "grab_bar"]] }, { role: "bath_wall", vis: "partial" }]).run();
    expect(r.categoryLabels.H09).toBe("cannot_determine");
  });

  it("a bathtub's 'side' can't become a stair side: roles are gated by the structure (D03 false positive)", () => {
    const s = scene([{ role: "bath_wall" }]);
    s.cls.parts[0].roles = { stair_side: 0.71, bath_wall: 0.68, bath_floor: 0.65 };
    const r = s.run();
    expect(r.categoryLabels.H02).toBe("not_applicable");
    expect(r.roles[0].role).toBe("bath_wall");
  });

  it("D08-like: left side obscured, right side seen empty → CANNOT_DETERMINE, not a missing-rail claim", () => {
    const s = scene([{ role: "stair_side", vis: "obscured" }, { role: "stair_side" }]);
    for (const x of s.o.observations) x.visibility = "partial";
    expect(s.run().trace.H02).toMatchObject({ label: "cannot_determine", reason: "condition_only_partially_visible" });
  });

  it("an empty tub floor on a tub only partly in frame defers H10 (whole-structure rule for bath/bed)", () => {
    const s = scene([{ role: "bath_floor" }]);
    s.o.observations[0].visibility = "partial";
    expect(s.run().categoryLabels.H10).toBe("cannot_determine");
  });

  it("D09-like: an object GLiNER can't type is still clutter on the floor, not a clear floor", () => {
    const s = scene([{ role: "open_floor", items: [["water jug", null] as [string, ItemType | null]] }]);
    s.cls.parts[0].items[0].types.loose_object = 0.4;
    expect(s.run().categoryLabels.H05).toBe("present");
    expect(scene([{ role: "open_floor", items: [["potted plant", "plant_decor"], ["rug", "rug"]] }]).run().categoryLabels.H05).toBe("absent");
    // Untyped AND confidently not a loose object (D05 "red carpet") → undecided, not clutter.
    const c = scene([{ role: "open_floor", items: [["red carpet", null] as [string, ItemType | null]] }]);
    c.cls.parts[0].items[0].types.loose_object = 0.1;
    c.cls.parts[0].items[0].types.rug = 0.45;
    expect(c.run().categoryLabels.H05).toBe("cannot_determine");
  });

  it("D07-like: a lamp observed on the nightstand clears H11 even when no bedside part lists it", () => {
    const s = scene([{ role: "bedside" }]);
    s.o.observations.push({ id: "O9", feature: "lamp", description: "desk lamp", location: "on the nightstand", visibility: "full", limitations: [], parts: [] });
    s.cls.lamps = { O9: { lamp: 0.9, byBed: 0.8 } };
    expect(s.run().trace.H11).toMatchObject({ label: "absent", evidence: [{ observationId: "O9" }] });
  });

  it("a towel bar is not a grab bar", () => {
    expect(scene([{ role: "bath_wall", items: [["chrome towel bar", "towel_bar"]] }]).run().categoryLabels.H09).toBe("present");
  });

  it("an item GLiNER can't type leaves the part unsettled, never 'lacks'", () => {
    const s = scene([{ role: "stair_side", items: [["dark shape", null] as [string, ItemType | null]] }, { role: "stair_side", items: [["handrail", "handrail"]] }]);
    s.cls.parts[0].items[0].types.handrail = 0.45; // inside a 0.3–0.6 unknown band
    expect(s.run({ minYes: 0.6, noBelow: 0.3 }).trace.H02).toMatchObject({ label: "cannot_determine", reason: "not_settled" });
  });

  it("D09-like: cords and loose objects on a visible floor → H05 and H07 present; furniture defers H08", () => {
    const r = scene([{ role: "open_floor", items: [["extension cords", "cord"], ["water jug", "loose_object"], ["speaker cabinet", "furniture"]] }]).run();
    expect([r.categoryLabels.H05, r.categoryLabels.H07, r.categoryLabels.H06]).toEqual(["present", "present", "absent"]);
    expect(r.trace.H08).toMatchObject({ label: "cannot_determine", reason: "route_obstruction_not_establishable" });
  });

  it("D07-like: a lamp beside the bed clears H11 even if another side isn't visible", () => {
    const r = scene([{ role: "bedside", items: [["desk lamp", "lamp"]] }, { role: "bedside", vis: "obscured" }]).run();
    expect(r.categoryLabels.H11).toBe("absent");
    expect(scene([{ role: "bedside" }]).run().categoryLabels.H11).toBe("present");
  });

  it("H03 needs a positive damage read; otherwise full treads with a confident no are absent", () => {
    expect(scene([{ role: "stair_treads" }], 0.9).run().categoryLabels.H03).toBe("present");
    expect(scene([{ role: "stair_treads" }], 0.1).run().categoryLabels.H03).toBe("absent");
    expect(scene([{ role: "stair_treads", vis: "partial" }], 0.1).run().categoryLabels.H03).toBe("cannot_determine");
  });

  it("an ordinary scene with no relevant parts is all NOT_APPLICABLE and creates no purchase", () => {
    const r = scene([{ role: "other", items: [["window", "other" as ItemType]] }]).run();
    expect(Object.values(r.categoryLabels).every((l) => l === "not_applicable")).toBe(true);
    expect(r.findings).toEqual([]);
  });

  it("ignores reads for observations Gemma never produced", () => {
    const s = scene([{ role: "other" }]);
    s.cls.parts.push({ observationId: "O99", partIndex: 0, part: "ghost", visibility: "full", roles: { open_floor: 0.99 }, items: [{ text: "cord", types: { cord: 0.99 } }] });
    s.cls.structures.O99 = {};
    expect(s.run().categoryLabels.H07).toBe("not_applicable");
  });

  it("only PRESENT reaches the shopping rules", () => {
    const toHazards = (r: ReturnType<ReturnType<typeof scene>["run"]>): HazardFinding[] => r.findings.map((f, i) => ({ ...f, id: `h${i}`, caseId: "c", imageId: "i", source }));
    expect(deriveRequirements("c", toHazards(scene([{ role: "bath_wall" }]).run())).requirements).toHaveLength(1);
    expect(deriveRequirements("c", toHazards(scene([{ role: "bath_wall", vis: "partial" }]).run())).requirements).toHaveLength(0);
  });

  it("keeps the taxonomy's limits in notEstablishedFromPhoto", () => {
    expect(scene([{ role: "bath_floor" }]).run().findings.find((f) => f.category === "H10")?.notEstablishedFromPhoto[0]).toBe(CATEGORY_SPECS.H10.notVisible);
  });
});

describe("tuning sweep", () => {
  it("re-scores stored reads with no model calls, and keeps invalid images invalid", () => {
    const s = scene([{ role: "bath_wall", items: [["bar", "grab_bar"]] }]);
    s.cls.parts[0].items[0].types.grab_bar = 0.65;
    const gt = { ...Object.fromEntries(CATEGORY_IDS.map((c) => [c, "not_applicable"])), H09: "absent" } as Record<HazardCategoryId, CategoryLabel>;
    const results = sweep([{ imageId: "D1", gt, observations: s.o, classified: s.cls, latencyMs: 1 }, { imageId: "D2", gt, latencyMs: 1 }], [DEFAULT_VALIDATOR, { minYes: 0.7, noBelow: 0.7 }]);
    // At 0.7 the 0.65 "grab bar" read becomes a no → the wall lacks one → a false positive.
    expect(results.map((r) => [r.score.fp, r.score.invalidImages])).toEqual([[0, ["D2"]], [1, ["D2"]]]);
  });
});

describe("development dataset guard", () => {
  it("refuses held-out records and files outside data/development", () => {
    expect(() => parseDevManifest([{ image_id: "X", split: "evaluation", file: "data/development/images/x.jpg" }], "/r")).toThrow(/not development/);
    expect(() => parseDevManifest([{ image_id: "X", split: "development", file: "data/evaluation/images/x.jpg" }], "/r")).toThrow(/outside data\/development/);
  });
  it.skipIf(!existsSync(steadyPrepDir()))("loads exactly the 10 development images", async () => {
    const recs = await loadDevelopmentSet();
    expect(recs.map((r) => r.imageId)).toEqual(Array.from({ length: 10 }, (_, i) => `STD-D${String(i + 1).padStart(2, "0")}`));
    for (const r of recs) expect(existsSync(r.file)).toBe(true);
  });
});

describe("scoring (methodology §3–4)", () => {
  const all = (l: CategoryLabel) => Object.fromEntries(CATEGORY_IDS.map((c) => [c, l])) as Record<HazardCategoryId, CategoryLabel>;
  const with_ = (base: CategoryLabel, o: Partial<Record<HazardCategoryId, CategoryLabel>>) => ({ ...all(base), ...o });
  const row = (imageId: string, gt: Record<HazardCategoryId, CategoryLabel>, pred: Record<HazardCategoryId, CategoryLabel> | null): ImagePrediction => ({ imageId, gt, pred, presentWithoutEvidence: [], requirementCount: 0, latencyMs: 10 });

  it("counts TP/FP/FN/deferred and keeps cannot_determine out of precision and recall", () => {
    const s = score([
      row("D1", with_("not_applicable", { H02: "present", H04: "cannot_determine" }), with_("not_applicable", { H02: "present", H04: "present", H05: "present" })),
      row("D2", with_("absent", { H09: "present", H10: "present" }), with_("absent", { H09: "cannot_determine", H10: "absent" })),
      row("D3", with_("absent", { H07: "cannot_determine" }), with_("absent", { H07: "absent" })),
    ]);
    expect({ tp: s.tp, fp: s.fp, fn: s.fn, deferred: s.deferred }).toEqual({ tp: 1, fp: 1, fn: 1, deferred: 1 });
    expect(s.precision).toMatchObject({ num: 1, den: 2 });
    expect(s.caughtOrEscalatedRecall).toMatchObject({ num: 2, den: 3 });
    expect(s.uncertainty).toMatchObject({ unsupportedPlus: 1, unsupportedMinus: 1, appropriate: { num: 0, den: 2 } });
  });

  it("scores an invalid image as missing every real hazard, and leaves empty ratios undefined", () => {
    const s = score([row("D1", with_("absent", { H02: "present" }), null)]);
    expect([s.invalidImages, s.fn]).toEqual([["D1"], 1]);
    expect(s.precision).toEqual({ num: 0, den: 0, value: undefined });
  });
});
