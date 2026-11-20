/**
 * Stage 3: deterministic evidence validation. Pure; no model calls.
 *
 * Inputs: Gemma's structure parts (with explicit, possibly EMPTY item lists) and GLiNER's
 * positive yes/no reads ("is this part a stair side?", "is this item a handrail?").
 * Output: one H01–H11 label per category in the production `VisionAnalysisResult` shape, so
 * `validateVisionResult` and `deriveRequirements` accept it, plus a trace of the parts behind it.
 *
 * Fixed evidence rules (not tunable):
 *   - PRESENT needs a FULLY visible part. A condition seen only on partial/obscured parts is
 *     CANNOT_DETERMINE, so it can't trigger shopping.
 *   - "Lacks X" is only established by a fully visible part whose listed items are all confidently
 *     not X (an empty list counts: Gemma stated nothing is there). An item GLiNER can't type
 *     makes the part unknown, never "lacks".
 *   - ABSENT needs every relevant part fully visible and settled. Uncertainty outranks absence.
 *   - H04 (stair lighting) is never ABSENT: switches and working bulbs aren't photographable.
 *   - H08 (furniture in a path) is never PRESENT from a list: whether furniture blocks a route
 *     isn't established by its presence, so it defers.
 *   - No relevant part in the photo → NOT_APPLICABLE. Zero PRESENT categories is a valid result.
 * Tunable: the P(yes) thresholds in `ValidatorConfig`.
 */

import type { VisionAnalysisResult, VisionFindingDraft } from "../../src/lib/vision";
import type { CategoryLabel, HazardCategoryId, ProviderRef } from "../../src/types/domain";
import { ROLE_NEEDS, type ClassifyResult, type PartRead, type PYes, type Structure } from "./classify";
import { CATEGORY_IDS, CATEGORY_SPECS, type ItemType, type PartRole } from "./definitions";
import type { ObservationOutput } from "./observe";

export interface ValidatorConfig {
  /** A GLiNER yes counts when P(yes) ≥ this. */
  minYes: number;
  /** A GLiNER no counts when P(yes) < this. Between noBelow and minYes is "unknown". */
  noBelow: number;
}
export const DEFAULT_VALIDATOR: ValidatorConfig = { minYes: 0.5, noBelow: 0.5 };

type Tri = "yes" | "no" | "unknown";
const tri = (p: PYes | undefined, cfg: ValidatorConfig): Tri => (p == null ? "unknown" : p >= cfg.minYes ? "yes" : p < cfg.noBelow ? "no" : "unknown");

/**
 * The part's role: the most likely role GLiNER said yes to, among roles its structure allows
 * (stair roles need a staircase, bath roles a tub/shower/toilet, bedside a bed), else `other`.
 */
export function partRole(p: PartRead, structure: Partial<Record<Structure, PYes>> | undefined, cfg: ValidatorConfig): PartRole {
  let best: PartRole = "other";
  let bestP = -1;
  for (const [role, pYes] of Object.entries(p.roles) as [PartRole, PYes][]) {
    const needs = ROLE_NEEDS[role];
    if (needs && tri(structure?.[needs], cfg) !== "yes") continue;
    if (tri(pYes, cfg) === "yes" && (pYes ?? 0) > bestP) [best, bestP] = [role, pYes!];
  }
  return best;
}

/** Does the part hold an item of this type? Plant/decoration wins over loose_object when more likely. */
function holds(p: PartRead, type: ItemType, cfg: ValidatorConfig): Tri {
  const reads = p.items.map((it) => {
    const r = tri(it.types[type], cfg);
    if (r === "yes" && type === "loose_object" && (it.types.plant_decor ?? 0) > (it.types.loose_object ?? 0)) return "no";
    if (r === "yes" && type === "grab_bar" && (it.types.towel_bar ?? 0) > (it.types.grab_bar ?? 0)) return "no";
    return r;
  });
  if (reads.includes("yes")) return "yes";
  return reads.every((r) => r === "no") ? "no" : "unknown"; // empty list → every() is true → "no"
}

