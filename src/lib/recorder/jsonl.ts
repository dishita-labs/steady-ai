/**
 * Local recorder: one append-only JSONL file per collection, under
 * `<STEADY_DATA_DIR>/records/`. Each line is `{ op, at, row }`, with `row` being the full
 * entity (the same shape the SingleStore `body` column holds), so the files can be loaded
 * into SingleStore later (a loader is not built yet).
 *
 * Reads replay the file (last write per id wins). Fine for dev volumes; not for production.
 */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AuditEvent, CaseId, HomeownerCase } from "../../types/domain";
import type { CaseCollections, CaseRepository, CollectionItem, CollectionName } from "./repository";
import { RECORD_FILES as TABLES } from "./tables";

export interface JsonlRecord<T = unknown> {
  op: "insert" | "upsert" | "append";
  at: string;
  row: T;
}

export class JsonlCaseRepository implements CaseRepository {
  readonly kind = "jsonl" as const;
  private ready: Promise<unknown>;

  constructor(private readonly dir: string) {
    this.ready = mkdir(dir, { recursive: true });
  }

  private file(table: string) {
    return join(this.dir, `${table}.jsonl`);
  }

  private async write(table: string, op: JsonlRecord["op"], row: unknown) {
    await this.ready;
    const rec: JsonlRecord = { op, at: new Date().toISOString(), row };
    await appendFile(this.file(table), JSON.stringify(rec) + "\n", "utf8");
  }

  private async read<T>(table: string): Promise<JsonlRecord<T>[]> {
    try {
      const text = await readFile(this.file(table), "utf8");
      return text
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as JsonlRecord<T>);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
  }

  /** Last write per id wins. */
  private async latest<T extends { id: string }>(table: string): Promise<Map<string, T>> {
    const m = new Map<string, T>();
    for (const r of await this.read<T>(table)) m.set(r.row.id, r.row);
    return m;
  }

  async createCase(c: HomeownerCase) {
    if ((await this.latest<HomeownerCase>(TABLES.cases)).has(c.id)) throw new Error(`Case ${c.id} already exists`);
    await this.write(TABLES.cases, "insert", c);
  }

  async getCase(id: CaseId) {
    return (await this.latest<HomeownerCase>(TABLES.cases)).get(id) ?? null;
  }

  async updateCase(id: CaseId, patch: Partial<Omit<HomeownerCase, "id">>) {
    const c = await this.getCase(id);
    if (!c) throw new Error(`Case ${id} not found`);
    const next = { ...c, ...patch, id, updatedAt: new Date().toISOString() };
    await this.write(TABLES.cases, "upsert", next);
    return next;
  }

  async upsert<K extends CollectionName>(collection: K, item: CollectionItem<K>) {
    await this.write(TABLES[collection], "upsert", item);
  }

  async list<K extends CollectionName>(collection: K, caseId: CaseId) {
    const rows = await this.latest<CollectionItem<K>>(TABLES[collection]);
    return [...rows.values()].filter((r) => r.caseId === caseId) as CaseCollections[K];
  }

  async appendAudit(e: AuditEvent) {
    await this.write(TABLES.audit, "append", e);
  }

  async listAudit(caseId: CaseId) {
    return (await this.read<AuditEvent>(TABLES.audit)).map((r) => r.row).filter((e) => e.caseId === caseId);
  }
}
