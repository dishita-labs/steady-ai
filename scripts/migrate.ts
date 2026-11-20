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

const options = {
  host: env.SINGLESTORE_HOST,
  port: Number(env.SINGLESTORE_PORT || 3333),
  user: env.SINGLESTORE_USER,
  password: env.SINGLESTORE_PASSWORD,
  ssl: env.SINGLESTORE_SSL === "false" ? undefined : { minVersion: "TLSv1.2", rejectUnauthorized: true },
  connectTimeout: 10_000,
};

// Starter/shared workspaces come with one database, require it at connect time, and refuse
// CREATE DATABASE. So connect to the configured database first, and create it only when the
// server says it doesn't exist (a dedicated cluster).
async function connect() {
  try {
    return await mysql.createConnection({ ...options, database });
  } catch (e) {
    if ((e as { code?: string }).code !== "ER_BAD_DB_ERROR") throw e;
    const admin = await mysql.createConnection(options);
    try {
      await admin.query(`CREATE DATABASE IF NOT EXISTS \`${database}\``);
      console.log(`note: created database ${database}`);
    } finally {
      await admin.end();
    }
    return mysql.createConnection({ ...options, database });
  }
}

const conn = await connect();

try {
  const sql = readFileSync(new URL("../src/lib/recorder/schema.sql", import.meta.url), "utf8");
  for (const s of schemaStatements(sql)) {
    await conn.query(s);
    console.log(`ok: ${s.split("\n")[0]}`);
  }
} finally {
  await conn.end();
}
