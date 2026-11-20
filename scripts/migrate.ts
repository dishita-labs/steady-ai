/**
 * Apply src/lib/recorder/schema.sql to SingleStore. Idempotent (CREATE TABLE IF NOT EXISTS).
 *
 *   aube run db:migrate
 *
 * Standalone on purpose (Node strips the types; no bundler), so it reads env directly.
 * Loading JSONL records from .data/records into SingleStore is not built yet.
 */

import { readFile } from "node:fs/promises";
import mysql from "mysql2/promise";

const env = process.env;
const missing = ["SINGLESTORE_HOST", "SINGLESTORE_USER", "SINGLESTORE_PASSWORD"].filter((k) => !env[k]);
if (missing.length) {
  console.error(`Missing env: ${missing.join(", ")}`);
  process.exit(1);
}

const database = env.SINGLESTORE_DATABASE || "steady";
const conn = await mysql.createConnection({
  host: env.SINGLESTORE_HOST,
  port: Number(env.SINGLESTORE_PORT || 3306),
  user: env.SINGLESTORE_USER,
  password: env.SINGLESTORE_PASSWORD,
  ssl: env.SINGLESTORE_SSL === "false" ? undefined : { minVersion: "TLSv1.2", rejectUnauthorized: true },
});

try {
  await conn.query(`CREATE DATABASE IF NOT EXISTS \`${database.replace(/`/g, "")}\``);
  await conn.query(`USE \`${database.replace(/`/g, "")}\``);
  const sql = await readFile(new URL("../src/lib/recorder/schema.sql", import.meta.url), "utf8");
  const statements = sql
    .split(/;\s*$/m)
    .map((s) => s.replace(/^\s*--.*$/gm, "").trim())
    .filter(Boolean);
  for (const s of statements) {
    await conn.query(s);
    console.log(`ok: ${s.split("\n")[0]}`);
  }
} finally {
  await conn.end();
}
