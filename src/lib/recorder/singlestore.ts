/**
 * SingleStore recorder over the MySQL wire protocol (`mysql2/promise`).
 *
 * SingleStore's docs recommend `singlestore-nodejs`, but aube's supply-chain check refused it
 * (low download count), and SingleStore speaks the MySQL protocol, so we use `mysql2`.
 * Shared/cloud clusters require TLS; set SINGLESTORE_SSL=false only for a local dev cluster.
 *
 * Guarantees (checked by tests/recorder.test.ts and, against a real cluster, by
 * tests/singlestore.smoke.test.ts):
 *   - every statement is parameterized; identifiers come only from TABLES/COLUMNS and are quoted;
 *   - `upsert` is idempotent by `id` (retried steps rewrite the same row);
 *   - `appendAudit` is idempotent by `id` and never updates an existing event;
 *   - errors are never swallowed and never fall back to another backend. Errors a retry can't fix
 *     (bad credentials, missing database/table, schema mismatch) are `fatal`, which the
 *     Workflow SDK treats as a FatalError; connection blips stay retryable.
 *   - error messages carry the operation, table and driver code, never credentials or row values.
 */

import mysql, { type Pool, type PoolOptions, type RowDataPacket } from "mysql2/promise";
import { envOr, requireConfigured } from "../config";
import type { AuditEvent, CaseId, HomeownerCase } from "../../types/domain";
import type { CaseCollections, CaseRepository, CollectionItem, CollectionName } from "./repository";
import { COLUMNS, TABLES, type Columns } from "./tables";

type Env = Record<string, string | undefined>;
type SqlValue = string | number | boolean | null;

/** Pool options from env. Exported so tests can check TLS and limits without connecting. */
export function singleStorePoolOptions(env: Env = process.env): PoolOptions {
  requireConfigured("singlestore", env);
  return {
    host: env.SINGLESTORE_HOST,
    port: Number(envOr("singlestore", "SINGLESTORE_PORT", env)),
    user: env.SINGLESTORE_USER,
    password: env.SINGLESTORE_PASSWORD,
    database: envOr("singlestore", "SINGLESTORE_DATABASE", env),
    ssl: env.SINGLESTORE_SSL === "false" ? undefined : { minVersion: "TLSv1.2", rejectUnauthorized: true },
    connectionLimit: 5,
    waitForConnections: true,
    connectTimeout: 10_000,
    enableKeepAlive: true,
  };
}

export function createSingleStorePool(env: Env = process.env): Pool {
  return mysql.createPool(singleStorePoolOptions(env));
}

/** Backtick-quote an identifier. Identifiers only ever come from TABLES/COLUMNS, never from input. */
export function q(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(identifier)) throw new Error(`Unsafe SQL identifier: ${identifier}`);
  return `\`${identifier}\``;
}

export function upsertSql(table: string, cols: Columns): { sql: string; values: SqlValue[] } {
  const names = Object.keys(cols);
  const all = ["id", "case_id", ...names, "body"];
  const updates = [...names, "body"].map((n) => `${q(n)} = VALUES(${q(n)})`).join(", ");
  return {
    sql: `INSERT INTO ${q(table)} (${all.map(q).join(", ")}) VALUES (${all.map(() => "?").join(", ")}) ON DUPLICATE KEY UPDATE ${updates}`,
    values: Object.values(cols),
  };
}

export function insertSql(table: string, cols: Columns): { sql: string; values: SqlValue[] } {
  const all = ["id", "case_id", ...Object.keys(cols), "body"];
  return {
    sql: `INSERT INTO ${q(table)} (${all.map(q).join(", ")}) VALUES (${all.map(() => "?").join(", ")})`,
    values: Object.values(cols),
  };
}

