/**
 * SingleStore recorder over the MySQL wire protocol (`mysql2/promise`).
 *
 * SingleStore's docs recommend `singlestore-nodejs`, but aube's supply-chain check refused it
 * (low download count), and SingleStore speaks the MySQL protocol, so we use `mysql2`.
 * Shared/cloud clusters require TLS; set SINGLESTORE_SSL=false only for a local dev cluster.
 *
 * NOT yet run against a real cluster.
 */

import mysql, { type Pool, type RowDataPacket } from "mysql2/promise";
import { envOr, requireConfigured } from "../config";
import type { AuditEvent, CaseId, HomeownerCase } from "../../types/domain";
import type { CaseCollections, CaseRepository, CollectionItem, CollectionName } from "./repository";
import { COLUMNS, TABLES, type Columns } from "./tables";

export function createSingleStorePool(env = process.env): Pool {
  requireConfigured("singlestore", env);
  return mysql.createPool({
    host: env.SINGLESTORE_HOST,
    port: Number(envOr("singlestore", "SINGLESTORE_PORT", env)),
    user: env.SINGLESTORE_USER,
    password: env.SINGLESTORE_PASSWORD,
    database: envOr("singlestore", "SINGLESTORE_DATABASE", env),
    ssl: env.SINGLESTORE_SSL === "false" ? undefined : { minVersion: "TLSv1.2", rejectUnauthorized: true },
    connectionLimit: 5,
  });
}

function upsertSql(table: string, cols: Columns): { sql: string; values: (string | number | boolean | null)[] } {
  const names = Object.keys(cols);
  const all = ["id", "case_id", ...names, "body"];
  const updates = [...names, "body"].map((n) => `${n} = VALUES(${n})`).join(", ");
  return {
    sql: `INSERT INTO ${table} (${all.join(", ")}) VALUES (${all.map(() => "?").join(", ")}) ON DUPLICATE KEY UPDATE ${updates}`,
    values: Object.values(cols) as (string | number | boolean | null)[],
  };
}

function parseBody<T>(row: RowDataPacket): T {
  const b = row.body;
  return (typeof b === "string" ? JSON.parse(b) : b) as T;
}

export class SingleStoreCaseRepository implements CaseRepository {
  readonly kind = "singlestore" as const;
  constructor(private readonly pool: Pool) {}

  private async put(table: string, id: string, caseId: string, cols: Columns, body: unknown) {
    const { sql, values } = upsertSql(table, cols);
    await this.pool.execute(sql, [id, caseId, ...values, JSON.stringify(body)] as (string | number | boolean | null)[]);
  }

  async createCase(c: HomeownerCase) {
    if (await this.getCase(c.id)) throw new Error(`Case ${c.id} already exists`);
    await this.put(TABLES.cases, c.id, c.id, COLUMNS.cases(c), c);
  }

  async getCase(id: CaseId) {
    const [rows] = await this.pool.execute<RowDataPacket[]>(`SELECT body FROM ${TABLES.cases} WHERE id = ?`, [id]);
    return rows[0] ? parseBody<HomeownerCase>(rows[0]) : null;
  }

  async updateCase(id: CaseId, patch: Partial<Omit<HomeownerCase, "id">>) {
    const c = await this.getCase(id);
    if (!c) throw new Error(`Case ${id} not found`);
    const next = { ...c, ...patch, id, updatedAt: new Date().toISOString() };
    await this.put(TABLES.cases, id, id, COLUMNS.cases(next), next);
    return next;
  }

  async upsert<K extends CollectionName>(collection: K, item: CollectionItem<K>) {
    const cols = (COLUMNS[collection] as (x: CollectionItem<K>) => Columns)(item);
    await this.put(TABLES[collection], item.id, item.caseId, cols, item);
  }

  async list<K extends CollectionName>(collection: K, caseId: CaseId) {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT body FROM ${TABLES[collection]} WHERE case_id = ?`,
      [caseId],
    );
    return rows.map((r) => parseBody<CollectionItem<K>>(r)) as CaseCollections[K];
  }

  async appendAudit(e: AuditEvent) {
    const cols = COLUMNS.audit(e);
    const names = ["id", "case_id", ...Object.keys(cols), "body"];
    await this.pool.execute(
      `INSERT INTO ${TABLES.audit} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`,
      [e.id, e.caseId, ...Object.values(cols), JSON.stringify(e)],
    );
  }

  async listAudit(caseId: CaseId) {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT body FROM ${TABLES.audit} WHERE case_id = ? ORDER BY at, id`,
      [caseId],
    );
    return rows.map((r) => parseBody<AuditEvent>(r));
  }
}
