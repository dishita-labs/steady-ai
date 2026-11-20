/**
 * Mapping from domain collections to SingleStore tables (see schema.sql).
 *
 * Every table stores the full entity in `body JSON`, plus a few typed columns copied out of it
 * for filtering and joins. Reads use `body` only, so adding a field to a domain type never
 * needs a migration; adding a filter column does.
 */

import type {
  AuditEvent,
  ConstraintDecision,
  ContextQuestion,
  HazardFinding,
  HomeownerCase,
  ProductCandidate,
  ProductClassification,
  ProductEvidence,
  ShoppingAction,
  ShoppingRequirement,
  UploadedImage,
} from "../../types/domain";
import type { CollectionName } from "./repository";

export const TABLES = {
  cases: "cases",
  images: "uploaded_images",
  hazards: "hazard_findings",
  questions: "context_questions",
  requirements: "shopping_requirements",
  candidates: "product_candidates",
  evidence: "product_evidence",
  classifications: "product_classifications",
  decisions: "constraint_decisions",
  actions: "shopping_actions",
  audit: "audit_events",
} as const satisfies Record<CollectionName | "cases" | "audit", string>;

export type Columns = Record<string, string | number | boolean | null>;

/** ISO-8601 → SingleStore DATETIME(6) literal (UTC). */
export function toDatetime(iso: string): string {
  return iso.replace("T", " ").replace("Z", "").slice(0, 26);
}

/** Typed columns per table, besides `id`, `case_id` and `body`. */
export const COLUMNS = {
  cases: (c: HomeownerCase): Columns => ({
    stage: c.stage,
    status: c.status,
    workflow_run_id: c.workflowRunId ?? null,
    created_at: toDatetime(c.createdAt),
    updated_at: toDatetime(c.updatedAt),
  }),
  images: (i: UploadedImage): Columns => ({ room: i.room, analysis_status: i.analysisStatus, sha256: i.sha256 }),
  hazards: (h: HazardFinding): Columns => ({ image_id: h.imageId, category: h.category, label: h.label, severity: h.severity }),
  questions: (q: ContextQuestion): Columns => ({ status: q.status, requirement_id: q.requirementId ?? null }),
  requirements: (r: ShoppingRequirement): Columns => ({
    rule_id: r.ruleId,
    product_type: r.productType,
    status: r.status,
    safety_critical: r.safetyCritical,
  }),
  candidates: (c: ProductCandidate): Columns => ({ url: c.url, status: c.status }),
  evidence: (e: ProductEvidence): Columns => ({ candidate_id: e.candidateId, kind: e.kind, source_url: e.sourceUrl }),
  classifications: (k: ProductClassification): Columns => ({
    candidate_id: k.candidateId,
    requirement_id: k.requirementId,
    concern: k.concern,
  }),
  decisions: (d: ConstraintDecision): Columns => ({
    candidate_id: d.candidateId,
    requirement_id: d.requirementId,
    outcome: d.outcome,
    engine_version: d.engineVersion,
    decided_at: toDatetime(d.decidedAt),
  }),
  actions: (a: ShoppingAction): Columns => ({
    type: a.type,
    status: a.status,
    simulated: a.simulated,
    adapter: a.adapter,
    updated_at: toDatetime(a.updatedAt),
  }),
  audit: (e: AuditEvent): Columns => ({ at: toDatetime(e.at), type: e.type, stage: e.stage }),
} satisfies Record<keyof typeof TABLES, (x: never) => Columns>;
