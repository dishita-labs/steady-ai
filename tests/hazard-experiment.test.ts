/**
 * Unit tests for the hazard-classification experiment's pure parts. No model calls: the GLiNER
 * answers below are hand-written inputs to the deterministic validator, not model results.
 */

import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CALL_CHAR_BUDGET, CHOICE_LABELS, callSize, groupQuestions, observationText, type ObservationCategoryAnswer } from "../experiments/hazard-classification/classify";
import { parseDevManifest, loadDevelopmentSet, steadyPrepDir } from "../experiments/hazard-classification/dataset";
import { CATEGORY_IDS, CATEGORY_SPECS, QUESTION_GROUPS } from "../experiments/hazard-classification/definitions";
import { ObservationOutput, observationPrompt, type Observation } from "../experiments/hazard-classification/observe";
import { score, type ImagePrediction } from "../experiments/hazard-classification/score";
import { traceProblems, validateClassifications } from "../experiments/hazard-classification/validate";
import { deriveRequirements } from "../src/lib/rules/requirements";
import { validateVisionResult } from "../src/lib/vision";
import type { CategoryLabel, HazardCategoryId, HazardFinding } from "../src/types/domain";

const source = { provider: "sie-decide" as const, model: "test", at: "2026-11-20T00:00:00.000Z" };
const obs = (id: string, visibility: Observation["visibility"], feature = "thing", description = "desc"): Observation => ({ id, feature, description, location: "somewhere", visibility, limitations: [] });
const out = (...o: Observation[]): ObservationOutput => ({ roomType: "bathroom", observations: o, unknowns: ["walls out of frame"] });
/** Every category unrelated for every observation, then override some reads. */
function answers(o: ObservationOutput, overrides: [string, HazardCategoryId, ObservationCategoryAnswer["label"]][]): ObservationCategoryAnswer[] {
  const base = o.observations.flatMap((x) => CATEGORY_IDS.map((c) => ({ observationId: x.id, category: c, label: "unrelated" as ObservationCategoryAnswer["label"], probabilities: {} })));
  for (const [id, c, l] of overrides) base.find((a) => a.observationId === id && a.category === c)!.label = l;
  return base;
}

describe("observation prompt stays neutral", () => {
  const p = observationPrompt("bathroom").toLowerCase();
  it("never names a category, a hazard, or a hazard-specific object", () => {
    for (const id of CATEGORY_IDS) expect(p).not.toContain(id.toLowerCase());
    for (const w of ["hazard", "risk", "fall", "handrail", "grab bar", "rug", "mat", "cord", "wire", "cable", "clutter", "lamp", "non-slip", "lighting"]) expect(p, w).not.toMatch(new RegExp(`\\b${w}s?\\b`));
  });
  it("asks for unknowns and forbids judgements and unphotographable properties", () => {
    expect(p).toContain("limitations");
    expect(p).toContain("do not judge whether anything is safe or unsafe");
    expect(p).toContain("how slippery");
  });
});

describe("GLiNER questions", () => {
  it("cover every category exactly once, as 4-way choices", () => {
    expect(QUESTION_GROUPS.flat().sort()).toEqual([...CATEGORY_IDS].sort());
    for (const g of QUESTION_GROUPS) for (const q of Object.values(groupQuestions(g))) {
      expect(q.type).toBe("choice");
      expect(Object.keys((q as { criteria: Record<string, string> }).criteria)).toEqual([...CHOICE_LABELS]);
    }
  });
  it("fit the call budget with a long observation", () => {
    const long = obs("O12", "partial", "staircase", "x".repeat(400));
    long.limitations = ["y".repeat(120), "z".repeat(120)];
    const text = observationText(long, "other_living_area");
    for (const g of QUESTION_GROUPS) expect(callSize(text, groupQuestions(g)), g.join(",")).toBeLessThanOrEqual(CALL_CHAR_BUDGET);
  });
});

