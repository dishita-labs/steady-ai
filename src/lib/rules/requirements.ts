/**
 * Deterministic hazard → shopping-requirement rules.
 *
 * Each rule has a stable ID and version, and every requirement it produces records which rule
 * made it, so a recommendation can be traced back: photo finding → rule → requirement →
 * evidence → rule results → decision.
 *
 * Mandatory and preferred constraints come from the product-fitness checklist
 * (src/lib/product-fitness/checklist.ts, `checklistConstraints`): cited gates such as the
 * ADA §609.8 250 lb strength for grab bars. The checklist decides which attributes exist;
 * the rules engine decides eligibility. Context questions are still TODO.
 */

import { stableId } from "../ids";
import { checklistConstraints } from "../product-fitness/checklist";
import type {
  CaseId,
  ContextQuestion,
  HazardCategoryId,
  HazardFinding,
  RequirementConstraint,
  ShoppingRequirement,
} from "../../types/domain";

export const REQUIREMENT_RULES_VERSION = "req-rules-0.1.0";

export interface RequirementRule {
  /** Stable ID, recorded on the requirement. */
  id: string;
  hazard: HazardCategoryId;
  productType: string;
  /** Exa query. Deterministic: no LLM writes search queries. */
  searchQuery: string;
  safetyCritical: boolean;
  installation: ShoppingRequirement["installation"];
  mandatory: Omit<RequirementConstraint, "id">[];
  preferred: Omit<RequirementConstraint, "id">[];
  /** Context to ask the family for before shopping (fills a constraint value). */
  questions: { field: string; question: string }[];
}

/**
 * One rule per hazard category, at most. A category without a rule produces no requirement
 * and is reported as "no rule" in the audit trail.
 */
export const REQUIREMENT_RULES: RequirementRule[] = [
  {
    id: "R-H09-grab-bar",
    hazard: "H09",
    productType: "grab_bar",
    searchQuery: "ADA compliant stainless steel bathroom grab bar",
    safetyCritical: true,
    installation: "professional_recommended",
    ...checklistConstraints("grab_bar"),
    questions: [], // TODO: e.g. wall type, stud locations
  },
  {
    id: "R-H10-nonslip-mat",
    hazard: "H10",
    productType: "non_slip_bath_mat",
    searchQuery: "non-slip bath mat with suction cups for bathtub",
    safetyCritical: false,
    installation: "none",
    ...checklistConstraints("non_slip_bath_mat"),
    questions: [], // TODO: tub floor smooth or textured (suction mats need smooth)
  },
  {
    id: "R-H11-night-light",
    hazard: "H11",
    productType: "plug_in_night_light",
    searchQuery: "motion sensor plug-in LED night light",
    safetyCritical: false,
    installation: "none",
    ...checklistConstraints("plug_in_night_light"),
    questions: [],
  },
];

export interface DerivedRequirements {
  requirements: ShoppingRequirement[];
  questions: ContextQuestion[];
  /** Hazard categories that were found but have no rule. */
  unmatched: HazardCategoryId[];
}

/** Pure function: findings → requirements and context questions. Only "present" findings drive shopping. */
export function deriveRequirements(
  caseId: CaseId,
  hazards: HazardFinding[],
  rules: RequirementRule[] = REQUIREMENT_RULES,
  now = new Date(),
): DerivedRequirements {
  const present = hazards.filter((h) => h.label === "present");
  const byCategory = new Map<HazardCategoryId, HazardFinding[]>();
  for (const h of present) byCategory.set(h.category, [...(byCategory.get(h.category) ?? []), h]);

  const requirements: DerivedRequirements["requirements"] = [];
  const questions: ContextQuestion[] = [];
  const unmatched: HazardCategoryId[] = [];

  for (const [category, findings] of byCategory) {
    const rule = rules.find((r) => r.hazard === category);
    if (!rule) {
      unmatched.push(category);
      continue;
    }
    const requirementId = stableId("req", caseId, rule.id);
    const qs: ContextQuestion[] = rule.questions.map((q) => ({
      id: stableId("q", requirementId, q.field),
      caseId,
      requirementId,
      hazardId: findings[0]?.id,
      question: q.question,
      field: q.field,
      status: "open",
      askedAt: now.toISOString(),
    }));
    questions.push(...qs);
    requirements.push({
      id: requirementId,
      caseId,
      ruleId: rule.id,
      hazardIds: findings.map((f) => f.id),
      productType: rule.productType,
      mandatory: rule.mandatory.map((c, i) => ({ ...c, id: `${rule.id}.m${i}` })),
      preferred: rule.preferred.map((c, i) => ({ ...c, id: `${rule.id}.p${i}` })),
      safetyCritical: rule.safetyCritical,
      installation: rule.installation,
      openQuestionIds: qs.map((q) => q.id),
      status: qs.length ? "needs_context" : "ready",
    });
  }
  return { requirements, questions, unmatched };
}

export function ruleFor(ruleId: string, rules: RequirementRule[] = REQUIREMENT_RULES): RequirementRule | undefined {
  return rules.find((r) => r.id === ruleId);
}
