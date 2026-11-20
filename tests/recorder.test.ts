import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FatalError } from "workflow";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IntegrationUnavailableError } from "../src/lib/config";
import { selectRecorder } from "../src/lib/recorder";
import { JsonlCaseRepository } from "../src/lib/recorder/jsonl";
import { MemoryCaseRepository } from "../src/lib/recorder/repository";
import {
  SingleStoreCaseRepository,
  SingleStoreRecorderError,
  q,
  singleStorePoolOptions,
  upsertSql,
  type SqlPool,
} from "../src/lib/recorder/singlestore";
import { fixtureAudit, fixtureCase, recorderContract } from "./recorder/contract";

describe("recorder contract: memory", () => {
  const repo = new MemoryCaseRepository();
  recorderContract(() => ({ repo, caseId: "mem_case", otherCaseId: "mem_other" }));
});

describe("recorder contract: JSONL", () => {
  let dir = "";
  let repo: JsonlCaseRepository;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "steady-recorder-"));
    repo = new JsonlCaseRepository(dir);
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));
  recorderContract(() => ({ repo, caseId: "jsonl_case", otherCaseId: "jsonl_other" }));
});

describe("recorder selection never falls back silently", () => {
  const full = { SINGLESTORE_HOST: "h", SINGLESTORE_USER: "u", SINGLESTORE_PASSWORD: "p" };
  it("rejects an unknown STEADY_RECORDER", () => {
    expect(() => selectRecorder({ ...full, STEADY_RECORDER: "singlstore" })).toThrow(IntegrationUnavailableError);
  });
  it("rejects a partial SingleStore config instead of using JSONL", () => {
    expect(() => selectRecorder({ SINGLESTORE_HOST: "h" })).toThrow(/missing SINGLESTORE_USER, SINGLESTORE_PASSWORD/);
    expect(selectRecorder({ SINGLESTORE_HOST: "h", STEADY_RECORDER: "jsonl" })).toBe("jsonl");
  });
  it("forced singlestore without config fails at pool creation, fatally", () => {
    expect(selectRecorder({ STEADY_RECORDER: "singlestore" })).toBe("singlestore");
    let err: unknown;
    try {
      singleStorePoolOptions({ STEADY_RECORDER: "singlestore" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(IntegrationUnavailableError);
    expect(FatalError.is(err)).toBe(true);
  });
});

describe("SingleStore adapter (fake pool, no network)", () => {
  type Call = { sql: string; params: unknown[] };
  function fakePool(fail?: (sql: string) => unknown): { pool: SqlPool; calls: Call[] } {
    const calls: Call[] = [];
    const pool = {
      execute: async (sql: string, params: unknown[]) => {
        calls.push({ sql, params });
        const err = fail?.(sql);
        if (err) throw err;
        return [[], []];
      },
      end: async () => {},
    } as unknown as SqlPool;
    return { pool, calls };
  }
  const driverError = (code: string, errno: number, message: string) => Object.assign(new Error(message), { code, errno });

  it("uses TLS by default and only drops it when SINGLESTORE_SSL=false", () => {
    const env = { SINGLESTORE_HOST: "h", SINGLESTORE_USER: "u", SINGLESTORE_PASSWORD: "p" };
    expect(singleStorePoolOptions(env)).toMatchObject({ ssl: { rejectUnauthorized: true, minVersion: "TLSv1.2" }, port: 3306, database: "steady", connectionLimit: 5 });
    expect(singleStorePoolOptions({ ...env, SINGLESTORE_SSL: "false" }).ssl).toBeUndefined();
  });

  it("quotes identifiers and parameterizes every value", () => {
    const { sql, values } = upsertSql("audit_events", { at: "2026-11-20 00:00:00", type: "x", stage: "CASE_CREATED" });
    expect(sql).toBe(
      "INSERT INTO `audit_events` (`id`, `case_id`, `at`, `type`, `stage`, `body`) VALUES (?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE `at` = VALUES(`at`), `type` = VALUES(`type`), `stage` = VALUES(`stage`), `body` = VALUES(`body`)",
    );
    expect(values).toEqual(["2026-11-20 00:00:00", "x", "CASE_CREATED"]);
    expect(() => q("cases; DROP TABLE cases")).toThrow();
  });

  it("routes reads through the shard key and orders lists", async () => {
    const { pool, calls } = fakePool();
    const repo = new SingleStoreCaseRepository(pool);
    await repo.getCase("c1");
    await repo.list("hazards", "c1");
    await repo.listAudit("c1");
    expect(calls[0]).toEqual({ sql: "SELECT `body` FROM `cases` WHERE `case_id` = ? AND `id` = ?", params: ["c1", "c1"] });
    expect(calls[1].sql).toMatch(/WHERE `case_id` = \? ORDER BY `id`$/);
    expect(calls[2].sql).toMatch(/ORDER BY `at`, `id`$/);
  });

  it("treats a duplicate audit append as already recorded, and a duplicate case as an error", async () => {
    const { pool } = fakePool(() => driverError("ER_DUP_ENTRY", 1062, "Duplicate entry"));
    const repo = new SingleStoreCaseRepository(pool);
    await expect(repo.appendAudit(fixtureAudit("c1")[0])).resolves.toBeUndefined();
    await expect(repo.createCase(fixtureCase("c1"))).rejects.toThrow("Case c1 already exists");
  });

  it("marks config/schema errors fatal and connection blips retryable, without leaking values", async () => {
    const denied = new SingleStoreCaseRepository(fakePool(() => driverError("ER_ACCESS_DENIED_ERROR", 1045, "Access denied for user 'u'")).pool);
    const err = await denied.upsert("hazards", { id: "h", caseId: "c" } as never).catch((e) => e);
    expect(err).toBeInstanceOf(SingleStoreRecorderError);
    expect(FatalError.is(err)).toBe(true);
    expect(err.message).toMatch(/^SingleStore upsert on hazard_findings failed \(ER_ACCESS_DENIED_ERROR 1045\)/);

    const noTable = new SingleStoreCaseRepository(fakePool(() => driverError("ER_NO_SUCH_TABLE", 1146, "Table 'steady.cases' doesn't exist")).pool);
    expect(FatalError.is(await noTable.getCase("c").catch((e) => e))).toBe(true);

    const blip = new SingleStoreCaseRepository(fakePool(() => driverError("ECONNRESET", -54, "read ECONNRESET")).pool);
    const transient = await blip.appendAudit(fixtureAudit("c1")[0]).catch((e) => e);
    expect(transient).toBeInstanceOf(SingleStoreRecorderError);
    expect(FatalError.is(transient)).toBe(false);
    expect(transient.message).not.toContain("Case created.");
  });
});
