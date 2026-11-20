/**
 * Steady shared domain model.
 *
 * Every entity has an explicit ID and points at the entities it depends on by ID, so any
 * decision can be traced back to the hazard, requirement, evidence and rules behind it.
 *
 * We store observable things only: structured findings, evidence excerpts, tool results,
 * rule outcomes and actions. Hidden model reasoning is never stored.
 */

import type { CaseStatus, WorkflowStage } from "../lib/case/state";

export type Iso8601 = string;

export type CaseId = string;
export type ImageId = string;
export type HazardId = string;
export type QuestionId = string;
export type RequirementId = string;
export type ConstraintId = string;
export type CandidateId = string;
export type EvidenceId = string;
export type ClassificationId = string;
export type DecisionId = string;
export type ActionId = string;
export type AuditEventId = string;

/** Who or what produced a piece of data. */
export interface ProviderRef {
  provider: "sie-vision" | "sie-decide" | "exa" | "rules-engine" | "shopping" | "user" | "system";
  /** Model or API identifier actually used, e.g. "fastino/GLiNER2.5-Decide". */
  model?: string;
  /** Provider-side request/session/event ID, when the provider returns one. */
  externalRef?: string;
  at: Iso8601;
}

// ---------------------------------------------------------------------------
// Case
// ---------------------------------------------------------------------------

export type RoomType =
  | "bathroom"
  | "stairs"
  | "entrance"
  | "bedroom"
  | "hallway"
  | "other_living_area"
  | "unknown";

/** Context the family gives us. Everything is optional; gaps become ContextQuestions. */
export interface HouseholdContext {
  budgetMaxUsd?: number;
  ownership?: "own" | "rent" | "unknown";
  /** Free text from the user, e.g. "uses a cane", "shower is a tub combo". */
  notes?: string;
}

export interface HomeownerCase {
  id: CaseId;
  createdAt: Iso8601;
  updatedAt: Iso8601;
  stage: WorkflowStage;
  status: CaseStatus;
  /** Human-readable reason when status is blocked, escalated or failed. */
  statusReason?: string;
  household: HouseholdContext;
  /** Workflow SDK run that drives this case. */
  workflowRunId?: string;
}

/** A piece of missing context Steady asks the user for, instead of assuming it. */
export interface ContextQuestion {
  id: QuestionId;
  caseId: CaseId;
  hazardId?: HazardId;
  requirementId?: RequirementId;
  question: string;
  /** Which requirement attribute the answer fills, e.g. "wall_type", "tub_width_in". */
  field: string;
  status: "open" | "answered" | "skipped";
  answer?: string;
  askedAt: Iso8601;
  answeredAt?: Iso8601;
}

// ---------------------------------------------------------------------------
// Photo and hazards
// ---------------------------------------------------------------------------

export interface UploadedImage {
  id: ImageId;
  caseId: CaseId;
  /** Where the bytes live (object storage key or local path). Never a public URL by default. */
  storageKey: string;
  mimeType: "image/jpeg" | "image/png" | "image/webp" | "image/heic";
  sha256: string;
  width?: number;
  height?: number;
  room: RoomType;
  /** The user confirmed they may share this photo of the home. */
  consentConfirmed: boolean;
  uploadedAt: Iso8601;
  analysisStatus: "pending" | "analyzed" | "failed";
}

/** Hazard categories H01–H11 (CDC STEADI "Check for Safety"-based taxonomy from steady-prep). */
export const HAZARD_CATEGORIES = {
  H01: "objects_on_stairs",
  H02: "stair_handrail_missing_or_one_side",
  H03: "stair_step_condition",
  H04: "stair_lighting",
  H05: "floor_clutter",
  H06: "throw_rugs",
  H07: "cords_wires_on_floor",
  H08: "furniture_in_path",
  H09: "grab_bars_absent",
  H10: "tub_shower_no_nonslip",
  H11: "bedside_lighting",
} as const;
export type HazardCategoryId = keyof typeof HAZARD_CATEGORIES;

export type CategoryLabel = "present" | "absent" | "cannot_determine" | "not_applicable";

export type Severity = "low" | "moderate" | "high";