/** Types that are NOT floor clutter when GLiNER is confident (cords have their own category, H07). */
const NOT_CLUTTER: ItemType[] = ["rug", "carpet", "cord", "furniture", "plant_decor", "fixture", "lamp", "handrail", "grab_bar", "towel_bar", "bath_mat"];

/**
 * Floor clutter (H05): any object on the floor counts unless GLiNER is confident it is something
 * else (a rug, cord, furniture...). An object it can't type is still an object on the floor;
 * treating it as "nothing" would turn missing information into absence.
 */
function holdsClutter(p: PartRead, cfg: ValidatorConfig): Tri {
  const reads = p.items.map((it): Tri => {
    if (tri(it.types.loose_object, cfg) === "yes" && (it.types.plant_decor ?? 0) <= (it.types.loose_object ?? 0)) return "yes";
    return NOT_CLUTTER.some((t) => tri(it.types[t], cfg) === "yes") ? "no" : "yes";
  });
  return reads.includes("yes") ? "yes" : "no";
}

export type TraceReason =
  | "visible_condition"
  | "condition_only_partially_visible"
  | "visible_absence"
  | "not_settled"
  | "absence_not_establishable_from_photo"
  | "route_obstruction_not_establishable"
  | "area_not_in_photo";

export interface PartRef {
  observationId: string;
  part: string;
  visibility: string;
  items: string[];
}

export interface CategoryTrace {
  label: CategoryLabel;
  reason: TraceReason;
  /** The parts that decided the label. Empty only for NOT_APPLICABLE. */
  evidence: PartRef[];
}

export interface ExperimentResult extends VisionAnalysisResult {
  trace: Record<HazardCategoryId, CategoryTrace>;
  /** Part roles as decided, for inspection. */
  roles: { observationId: string; part: string; role: PartRole }[];
}

const ref = (p: PartRead): PartRef => ({ observationId: p.observationId, part: p.part, visibility: p.visibility, items: p.items.map((i) => i.text) });
const full = (p: PartRead) => p.visibility === "full";

/**
 * Generic rule for "condition = the part holds (or lacks) something".
 *   hazardWhen "holds": PRESENT if a full part holds it; ABSENT if every part is full and lacks it.
 *   hazardWhen "lacks": PRESENT if a full part lacks it; ABSENT if every part is full and holds it.
 */
function partRule(
  parts: PartRead[],
  type: ItemType | ((p: PartRead) => Tri),
  hazardWhen: "holds" | "lacks",
  cfg: ValidatorConfig,
  structureFull: (p: PartRead) => boolean = () => true,
): CategoryTrace | null {
  if (!parts.length) return null;
  const states = parts.map((p) => ({ p, h: typeof type === "function" ? type(p) : holds(p, type, cfg) }));
  const isHazard = (h: Tri) => (hazardWhen === "holds" ? h === "yes" : h === "no");
  const isClear = (h: Tri) => (hazardWhen === "holds" ? h === "no" : h === "yes");
  // A SEEN item counts on a fully visible part. A claimed ABSENCE ("this side has nothing") also
  // needs the whole structure in frame: an empty side of a cut-off staircase proves nothing.
  const hazardFull = states.filter((s) => full(s.p) && isHazard(s.h) && (hazardWhen === "holds" || structureFull(s.p)));
  if (hazardFull.length) return { label: "present", reason: "visible_condition", evidence: hazardFull.map((s) => ref(s.p)) };
  const hazardPartial = states.filter((s) => isHazard(s.h));
  if (hazardPartial.length) return { label: "cannot_determine", reason: "condition_only_partially_visible", evidence: hazardPartial.map((s) => ref(s.p)) };
  if (states.every((s) => full(s.p) && isClear(s.h))) return { label: "absent", reason: "visible_absence", evidence: parts.map(ref) };
  return { label: "cannot_determine", reason: "not_settled", evidence: states.filter((s) => !full(s.p) || !isClear(s.h)).map((s) => ref(s.p)) };
}

