/**
 * Deterministic constraint engine.
 *
 * - Each mandatory constraint is checked against an evidence-backed product attribute.
 * - A missing attribute is "unknown", never assumed to pass.
 * - Any fail → rejected. Otherwise any unknown → needs_verification. Otherwise eligible.
 * - Advisory classifier output can only downgrade eligible → needs_verification.
 *   It can never turn a fail or unknown into a pass.
 */

import type {
  ConstraintDecision,
  ConstraintValue,
  DecisionOutcome,
  ProductAttribute,
  ProductCandidate,
  ProductClassification,
  RequirementConstraint,
  RuleResult,
  ShoppingRequirement,
  TypedAnswer,
} from "../../types/domain";

export const ENGINE_VERSION = "rules-0.2.0";

/**
 * Deterministic concern policy over Decide answers. DRAFT, to be revisited after evaluation.
 * A concern is raised when the model picks "reject" or "needs_evidence" for suitability, or
 * "no" on a constraint question. A concern can only downgrade eligible → needs_verification;
 * a "yes" never counts as evidence that a constraint passes.
 */
export function classificationConcern(answers: TypedAnswer[]): { concern: boolean; reasons: string[] } {
  const reasons: string[] = [];
  for (const a of answers) {
    if (a.questionId === "suitability" && a.answer !== "candidate") reasons.push(`suitability: ${a.answer}`);
    if (a.constraintId && a.type === "noul" && a.answer === "no") reasons.push(`${a.constraintId}: no`);
  }
  return { concern: reasons.length > 0, reasons };
}

function normalize(v: ConstraintValue): ConstraintValue {
  return typeof v === "string" ? v.trim().toLowerCase() : v;
}

function compare(c: RequirementConstraint, observed: ConstraintValue): boolean | null {
  const o = normalize(observed);
  const expected = c.value;
  switch (c.op) {
    case "present":
      return o !== "" && o !== false;
    case "eq":
      return expected !== undefined && !Array.isArray(expected) ? o === normalize(expected) : null;
    case "neq":
      return expected !== undefined && !Array.isArray(expected) ? o !== normalize(expected) : null;
    case "gte":
    case "lte": {
      if (typeof o !== "number" || typeof expected !== "number") return null;
      return c.op === "gte" ? o >= expected : o <= expected;
    }
    case "one_of":
      return Array.isArray(expected) ? expected.map(normalize).includes(o) : null;
  }
}

export function evaluateConstraint(c: RequirementConstraint, attributes: ProductAttribute[]): RuleResult {
  const attr = attributes.find((a) => a.name === c.attribute);
  const base = { constraintId: c.id, attribute: c.attribute };
  if (!attr) {
    return { ...base, outcome: "unknown", explanation: `No evidence found for "${c.attribute}".` };
  }
  if (c.unit && attr.unit && c.unit !== attr.unit) {
    return {
      ...base,
      outcome: "unknown",
      observed: attr.value,
      evidenceId: attr.evidenceId,
      explanation: `Unit mismatch: required ${c.unit}, evidence gives ${attr.unit}. Not converted automatically.`,
    };
  }
  const result = compare(c, attr.value);
  if (result === null) {
    return {
      ...base,
      outcome: "unknown",
      observed: attr.value,
      evidenceId: attr.evidenceId,
      explanation: `Value "${String(attr.value)}" can't be compared with ${c.op} ${JSON.stringify(c.value)}.`,
    };
  }
  return {
    ...base,
    outcome: result ? "pass" : "fail",
    observed: attr.value,
    evidenceId: attr.evidenceId,
    explanation: `${c.attribute} = ${String(attr.value)}${attr.unit ? ` ${attr.unit}` : ""}; required ${c.op}${
      c.value !== undefined ? ` ${JSON.stringify(c.value)}` : ""
    }${c.unit ? ` ${c.unit}` : ""}.`,
  };
}

export interface EvaluateInput {
  id: string;
  requirement: ShoppingRequirement;
  candidate: ProductCandidate;
  classifications?: ProductClassification[];
  now?: Date;
}

export function evaluateCandidate({ id, requirement, candidate, classifications = [], now }: EvaluateInput): ConstraintDecision {
  const ruleResults = requirement.mandatory.map((c) => evaluateConstraint(c, candidate.attributes));
  const notes: string[] = [];

  let outcome: DecisionOutcome = ruleResults.some((r) => r.outcome === "fail")
    ? "rejected"
    : ruleResults.some((r) => r.outcome === "unknown")
      ? "needs_verification"
      : "eligible";

  if (requirement.mandatory.length === 0) {
    outcome = "needs_verification";
    notes.push("Requirement has no mandatory constraints; nothing was verified.");
  }

  const relevant = classifications.filter(
    (k) => k.candidateId === candidate.id && k.requirementId === requirement.id,
  );
  if (outcome === "eligible" && relevant.some((k) => k.concern)) {
    outcome = "needs_verification";
    notes.push("Classifier raised a concern; a person should check before selecting.");
  }

  if (requirement.safetyCritical) {
    notes.push("Safety-critical item: a photo and a product page can't confirm a safe install. In-person check recommended.");
  }
  if (candidate.price && !candidate.price.verified) {
    notes.push("Price is from retrieved page content and may be stale.");
  }

  return {
    id,
    caseId: candidate.caseId,
    candidateId: candidate.id,
    requirementId: requirement.id,
    outcome,
    ruleResults,
    evidenceIds: [...new Set(ruleResults.flatMap((r) => (r.evidenceId ? [r.evidenceId] : [])))],
    classificationIds: relevant.map((k) => k.id),
    notes,
    engineVersion: ENGINE_VERSION,
    decidedAt: (now ?? new Date()).toISOString(),
  };
}