function parseBody<T>(row: RowDataPacket): T {
  const b = row.body;
  return (typeof b === "string" ? JSON.parse(b) : b) as T;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Driver codes where retrying the same statement cannot succeed. */
const NON_RETRYABLE = new Set([
  "ER_ACCESS_DENIED_ERROR", // 1045 bad user/password
  "ER_DBACCESS_DENIED_ERROR", // 1044 no access to database
  "ER_TABLEACCESS_DENIED_ERROR",
  "ER_BAD_DB_ERROR", // 1049 unknown database
  "ER_NO_SUCH_TABLE", // 1146 migration not applied
  "ER_BAD_FIELD_ERROR", // 1054 schema out of date
  "ER_PARSE_ERROR",
  "ER_DATA_TOO_LONG",
  "ER_TRUNCATED_WRONG_VALUE",
  "ER_BAD_NULL_ERROR",
  "ER_INVALID_JSON_TEXT",
  "ENOTFOUND", // host does not resolve
  "HANDSHAKE_SSL_ERROR",
  "HANDSHAKE_NO_SSL_SUPPORT",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

/**
 * A SingleStore operation failed. `fatal` marks errors a retry won't fix, so the Workflow SDK
 * stops the step instead of retrying (see FatalError.is in @workflow/errors).
 */
export class SingleStoreRecorderError extends Error {
  readonly fatal: boolean;
  readonly code?: string;
  readonly errno?: number;
  constructor(
    readonly operation: string,
    readonly table: string,
    cause: unknown,
  ) {
    const e = cause as { code?: string; errno?: number; message?: string } | undefined;
    const code = e?.code;
    super(`SingleStore ${operation} on ${table} failed${code ? ` (${code}${e?.errno ? ` ${e.errno}` : ""})` : ""}: ${e?.message ?? String(cause)}`, {
      cause,
    });
    this.name = "SingleStoreRecorderError";
    this.code = code;
    this.errno = e?.errno;
    this.fatal = code !== undefined && NON_RETRYABLE.has(code);
  }
}

function isDuplicateKey(e: unknown): boolean {
  const err = e as { code?: string; errno?: number };
  return err?.code === "ER_DUP_ENTRY" || err?.errno === 1062;
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

/** The subset of mysql2's Pool the repository uses, so tests can pass a fake. */
export type SqlPool = Pick<Pool, "execute" | "end">;

export class SingleStoreCaseRepository implements CaseRepository {
  readonly kind = "singlestore" as const;
  constructor(private readonly pool: SqlPool) {}

  private async run<T>(operation: string, table: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      throw e instanceof SingleStoreRecorderError ? e : new SingleStoreRecorderError(operation, table, e);
    }
  }

  private async select(operation: string, table: string, sql: string, params: SqlValue[]): Promise<RowDataPacket[]> {
    return this.run(operation, table, async () => (await this.pool.execute<RowDataPacket[]>(sql, params))[0]);
  }

  private async put(table: string, id: string, caseId: string, cols: Columns, body: unknown) {
    const { sql, values } = upsertSql(table, cols);
    await this.run("upsert", table, () => this.pool.execute(sql, [id, caseId, ...values, JSON.stringify(body)]));
  }

  async createCase(c: HomeownerCase) {
    const { sql, values } = insertSql(TABLES.cases, COLUMNS.cases(c));
    try {
      await this.pool.execute(sql, [c.id, c.id, ...values, JSON.stringify(c)]);
    } catch (e) {
      if (isDuplicateKey(e)) throw new Error(`Case ${c.id} already exists`, { cause: e });
      throw new SingleStoreRecorderError("createCase", TABLES.cases, e);
    }
  }

  async getCase(id: CaseId) {
    const rows = await this.select("getCase", TABLES.cases, `SELECT ${q("body")} FROM ${q(TABLES.cases)} WHERE ${q("case_id")} = ? AND ${q("id")} = ?`, [id, id]);
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
    const table = TABLES[collection];
    const rows = await this.select("list", table, `SELECT ${q("body")} FROM ${q(table)} WHERE ${q("case_id")} = ? ORDER BY ${q("id")}`, [caseId]);
    return rows.map((r) => parseBody<CollectionItem<K>>(r)) as CaseCollections[K];
  }

  /** Append-only and idempotent by id: re-appending the same event (a retried step) is a no-op. */
  async appendAudit(e: AuditEvent) {
    const { sql, values } = insertSql(TABLES.audit, COLUMNS.audit(e));
    try {
      await this.pool.execute(sql, [e.id, e.caseId, ...values, JSON.stringify(e)]);
    } catch (err) {
      if (isDuplicateKey(err)) return;
      throw new SingleStoreRecorderError("appendAudit", TABLES.audit, err);
    }
  }

  async listAudit(caseId: CaseId) {
    const rows = await this.select(
      "listAudit",
      TABLES.audit,
      `SELECT ${q("body")} FROM ${q(TABLES.audit)} WHERE ${q("case_id")} = ? ORDER BY ${q("at")}, ${q("id")}`,
      [caseId],
    );
    return rows.map((r) => parseBody<AuditEvent>(r));
  }

  /** Close the pool (scripts and tests; the server keeps one pool for its lifetime). */
  async close() {
    await this.pool.end();
  }
}
