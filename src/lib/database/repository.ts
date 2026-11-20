/**
 * Persistence boundary. SingleStore is the target store (see schema.sql, a draft not yet run).
 *
 * Read from SingleStore's docs on 2026-11-20 and NOT yet connected: the recommended client is
 * `singlestore-nodejs` (import from "singlestore-nodejs/promise", then `createConnection({ host, port, user, password, database })`).
 * Shared clusters require SSL.
 *
 * `MemoryCaseRepository` is for local development and tests only. Data is lost on restart.
 */

import type { CaseSnapshot } from "@/lib/agent/workflow";
import { notImplemented } from "@/lib/integrations";
import type {
  AuditEvent,
  CaseId,
  HomeownerCase,
  ProductClassification,
  ProductEvidence,
} from "@/types/domain";

/** Entity collections that hang off a case. Each item carries `caseId` and `id`. */
export interface CaseCollections extends CaseSnapshot {
  evidence: ProductEvidence[];
  classifications: ProductClassification[];
}
export type CollectionName = keyof CaseCollections;

export interface CaseRepository {
  createCase(c: HomeownerCase): Promise<void>;
  getCase(id: CaseId): Promise<HomeownerCase | null>;
  updateCase(id: CaseId, patch: Partial<Omit<HomeownerCase, "id">>): Promise<HomeownerCase>;
  /** Insert or replace by `id`. */
  upsert<K extends CollectionName>(collection: K, item: CaseCollections[K][number]): Promise<void>;
  list<K extends CollectionName>(collection: K, caseId: CaseId): Promise<CaseCollections[K]>;
  snapshot(caseId: CaseId): Promise<CaseSnapshot>;
  /** Audit is append-only. */
  appendAudit(e: AuditEvent): Promise<void>;
  listAudit(caseId: CaseId): Promise<AuditEvent[]>;
}

type Row = { id: string; caseId: CaseId };

export class MemoryCaseRepository implements CaseRepository {
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

  async upsert<K extends CollectionName>(collection: K, item: CaseCollections[K][number]) {
    this.table(collection).set(item.id, structuredClone(item));
  }

  async list<K extends CollectionName>(collection: K, caseId: CaseId) {
    return [...this.table(collection).values()]
      .filter((r) => r.caseId === caseId)
      .map((r) => structuredClone(r)) as CaseCollections[K];
  }

  async snapshot(caseId: CaseId): Promise<CaseSnapshot> {
    const [images, hazards, questions, requirements, candidates, decisions, actions] = await Promise.all([
      this.list("images", caseId),
      this.list("hazards", caseId),
      this.list("questions", caseId),
      this.list("requirements", caseId),
      this.list("candidates", caseId),
      this.list("decisions", caseId),
      this.list("actions", caseId),
    ]);
    return { images, hazards, questions, requirements, candidates, decisions, actions };
  }

  async appendAudit(e: AuditEvent) {
    this.audit.push(structuredClone(e));
  }

  async listAudit(caseId: CaseId) {
    return this.audit.filter((e) => e.caseId === caseId).map((e) => structuredClone(e));
  }
}

/** SingleStore adapter. Not implemented until credentials exist and schema.sql has been run. */
export function getSingleStoreRepository(): CaseRepository {
  return notImplemented("singlestore", "repository");
}

