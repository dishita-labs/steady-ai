import { createHash } from "node:crypto";

/** Prefixed, sortable-enough random IDs, e.g. "case_m3k9x2_4f1a9c0b". Use only where retries can't repeat the call. */
export function newId(prefix: string): string {
  const rand = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  return `${prefix}_${Date.now().toString(36)}_${rand}`;
}

/**
 * Deterministic ID from its parts. Workflow steps can be retried, so anything a step writes
 * gets an ID derived from what it is (e.g. requirement + URL), so a retry upserts the same row
 * instead of adding a duplicate.
 */
export function stableId(prefix: string, ...parts: (string | number)[]): string {
  const h = createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 20);
  return `${prefix}_${h}`;
}