export interface HazardFinding {
  id: HazardId;
  caseId: CaseId;
  imageId: ImageId;
  category: HazardCategoryId;
  /** Findings are only created for hazards that are visible or that the photo can't settle. */
  label: Extract<CategoryLabel, "present" | "cannot_determine">;
  summary: string;
  /** What is actually visible in the photo. Must be non-empty when label is "present". */
  visibleEvidence: string[];
  location?: { description: string; bbox?: [x: number, y: number, w: number, h: number] };
  severity: Severity;
  /** Properties the photo cannot establish (anchoring, slipperiness, wall structure...). */
  notEstablishedFromPhoto: string[];
  humanAssessmentRequired: boolean;
  professionalAssessmentRecommended: boolean;
  /** Model-reported confidence. Informational only; never used as a safety gate. */
  modelConfidence?: number;
  source: ProviderRef;
}

// ---------------------------------------------------------------------------
// Requirements and products
// ---------------------------------------------------------------------------

export type ConstraintValue = string | number | boolean;

/** A single checkable condition on a product attribute. Evaluated by the rules engine. */
export interface RequirementConstraint {
  id: ConstraintId;
  /** Normalized attribute name, e.g. "length_in", "mount_type", "ada_compliant". */
  attribute: string;
  op: "eq" | "neq" | "gte" | "lte" | "one_of" | "present";
  value?: ConstraintValue | ConstraintValue[];
  unit?: string;
  /** Why this constraint exists, in plain language. */
  rationale: string;
  /**
   * Yes/no question put to the Decide model about product text for this attribute,
   * e.g. "Does the product say it supports at least 250 lb?". Optional.
   */
  decideQuestion?: string;
  /** Preferred constraints only: ranking weight when it passes (default 1). */
  weight?: number;
  /** The product-fitness checklist item this constraint was generated from (src/lib/product-fitness). */
  checklistItem?: string;
}

export interface ShoppingRequirement {
  id: RequirementId;
  caseId: CaseId;
  /** The deterministic rule that produced this requirement (lib/rules/requirements.ts). */
  ruleId: string;
  /** Hazards this requirement addresses. */
  hazardIds: HazardId[];
  /** e.g. "grab_bar", "stair_handrail", "non_slip_bath_mat", "plug_in_night_light". */
  productType: string;
  mandatory: RequirementConstraint[];
  preferred: RequirementConstraint[];
  /** Install-bearing items (rails, grab bars) are safety-critical. */
  safetyCritical: boolean;
  installation: "none" | "diy" | "professional_recommended" | "unknown";
  openQuestionIds: QuestionId[];
  status: "draft" | "needs_context" | "ready" | "dropped";
}

export interface ObservedPrice {
  amount: number;
  currency: string;
  observedAt: Iso8601;
  sourceUrl: string;
  /** Prices from search/page content are stale until re-checked at the retailer. */
  verified: boolean;
}

export interface ProductCandidate {
  id: CandidateId;
  caseId: CaseId;
  requirementIds: RequirementId[];
  title: string;
  url: string;
  retailer?: string;
  price?: ObservedPrice;
  availability?: { status: "in_stock" | "out_of_stock" | "unknown"; observedAt: Iso8601; verified: boolean };
  /** Attributes extracted from evidence. Each must cite the evidence it came from. */
  attributes: ProductAttribute[];
  evidenceIds: EvidenceId[];
  discoveredBy: ProviderRef & { query: string };
  /** 1-based position in the search results; the last tie-breaker when ranking. */
  searchRank?: number;
  status: "discovered" | "evaluated" | "selected" | "rejected" | "needs_verification";
}

export interface ProductAttribute {
  name: string;
  value: ConstraintValue;
  unit?: string;
  evidenceId: EvidenceId;
  /** The verbatim seller text inside the evidence that this attribute rests on. */
  quote?: string;
}

/** A retained piece of source material. Never synthesized; always tied to a URL. */
export interface ProductEvidence {
  id: EvidenceId;
  caseId: CaseId;
  candidateId: CandidateId;
  sourceUrl: string;
  kind: "page_text" | "highlight" | "summary" | "structured_extraction";
  /** Verbatim excerpt (or provider summary, labeled as such by `kind`). */
  excerpt: string;
  contentSha256?: string;
  source: ProviderRef;
}

