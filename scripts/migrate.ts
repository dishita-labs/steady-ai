/**
 * Apply src/lib/recorder/schema.sql to SingleStore. Idempotent (CREATE TABLE IF NOT EXISTS).
 *
 *   aube run db:migrate
 *
 * Standalone on purpose (Node strips the types; no bundler), so it reads env directly.
 * Env comes from the shell, or from `.env` in the working directory when present.
 * Prints table names only; never credentials.
 * Loading JSONL records from .data/records into SingleStore is not built yet.
 */

import { existsSync, readFileSync } from "node:fs";
import mysql from "mysql2/promise";

if (existsSync(".env")) process.loadEnvFile(".env");

const env = process.env;
const missing = ["SINGLESTORE_HOST", "SINGLESTORE_USER", "SINGLESTORE_PASSWORD"].filter((k) => !env[k]);
if (missing.length) {
  console.error(`Missing env: ${missing.join(", ")}`);
  process.exit(1);
}

const database = env.SINGLESTORE_DATABASE || "steady";
if (!/^[A-Za-z0-9_]+$/.test(database)) {
  console.error(`SINGLESTORE_DATABASE must be letters, digits or underscores.`);
  process.exit(1);
}

/** Split schema.sql into statements; drop comment lines. */
function schemaStatements(sql: string): string[] {
  return sql
    .split(/;\s*$/m)
    .map((s) => s.replace(/^\s*--.*$/gm, "").trim())
    .filter(Boolean);
}

const conn = await mysql.createConnection({
  host: env.SINGLESTORE_HOST,
  port: Number(env.SINGLESTORE_PORT || 3306),
  user: env.SINGLESTORE_USER,
  password: env.SINGLESTORE_PASSWORD,
  ssl: env.SINGLESTORE_SSL === "false" ? undefined : { minVersion: "TLSv1.2", rejectUnauthorized: true },
  connectTimeout: 10_000,
});

try {
  // Starter/shared workspaces come with one database and refuse CREATE DATABASE; that's fine
  // as long as the configured database already exists (USE below proves it).
  try {
    await conn.query(`CREATE DATABASE IF NOT EXISTS \`${database}\``);
  } catch (e) {
    console.warn(`note: CREATE DATABASE skipped (${(e as { code?: string }).code ?? "error"}); using existing \`${database}\``);
  }
  await conn.query(`USE \`${database}\``);
  const sql = readFileSync(new URL("../src/lib/recorder/schema.sql", import.meta.url), "utf8");
  for (const s of schemaStatements(sql)) {
    await conn.query(s);
    console.log(`ok: ${s.split("\n")[0]}`);
  }
} finally {
  await conn.end();
}
