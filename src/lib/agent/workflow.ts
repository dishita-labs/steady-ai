/**
 * Explicit workflow state for a Steady case.
 *
 * `stage` says how far the case has progressed. `status` says whether it can keep moving.
 * Failure, missing evidence and escalation are statuses, so a case remembers where it stopped.
 *
 * Gates only require *some* item to be ready, so one blocked hazard (e.g. a handrail that
 * needs a professional) doesn't stop the rest of the case from moving forward.
 */

import type {
  ConstraintDecision,
  ContextQuestion,
  HazardFinding,
  ProductCandidate,
  ShoppingAction,
  ShoppingRequirement,
  UploadedImage,
} from "@/types/domain";

export const WORKFLOW_STAGES = [
  "CASE_CREATED",
  "PHOTO_ANALYZED",
  "REQUIREMENTS_DEFINED",
  "PRODUCTS_RESEARCHED",
  "PRODUCTS_EVALUATED",
  "PURCHASE_PREPARED",
  "APPROVAL_PENDING",
  "ACTION_COMPLETED",
] as const;
export type WorkflowStage = (typeof WORKFLOW_STAGES)[number];

export type CaseStatus =
  | "in_progress"
  /** Waiting on the user: missing context or evidence. */
  | "needs_input"
  /** Needs a human expert (e.g. structural / install question a photo can't answer). */
  | "escalated"
  /** A tool or integration failed; retryable. */
  | "failed"
  | "completed";

/** Everything the gates look at. Loaded from the repository for one case. */
export interface CaseSnapshot {
  images: UploadedImage[];
  hazards: HazardFinding[];
  questions: ContextQuestion[];
  requirements: ShoppingRequirement[];
  candidates: ProductCandidate[];
  decisions: ConstraintDecision[];
  actions: ShoppingAction[];
}

export interface GateResult {
  ok: boolean;
  /** Plain-language reasons the case can't enter the stage yet. */
  blockers: string[];
}

export function stageIndex(stage: WorkflowStage): number {
  return WORKFLOW_STAGES.indexOf(stage);
}

export function nextStage(stage: WorkflowStage): WorkflowStage | null {
  return WORKFLOW_STAGES[stageIndex(stage) + 1] ?? null;
}

const gate = (blockers: (string | false)[]): GateResult => {
  const b = blockers.filter((x): x is string => Boolean(x));
  return { ok: b.length === 0, blockers: b };
};

/** Can the case *enter* `target`? Pure function of the snapshot. */
export function checkGate(target: WorkflowStage, s: CaseSnapshot): GateResult {
  const ready = s.requirements.filter((r) => r.status === "ready");
  const readyIds = new Set(ready.map((r) => r.id));
  const decided = new Set(s.decisions.map((d) => d.candidateId));
  const eligible = s.decisions.filter((d) => d.outcome === "eligible");

  switch (target) {
    case "CASE_CREATED":
      return gate([]);
    case "PHOTO_ANALYZED":
      return gate([
        !s.images.some((i) => i.analysisStatus === "analyzed") && "No photo has been analyzed yet.",
      ]);
    case "REQUIREMENTS_DEFINED":
      return gate([
        ready.length === 0 &&
          (s.requirements.some((r) => r.status === "needs_context")
            ? "Every requirement is waiting on context from the user."
            : "No shopping requirement is ready."),
      ]);
    case "PRODUCTS_RESEARCHED":
      return gate([
        !s.candidates.some((c) => c.requirementIds.some((id) => readyIds.has(id))) &&
          "No product candidates found for a ready requirement.",
      ]);
    case "PRODUCTS_EVALUATED": {
      const relevant = s.candidates.filter((c) => c.requirementIds.some((id) => readyIds.has(id)));
      const undecided = relevant.filter((c) => !decided.has(c.id));
      return gate([
        relevant.length === 0 && "No candidates to evaluate.",
        undecided.length > 0 && `${undecided.length} candidate(s) have no rules-engine decision yet.`,
      ]);
    }
    case "PURCHASE_PREPARED":
      return gate([
        eligible.length === 0 && "No candidate passed every mandatory constraint.",
        !s.actions.some((a) => a.status !== "failed") && "No cart or purchase request has been prepared.",
      ]);
    case "APPROVAL_PENDING":
      return gate([
        !s.actions.some((a) => ["awaiting_approval", "approved", "executed"].includes(a.status)) &&
          "No prepared action has been sent to the user for approval.",
      ]);
    case "ACTION_COMPLETED":
      return gate([
        !s.actions.some((a) => a.status === "executed" && a.approval) &&
          "No action has been executed with explicit user approval.",
      ]);
  }
}

/** Move to the next stage if its gate passes. Never skips stages. */
export function tryAdvance(
  stage: WorkflowStage,
  s: CaseSnapshot,
): { stage: WorkflowStage; advanced: boolean; blockers: string[] } {
  const next = nextStage(stage);
  if (!next) return { stage, advanced: false, blockers: ["Workflow already complete."] };
  const g = checkGate(next, s);
  return g.ok ? { stage: next, advanced: true, blockers: [] } : { stage, advanced: false, blockers: g.blockers };
}

/** Derive whether the user or a human expert is needed, independent of the stage. */
export function deriveStatus(stage: WorkflowStage, s: CaseSnapshot): CaseStatus {
  if (stage === "ACTION_COMPLETED") return "completed";
  const openQuestions = s.questions.some((q) => q.status === "open");
  const anyReady = s.requirements.some((r) => r.status === "ready");
  if (openQuestions && !anyReady && stageIndex(stage) >= stageIndex("PHOTO_ANALYZED")) return "needs_input";
  if (stage === "APPROVAL_PENDING") return "needs_input";
  // Every visible hazard needs a human, and nothing else can move.
  const present = s.hazards.filter((h) => h.label === "present");
  if (present.length > 0 && present.every((h) => h.professionalAssessmentRecommended) && !anyReady) {
    return "escalated";
  }
  return "in_progress";
}
