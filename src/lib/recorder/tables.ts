/**
 * Storage layout for the recorders (see schema.sql).
 *
 * SingleStore has three tables:
 *   - `cases`: one row per case, with typed columns.
 *   - `case_items`: every per-case collection (images, hazards, ... actions), told apart by
 *     `kind`. The free shared tier allows 10 tables per database, which rules out one table
 *     per collection.
 *   - `audit_events`: append-only, kept separate so nothing ever UPDATEs it.
 *
 * Every row stores the full entity in `body JSON`, plus a few typed columns copied out of it
 * for filtering. Reads use `body` only, so adding a field to a domain type never needs a
 * migration; adding a filter column does.
 */

import type {
  AuditEvent,
  ConstraintDecision,
  ContextQuestion,
  HazardFinding,
  HomeownerCase,
  ProductCandidate,
  ProductClassification,
  ShoppingAction,
  ShoppingRequirement,
  UploadedImage,
} from "../../types/domain";
import type { CollectionName } from "./repository";

export const TABLES = {
  cases: "cases",
  items: "case_items",
  audit: "audit_events",
} as const;

/** JSONL recorder: one file per collection (the file name, without `.jsonl`). */
export const RECORD_FILES = {
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

/** Typed columns for `cases` and `audit_events`, besides `id`, `case_id` and `body`. */
export const COLUMNS = {
  cases: (c: HomeownerCase): Columns => ({
    stage: c.stage,
    status: c.status,
    workflow_run_id: c.workflowRunId ?? null,
    created_at: toDatetime(c.createdAt),
    updated_at: toDatetime(c.updatedAt),
  }),
  audit: (e: AuditEvent): Columns => ({ at: toDatetime(e.at), type: e.type, stage: e.stage }),
};

/** The `case_items.status` column: each kind's main state field, or null when it has none. */
export const ITEM_STATUS = {
  images: (i: UploadedImage) => i.analysisStatus,
  hazards: (h: HazardFinding) => h.severity,
  questions: (q: ContextQuestion) => q.status,
  requirements: (r: ShoppingRequirement) => r.status,
  candidates: (c: ProductCandidate) => c.status,
  evidence: (): null => null,
  classifications: (k: ProductClassification) => (k.concern ? "concern" : "ok"),
  decisions: (d: ConstraintDecision) => d.outcome,
  actions: (a: ShoppingAction) => a.status,
} satisfies Record<CollectionName, (x: never) => string | null>;
