/**
 * Stage 3: deterministic evidence validation. Pure; no model calls.
 *
 * Turns per-observation GLiNER answers into one H01–H11 label per category, in the production
 * `VisionAnalysisResult` shape (so `validateVisionResult` and `deriveRequirements` accept it),
 * plus a trace of which observations decided each label and why.
 *
 * Rules, applied per category in this order:
 *   1. PRESENT     needs at least one observation GLiNER read as `hazard` AND that Gemma saw in
 *                  `full` visibility. Those observation ids are the evidence.
 *   2. Unsupported `hazard` reads (only partial/obscured observations) become CANNOT_DETERMINE,
 *                  never PRESENT, so they can't trigger shopping.
 *   3. Any failed classification for the category → CANNOT_DETERMINE (incomplete is not absent).
 *   4. ABSENT      needs a fully visible observation read as `no_hazard`, and the category's
 *                  deciding fact must be photographable (H04's switches/bulbs are not).
 *   5. Partial `no_hazard` reads, or `unclear` reads → CANNOT_DETERMINE.
 *   6. Every observation `unrelated` → NOT_APPLICABLE (the area isn't in the photo).
 * Zero PRESENT categories is a valid result.
 */

import type { VisionAnalysisResult, VisionFindingDraft } from "../../src/lib/vision";
import type { CategoryLabel, HazardCategoryId, ProviderRef } from "../../src/types/domain";
import type { ObservationCategoryAnswer } from "./classify";
import { CATEGORY_IDS, CATEGORY_SPECS } from "./definitions";
import type { Observation, ObservationOutput } from "./observe";

export type TraceReason =
  | "visible_hazard"
  | "hazard_only_partially_visible"
  | "classification_incomplete"
  | "visible_absence"
  | "absence_not_establishable_from_photo"
  | "area_partially_visible"
  | "area_seen_but_unclear"
  | "area_not_in_photo";

export interface CategoryTrace {
  label: CategoryLabel;
  reason: TraceReason;
  /** Observations that decided the label. Empty only for NOT_APPLICABLE. */
  observationIds: string[];
  /** Raw GLiNER reads for this category: observation id → label. */
  reads: Record<string, string>;
}

export interface ExperimentResult extends VisionAnalysisResult {
  trace: Record<HazardCategoryId, CategoryTrace>;
  /** GLiNER `hazard` reads the validator refused to turn into PRESENT. */
  downgradedHazardReads: number;
}

function decide(id: HazardCategoryId, answers: ObservationCategoryAnswer[], obs: Map<string, Observation>): CategoryTrace {
  const mine = answers.filter((a) => a.category === id && obs.has(a.observationId));
  const reads = Object.fromEntries(mine.map((a) => [a.observationId, a.label]));
  const vis = (a: ObservationCategoryAnswer) => obs.get(a.observationId)!.visibility;
  const ids = (xs: ObservationCategoryAnswer[]) => xs.map((a) => a.observationId);
  const by = (l: string) => mine.filter((a) => a.label === l);

  const hazardFull = by("hazard").filter((a) => vis(a) === "full");
  if (hazardFull.length) return { label: "present", reason: "visible_hazard", observationIds: ids(hazardFull), reads };
  const hazardPartial = by("hazard");
  if (hazardPartial.length) return { label: "cannot_determine", reason: "hazard_only_partially_visible", observationIds: ids(hazardPartial), reads };
  if (by("invalid").length) return { label: "cannot_determine", reason: "classification_incomplete", observationIds: ids(by("invalid")), reads };

  const clearFull = by("no_hazard").filter((a) => vis(a) === "full");
  if (clearFull.length) {
    return CATEGORY_SPECS[id].absenceEstablishable
      ? { label: "absent", reason: "visible_absence", observationIds: ids(clearFull), reads }
      : { label: "cannot_determine", reason: "absence_not_establishable_from_photo", observationIds: ids(clearFull), reads };
  }
  if (by("no_hazard").length) return { label: "cannot_determine", reason: "area_partially_visible", observationIds: ids(by("no_hazard")), reads };
  if (by("unclear").length) return { label: "cannot_determine", reason: "area_seen_but_unclear", observationIds: ids(by("unclear")), reads };
  return { label: "not_applicable", reason: "area_not_in_photo", observationIds: [], reads };
}

export function validateClassifications(o: ObservationOutput, answers: ObservationCategoryAnswer[], source: ProviderRef): ExperimentResult {
  const obs = new Map(o.observations.map((x) => [x.id, x]));
  const trace = Object.fromEntries(CATEGORY_IDS.map((id) => [id, decide(id, answers, obs)])) as Record<HazardCategoryId, CategoryTrace>;

  const findings: VisionFindingDraft[] = [];
  for (const id of CATEGORY_IDS) {
    const t = trace[id];
    if (t.label !== "present" && t.label !== "cannot_determine") continue;
    const spec = CATEGORY_SPECS[id];
    const cited = t.observationIds.map((i) => obs.get(i)).filter((x): x is Observation => Boolean(x));
    findings.push({
      category: id,
      label: t.label,
      summary: `${spec.name}: ${t.reason.replace(/_/g, " ")} (${t.observationIds.join(", ") || "no observation"}).`,
      // PRESENT evidence is only fully visible observations (rule 1); CD may cite partial ones.
      visibleEvidence: cited.map((x) => `[${x.id}] ${x.feature}: ${x.description}`),
      location: cited.length ? { description: cited.map((x) => `[${x.id}] ${x.location}`).join(" ") } : undefined,
      severity: spec.placeholderSeverity,
      notEstablishedFromPhoto: [spec.notVisible, ...cited.flatMap((x) => x.limitations)],
      humanAssessmentRequired: t.label === "cannot_determine",
      professionalAssessmentRecommended: spec.professionalAssessment,
    });
  }

  const hazardReads = answers.filter((a) => a.label === "hazard" && obs.has(a.observationId));
  const downgradedHazardReads = hazardReads.filter((a) => trace[a.category].label !== "present").length;
  return {
    categoryLabels: Object.fromEntries(CATEGORY_IDS.map((id) => [id, trace[id].label])) as Record<HazardCategoryId, CategoryLabel>,
    findings,
    uncertainties: o.unknowns,
    humanAssessmentRequired: findings.some((f) => f.humanAssessmentRequired),
    source,
    trace,
    downgradedHazardReads,
  };
}

/** Every cited observation id must exist in Gemma's output; PRESENT must cite at least one full one. */
export function traceProblems(r: ExperimentResult, o: ObservationOutput): string[] {
  const obs = new Map(o.observations.map((x) => [x.id, x]));
  const problems: string[] = [];
  for (const id of CATEGORY_IDS) {
    const t = r.trace[id];
    for (const oid of t.observationIds) if (!obs.has(oid)) problems.push(`${id} cites unknown observation ${oid}.`);
    if (t.label === "present" && !t.observationIds.some((oid) => obs.get(oid)?.visibility === "full")) {
      problems.push(`${id} is present without a fully visible observation.`);
    }
  }
  return problems;
}
