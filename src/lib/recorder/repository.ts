/**
 * Persistence boundary. Every workflow step reads and writes case data through this.
 *
 * Implementations:
 *   - SingleStoreCaseRepository (./singlestore.ts): the system of record, used when SINGLESTORE_* is set
 *   - JsonlCaseRepository (./jsonl.ts): append-only local records with the same table shape, for later loading
 *   - MemoryCaseRepository (here): tests only
 */

import type { CaseSnapshot } from "../case/state";
import type {
  AuditEvent,
  CaseId,
  HomeownerCase,
  ProductClassification,
  ProductEvidence,
} from "../../types/domain";

/** Entity collections that hang off a case. Each item carries `caseId` and `id`. */
export interface CaseCollections extends CaseSnapshot {
  evidence: ProductEvidence[];
  classifications: ProductClassification[];
}
export type CollectionName = keyof CaseCollections;
export type CollectionItem<K extends CollectionName> = CaseCollections[K][number];

export const COLLECTIONS: CollectionName[] = [
  "images",
  "hazards",
  "questions",
  "requirements",
  "candidates",
  "evidence",
  "classifications",
  "decisions",
  "actions",
];

export interface CaseRepository {
  readonly kind: "singlestore" | "jsonl" | "memory";
  createCase(c: HomeownerCase): Promise<void>;
  getCase(id: CaseId): Promise<HomeownerCase | null>;
  updateCase(id: CaseId, patch: Partial<Omit<HomeownerCase, "id">>): Promise<HomeownerCase>;
  /** Insert or replace by `id`. */
  upsert<K extends CollectionName>(collection: K, item: CollectionItem<K>): Promise<void>;
  list<K extends CollectionName>(collection: K, caseId: CaseId): Promise<CaseCollections[K]>;
  /**
   * Audit is append-only. SingleStore and memory are idempotent by `id` (re-appending a recorded
   * event is a no-op). JSONL still keeps duplicates: see docs/integrations/singlestore.md.
   */
  appendAudit(e: AuditEvent): Promise<void>;
  listAudit(caseId: CaseId): Promise<AuditEvent[]>;
}

export async function loadSnapshot(repo: CaseRepository, caseId: CaseId): Promise<CaseSnapshot> {
  const [images, hazards, questions, requirements, candidates, decisions, actions] = await Promise.all([
    repo.list("images", caseId),
    repo.list("hazards", caseId),
    repo.list("questions", caseId),
    repo.list("requirements", caseId),
    repo.list("candidates", caseId),
    repo.list("decisions", caseId),
    repo.list("actions", caseId),
  ]);
  return { images, hazards, questions, requirements, candidates, decisions, actions };
}

/** Everything recorded for one case: the case row, every collection and the ordered audit trail. */
export interface CaseHistory {
  case: HomeownerCase;
  collections: CaseCollections;
  audit: AuditEvent[];
}

/** Rebuild a case's full history from the recorder alone (no workflow state needed). */
export async function loadCaseHistory(repo: CaseRepository, caseId: CaseId): Promise<CaseHistory | null> {
  const c = await repo.getCase(caseId);
  if (!c) return null;
  const lists = await Promise.all(COLLECTIONS.map((name) => repo.list(name, caseId)));
  const collections = Object.fromEntries(COLLECTIONS.map((name, i) => [name, lists[i]])) as unknown as CaseCollections;
  return { case: c, collections, audit: await repo.listAudit(caseId) };
}

type Row = { id: string; caseId: CaseId };

export class MemoryCaseRepository implements CaseRepository {
  readonly kind = "memory" as const;
  private cases = new Map<CaseId, HomeownerCase>();
  private rows = new Map<CollectionName, Map<string, Row>>();
  private audit: AuditEvent[] = [];

  private table(name: CollectionName): Map<string, Row> {
    let t = this.rows.get(name);
    if (!t) this.rows.set(name, (t = new Map()));
    return t;
  }

  async createCase(c: HomeownerCase) {
    if (this.cases.has(c.id)) throw new Error(`Case ${c.id} already exists`);
    this.cases.set(c.id, structuredClone(c));
  }

  async getCase(id: CaseId) {
    const c = this.cases.get(id);
    return c ? structuredClone(c) : null;
  }

  async updateCase(id: CaseId, patch: Partial<Omit<HomeownerCase, "id">>) {
    const c = this.cases.get(id);
    if (!c) throw new Error(`Case ${id} not found`);
    const next = { ...c, ...structuredClone(patch), id, updatedAt: new Date().toISOString() };
    this.cases.set(id, next);
    return structuredClone(next);
  }

  async upsert<K extends CollectionName>(collection: K, item: CollectionItem<K>) {
    this.table(collection).set(item.id, structuredClone(item));
  }

  async list<K extends CollectionName>(collection: K, caseId: CaseId) {
    return [...this.table(collection).values()]
      .filter((r) => r.caseId === caseId)
      .map((r) => structuredClone(r)) as CaseCollections[K];
  }

  async appendAudit(e: AuditEvent) {
    if (this.audit.some((x) => x.id === e.id)) return;
    this.audit.push(structuredClone(e));
  }

  async listAudit(caseId: CaseId) {
    return this.audit.filter((e) => e.caseId === caseId).map((e) => structuredClone(e));
  }
}