const NA: CategoryTrace = { label: "not_applicable", reason: "area_not_in_photo", evidence: [] };
const defer = (parts: PartRead[], reason: TraceReason = "not_settled"): CategoryTrace => ({ label: "cannot_determine", reason, evidence: parts.map(ref) });

export function validateClassifications(o: ObservationOutput, cls: ClassifyResult, source: ProviderRef, cfg: ValidatorConfig = DEFAULT_VALIDATOR): ExperimentResult {
  const known = new Set(o.observations.map((x) => x.id));
  const parts = cls.parts.filter((p) => known.has(p.observationId)); // never cite an observation Gemma didn't produce
  const roleOf = new Map(parts.map((p) => [p, partRole(p, cls.structures?.[p.observationId], cfg)]));
  const by = (r: PartRole) => parts.filter((p) => roleOf.get(p) === r);
  const sides = by("stair_side"), treads = by("stair_treads"), stairs = [...sides, ...treads];
  const walls = by("bath_wall"), bathFloors = by("bath_floor"), bedside = by("bedside"), floors = by("open_floor");
  const obsVis = new Map(o.observations.map((x) => [x.id, x.visibility]));
  const structureFull = (p: PartRead) => obsVis.get(p.observationId) === "full";

  const trace = {} as Record<HazardCategoryId, CategoryTrace>;
  trace.H01 = partRule(treads, "loose_object", "holds", cfg) ?? (sides.length ? defer(sides) : NA);
  // H02 is "no handrail, or one on only one side": both a present and an absent claim need two
  // sides fully seen. (Gemma marks a staircase "partial" when its top or bottom is cut off, so the
  // whole-structure test is the wrong one here: it deferred D05/D10, whose sides were both in view.)
  const h02 = partRule(sides, "handrail", "lacks", cfg);
  const fullSides = sides.filter(full).length;
  trace.H02 = !h02 ? (treads.length ? defer(treads) : NA) : h02.label !== "cannot_determine" && fullSides < 2 ? defer(sides, h02.label === "present" ? "condition_only_partially_visible" : "not_settled") : h02;
  // H03: a positive "damaged steps" read on a stairs observation; absence needs full treads and a confident no.
  if (!stairs.length) trace.H03 = NA;
  else {
    const stairObs = [...new Set(stairs.map((p) => p.observationId))];
    const reads = stairObs.map((id) => ({ id, t: tri(cls.stairCondition[id], cfg) }));
    const damaged = reads.filter((r) => r.t === "yes").map((r) => r.id);
    const dmgParts = stairs.filter((p) => damaged.includes(p.observationId));
    const wearOnly = damaged.length > 0 && damaged.every((id) => tri(cls.wear?.[id], cfg) === "yes");
    if (wearOnly) trace.H03 = defer(dmgParts, "absence_not_establishable_from_photo");
    else if (dmgParts.some(full)) trace.H03 = { label: "present", reason: "visible_condition", evidence: dmgParts.filter(full).map(ref) };
    else if (dmgParts.length) trace.H03 = defer(dmgParts, "condition_only_partially_visible");
    else if (treads.length && treads.every(full) && reads.every((r) => r.t === "no")) trace.H03 = { label: "absent", reason: "visible_absence", evidence: treads.map(ref) };
    else trace.H03 = defer(stairs);
  }
  trace.H04 = stairs.length ? defer(stairs, "absence_not_establishable_from_photo") : NA;
  trace.H05 = partRule(floors, (p) => holdsClutter(p, cfg), "holds", cfg) ?? NA;
  trace.H06 = partRule(floors, "rug", "holds", cfg) ?? NA;
  trace.H07 = partRule(floors, "cord", "holds", cfg) ?? NA;
  const h08 = partRule(floors, "furniture", "holds", cfg);
  trace.H08 = !h08 ? NA : h08.label === "present" ? { ...h08, label: "cannot_determine", reason: "route_obstruction_not_establishable" } : h08;
  trace.H09 = partRule(walls, "grab_bar", "lacks", cfg, structureFull) ?? (bathFloors.length ? defer(bathFloors) : NA);
  trace.H10 = partRule(bathFloors, "bath_mat", "lacks", cfg, structureFull) ?? (walls.length ? defer(walls) : NA);
  // H11: one lamp within reach clears it, whether listed on a bedside part or observed on its own
  // "on a nightstand / next to a bed". Otherwise every bedside part (and the bed) must be seen.
  const lampsByBed = o.observations.filter((x) => tri(cls.lamps?.[x.id]?.lamp, cfg) === "yes" && tri(cls.lamps?.[x.id]?.byBed, cfg) === "yes");
  const h11 = partRule(bedside, "lamp", "lacks", cfg, structureFull);
  if (!h11) trace.H11 = NA;
  else if (bedside.some((p) => holds(p, "lamp", cfg) === "yes")) trace.H11 = { label: "absent", reason: "visible_absence", evidence: bedside.filter((p) => holds(p, "lamp", cfg) === "yes").map(ref) };
  else if (lampsByBed.length) trace.H11 = { label: "absent", reason: "visible_absence", evidence: lampsByBed.map((x) => ({ observationId: x.id, part: "(whole observation)", visibility: x.visibility, items: [x.feature] })) };
  else trace.H11 = h11;

  const findings: VisionFindingDraft[] = [];
  const obsById = new Map(o.observations.map((x) => [x.id, x]));
  for (const id of CATEGORY_IDS) {
    const t = trace[id];
    if (t.label !== "present" && t.label !== "cannot_determine") continue;
    const spec = CATEGORY_SPECS[id];
    findings.push({
      category: id,
      label: t.label,
      summary: `${spec.name}: ${t.reason.replace(/_/g, " ")}.`,
      visibleEvidence: t.evidence.map((e) => `[${e.observationId}] ${obsById.get(e.observationId)?.feature ?? ""}, ${e.part} (${e.visibility}): ${e.items.length ? e.items.join(", ") : "nothing"}`),
      location: t.evidence.length ? { description: [...new Set(t.evidence.map((e) => `[${e.observationId}] ${obsById.get(e.observationId)?.location ?? ""}`))].join(" ") } : undefined,
      severity: spec.placeholderSeverity,
      notEstablishedFromPhoto: [spec.notVisible, ...new Set(t.evidence.flatMap((e) => obsById.get(e.observationId)?.limitations ?? []))],
      humanAssessmentRequired: t.label === "cannot_determine",
      professionalAssessmentRecommended: spec.professionalAssessment,
    });
  }

  return {
    categoryLabels: Object.fromEntries(CATEGORY_IDS.map((id) => [id, trace[id].label])) as Record<HazardCategoryId, CategoryLabel>,
    findings,
    uncertainties: o.unknowns,
    humanAssessmentRequired: findings.some((f) => f.humanAssessmentRequired),
    source,
    trace,
    roles: parts.map((p) => ({ observationId: p.observationId, part: p.part, role: roleOf.get(p)! })),
  };
}

/** Every cited observation must exist; PRESENT must cite at least one fully visible part. */
export function traceProblems(r: ExperimentResult, o: ObservationOutput): string[] {
  const known = new Set(o.observations.map((x) => x.id));
  const problems: string[] = [];
  for (const id of CATEGORY_IDS) {
    const t = r.trace[id];
    for (const e of t.evidence) if (!known.has(e.observationId)) problems.push(`${id} cites unknown observation ${e.observationId}.`);
    if (t.label === "present" && !t.evidence.some((e) => e.visibility === "full")) problems.push(`${id} is present without a fully visible part.`);
    if (t.label !== "not_applicable" && !t.evidence.length) problems.push(`${id} is ${t.label} without evidence.`);
  }
  return problems;
}
