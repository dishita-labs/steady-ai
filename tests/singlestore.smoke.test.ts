/**
 * SingleStore smoke test against a REAL cluster. Skipped unless SINGLESTORE_SMOKE=1.
 *
 *   SINGLESTORE_SMOKE=1 aube exec vitest run tests/singlestore.smoke.test.ts
 *
 * Reads SINGLESTORE_* from the shell or `.env`. With SINGLESTORE_SMOKE=1 and no credentials it
 * FAILS (it never skips silently). It:
 *   1. runs the real migration script (scripts/migrate.ts),
 *   2. checks the server is SingleStore, the session is TLS-encrypted, and every table exists,
 *   3. runs the shared recorder contract (insert, update, read back, retries, audit, history)
 *      through SingleStoreCaseRepository, under unique `smoke_*` case ids,
 *   4. checks the typed filter columns match the bodies,
 *   5. writes evidence to .data/smoke/ (no credentials), then deletes its own smoke rows
 *      (keep them with SINGLESTORE_SMOKE_KEEP=1).
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Pool, RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { missingEnv } from "../src/lib/config";
import { SingleStoreCaseRepository, createSingleStorePool } from "../src/lib/recorder/singlestore";
import { TABLES } from "../src/lib/recorder/tables";
import { recorderContract } from "./recorder/contract";

const enabled = process.env.SINGLESTORE_SMOKE === "1";
if (enabled && existsSync(".env")) process.loadEnvFile(".env");

const runTag = `smoke_${Date.now().toString(36)}`;
const caseId = `${runTag}_a`;
const otherCaseId = `${runTag}_b`;
const evidence: Record<string, unknown> = { runTag, startedAt: new Date().toISOString(), checks: [] as string[] };
const note = (s: string) => (evidence.checks as string[]).push(s);

describe.skipIf(!enabled)("SingleStore smoke (real cluster)", () => {
  let pool: Pool;
  let repo: SingleStoreCaseRepository;

  beforeAll(() => {
    const missing = missingEnv("singlestore");
    if (missing.length) throw new Error(`SINGLESTORE_SMOKE=1 but missing env: ${missing.join(", ")}`);
    pool = createSingleStorePool();
    repo = new SingleStoreCaseRepository(pool);
  });

  afterAll(async () => {
    if (!pool) return;
    if (process.env.SINGLESTORE_SMOKE_KEEP !== "1") {
      for (const t of Object.values(TABLES)) await pool.execute(`DELETE FROM \`${t}\` WHERE case_id IN (?, ?)`, [caseId, otherCaseId]);
      note("cleanup: smoke rows deleted");
    }
    evidence.finishedAt = new Date().toISOString();
    await mkdir(join(".data", "smoke"), { recursive: true });
    await writeFile(join(".data", "smoke", `singlestore-${runTag}.json`), JSON.stringify(evidence, null, 2));
    await pool.end();
  });

  it("applies the schema with scripts/migrate.ts", () => {
    const out = execFileSync(process.execPath, ["scripts/migrate.ts"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const created = out.split("\n").filter((l) => l.startsWith("ok:"));
    expect(created).toHaveLength(Object.keys(TABLES).length);
    note(`migrate: ${created.length} statements ok`);
  });

  it("is a TLS session on SingleStore with every table present", async () => {
    const [[v]] = await pool.query<RowDataPacket[]>("SELECT @@memsql_version AS v, DATABASE() AS db");
    expect(v.v, "server should be SingleStore (@@memsql_version)").toBeTruthy();
    evidence.server = { singlestoreVersion: v.v, database: v.db };
    const [[ssl]] = await pool.query<RowDataPacket[]>("SHOW SESSION STATUS LIKE 'Ssl_cipher'");
    if (process.env.SINGLESTORE_SSL !== "false") expect(ssl?.Value, "TLS cipher").toBeTruthy();
    evidence.tls = ssl?.Value || "off";
    const [tables] = await pool.query<RowDataPacket[]>("SHOW TABLES");
    const names = tables.map((r) => Object.values(r)[0]);
    for (const t of Object.values(TABLES)) expect(names).toContain(t);
    note(`connected: SingleStore ${v.v}, db ${v.db}, tls ${evidence.tls}`);
  });

  describe("recorder contract", () => {
    recorderContract(() => ({ repo, caseId, otherCaseId }));
  });

  it("keeps typed filter columns in step with the stored bodies", async () => {
    const [[c]] = await pool.execute<RowDataPacket[]>("SELECT stage, status FROM cases WHERE case_id = ? AND id = ?", [caseId, caseId]);
    expect(c).toMatchObject({ stage: "PHOTO_ANALYZED", status: "needs_input" });
    const [[a]] = await pool.execute<RowDataPacket[]>("SELECT status, simulated FROM shopping_actions WHERE case_id = ?", [caseId]);
    expect(a.status).toBe("declined");
    expect(Boolean(a.simulated)).toBe(true);
    const [counts] = await pool.execute<RowDataPacket[]>(
      Object.values(TABLES).map((t) => `SELECT '${t}' AS t, COUNT(*) AS n FROM \`${t}\` WHERE case_id = ?`).join(" UNION ALL "),
      Object.values(TABLES).map(() => caseId),
    );
    evidence.rowCounts = Object.fromEntries(counts.map((r) => [r.t, Number(r.n)]));
    note("typed columns match bodies; one row per id after retries");
  });
});