/** One typed answer from the Decide model, verbatim from the SIE response. */
export interface TypedAnswer {
  /** Question id sent in `outputSchema`, e.g. "suitability" or a constraint id. */
  questionId: string;
  type: "noul" | "choice" | "score";
  /** The answer the model picked ("yes"/"no", a choice label, or a score level). */
  answer: string;
  /** Probability per option, as returned. */
  probabilities: Record<string, number>;
  /** Set when the question probes a requirement constraint. */
  constraintId?: ConstraintId;
}

/**
 * Advisory output of the Decide model (Superlinked SIE, GLiNER2.5 Decide). Never a certification.
 * Each classification covers one candidate × requirement pair over one chunk of evidence text.
 */
export interface ProductClassification {
  id: ClassificationId;
  caseId: CaseId;
  candidateId: CandidateId;
  requirementId: RequirementId;
  answers: TypedAnswer[];
  /** True when the classifier raises a concern. Can only downgrade a decision, never upgrade. */
  concern: boolean;
  evidenceIds: EvidenceId[];
  source: ProviderRef;
}

// ---------------------------------------------------------------------------
// Decisions, actions, audit
// ---------------------------------------------------------------------------

export type DecisionOutcome = "eligible" | "rejected" | "needs_verification";

export interface RuleResult {
  constraintId: ConstraintId;
  attribute: string;
  outcome: "pass" | "fail" | "unknown";
  observed?: ConstraintValue;
  /** The evidence the observed value came from. Absent when outcome is "unknown". */
  evidenceId?: EvidenceId;
  explanation: string;
}

export interface ConstraintDecision {
  id: DecisionId;
  caseId: CaseId;
  candidateId: CandidateId;
  requirementId: RequirementId;
  outcome: DecisionOutcome;
  ruleResults: RuleResult[];
  /** Preferred constraints, checked the same way. They rank eligible products; they never gate. */
  preferredResults?: RuleResult[];
  /** Sum of the weights of passing preferred constraints. */
  score?: number;
  /** Every evidence item a rule result relied on. */
  evidenceIds: EvidenceId[];
  /** Advisory classifier outputs that were considered. */
  classificationIds: ClassificationId[];
  /** Plain-language notes, e.g. "Safety-critical install: professional assessment recommended". */
  notes: string[];
  engineVersion: string;
  decidedAt: Iso8601;
}

export interface ShoppingAction {
  id: ActionId;
  caseId: CaseId;
  type: "prepare_cart" | "purchase_request";
  candidateIds: CandidateId[];
  decisionIds: DecisionId[];
  status: "prepared" | "awaiting_approval" | "approved" | "declined" | "executed" | "failed";
  /** True when no real retailer/cart was touched. The UI must label simulated actions. */
  simulated: boolean;
  adapter: string;
  approval?: { approvedBy: string; approvedAt: Iso8601; method: "explicit_user_confirmation" };
  externalRef?: string;
  error?: string;
  createdAt: Iso8601;
  updatedAt: Iso8601;
}

export type AuditEventType =
  | "case.created"
  | "case.stage_changed"
  | "case.status_changed"
  | "image.uploaded"
  | "vision.described"
  | "vision.classified"
  | "vision.analyzed"
  | "context.question_asked"
  | "context.question_answered"
  | "requirement.defined"
  | "product.searched"
  | "product.content_retrieved"
  | "product.classified"
  | "decision.made"
  | "action.prepared"
  | "action.approval_requested"
  | "action.approved"
  | "action.declined"
  | "action.executed"
  | "action.failed"
  | "integration.error";

export interface AuditEvent {
  id: AuditEventId;
  caseId: CaseId;
  at: Iso8601;
  type: AuditEventType;
  actor: { kind: "user" | "agent" | "system" | "tool"; id: string };
  stage: WorkflowStage;
  /** The entity this event is about. */
  subject?: { kind: string; id: string };
  summary: string;
  /** Structured, JSON-serializable detail. No secrets, no hidden model reasoning. */
  data?: Record<string, unknown>;
  toolCall?: { provider: ProviderRef["provider"]; operation: string; ok: boolean; durationMs?: number; externalRef?: string };
}