describe("deterministic evidence validation", () => {
  it("PRESENT needs a fully visible hazard observation and cites it", () => {
    const o = out(obs("O1", "full", "bathtub", "Tub wall with nothing mounted on it."), obs("O2", "full", "floor"));
    const r = validateClassifications(o, answers(o, [["O1", "H09", "hazard"]]), source);
    expect(r.categoryLabels.H09).toBe("present");
    expect(r.trace.H09).toMatchObject({ reason: "visible_hazard", observationIds: ["O1"] });
    expect(r.findings.find((f) => f.category === "H09")?.visibleEvidence).toEqual(["[O1] bathtub: Tub wall with nothing mounted on it."]);
    expect(validateVisionResult(r)).toEqual([]);
    expect(traceProblems(r, o)).toEqual([]);
  });

  it("a hazard read on a partially visible observation becomes CANNOT_DETERMINE, not a shopping trigger", () => {
    const o = out(obs("O1", "partial", "staircase", "Staircase, left edge cut off by the frame."));
    const r = validateClassifications(o, answers(o, [["O1", "H02", "hazard"]]), source);
    expect(r.categoryLabels.H02).toBe("cannot_determine");
    expect(r.trace.H02.reason).toBe("hazard_only_partially_visible");
    expect(r.downgradedHazardReads).toBe(1);
  });

  it("uncertain hazard evidence outranks a visible absence elsewhere (missing info is not absence)", () => {
    const o = out(obs("O1", "full", "toilet", "Grab bar beside the toilet."), obs("O2", "partial", "tub surround", "Tub wall, mostly out of frame."));
    const r = validateClassifications(o, answers(o, [["O1", "H09", "no_hazard"], ["O2", "H09", "hazard"]]), source);
    expect(r.categoryLabels.H09).toBe("cannot_determine");
  });

  it("ABSENT needs a fully visible no-hazard read; partial or unclear reads defer", () => {
    const o = out(obs("O1", "full"), obs("O2", "partial"), obs("O3", "full"));
    const r = validateClassifications(o, answers(o, [["O1", "H05", "no_hazard"], ["O2", "H06", "no_hazard"], ["O3", "H07", "unclear"]]), source);
    expect(r.trace.H05).toMatchObject({ label: "absent", reason: "visible_absence", observationIds: ["O1"] });
    expect(r.trace.H06).toMatchObject({ label: "cannot_determine", reason: "area_partially_visible" });
    expect(r.trace.H07).toMatchObject({ label: "cannot_determine", reason: "area_seen_but_unclear" });
  });

  it("never marks stair lighting absent: switches and bulbs aren't photographable", () => {
    const o = out(obs("O1", "full", "ceiling light"));
    const r = validateClassifications(o, answers(o, [["O1", "H04", "no_hazard"]]), source);
    expect(r.trace.H04).toMatchObject({ label: "cannot_determine", reason: "absence_not_establishable_from_photo" });
  });

  it("a failed classification defers instead of reading as absent", () => {
    const o = out(obs("O1", "full"));
    const r = validateClassifications(o, answers(o, [["O1", "H11", "invalid"]]), source);
    expect(r.trace.H11).toMatchObject({ label: "cannot_determine", reason: "classification_incomplete" });
  });

  it("an area nobody mentions is NOT_APPLICABLE, and zero hazards is a valid, purchase-free result", () => {
    const o = out(obs("O1", "full", "window"));
    const r = validateClassifications(o, answers(o, []), source);
    expect(Object.values(r.categoryLabels).every((l) => l === "not_applicable")).toBe(true);
    expect(r.findings).toEqual([]);
    expect(validateVisionResult(r)).toEqual([]);
  });

  it("ignores reads that cite observations Gemma never produced", () => {
    const o = out(obs("O1", "full"));
    const ghost: ObservationCategoryAnswer = { observationId: "O9", category: "H07", label: "hazard", probabilities: {} };
    const r = validateClassifications(o, [...answers(o, []), ghost], source);
    expect(r.categoryLabels.H07).toBe("not_applicable");
    expect(traceProblems(r, o)).toEqual([]);
  });

  it("only validated PRESENT findings reach the shopping rules", () => {
    const toHazards = (r: ReturnType<typeof validateClassifications>): HazardFinding[] => r.findings.map((f, i) => ({ ...f, id: `h${i}`, caseId: "c", imageId: "i", source }));
    const o = out(obs("O1", "full", "bathtub"), obs("O2", "partial", "bathtub"));
    const confirmed = validateClassifications(o, answers(o, [["O1", "H09", "hazard"]]), source);
    const uncertain = validateClassifications(o, answers(o, [["O2", "H09", "hazard"]]), source);
    expect(deriveRequirements("c", toHazards(confirmed)).requirements).toHaveLength(1);
    expect(deriveRequirements("c", toHazards(uncertain)).requirements).toHaveLength(0);
  });

  it("keeps every category's taxonomy limits in notEstablishedFromPhoto", () => {
    const o = out(obs("O1", "full"));
    const r = validateClassifications(o, answers(o, [["O1", "H10", "hazard"]]), source);
    expect(r.findings[0].notEstablishedFromPhoto[0]).toBe(CATEGORY_SPECS.H10.notVisible);
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
    expect(s.strictRecall).toMatchObject({ num: 1, den: 3 });
    expect(s.caughtOrEscalatedRecall).toMatchObject({ num: 2, den: 3 });
    expect(s.uncertainty).toMatchObject({ unsupportedPlus: 1, unsupportedMinus: 1, appropriate: { num: 0, den: 2 } });
    expect(s.imageLevel.negativeImages).toEqual([{ imageId: "D3", fp: 0, requirements: 0, fullyNegative: false }]);
  });

  it("scores an invalid image as missing every real hazard, and leaves empty ratios undefined", () => {
    const s = score([row("D1", with_("absent", { H02: "present" }), null)]);
    expect(s.invalidImages).toEqual(["D1"]);
    expect(s.fn).toBe(1);
    expect(s.precision).toEqual({ num: 0, den: 0, value: undefined });
  });
});
