import type { AuditEvent } from "@/types/domain";
import { newId } from "@/lib/ids";

/** Keys that must never be written to the audit log. */
const FORBIDDEN_KEYS = /(api[_-]?key|secret|password|access[_-]?token|bearer|authorization|reasoning|chain[_-]?of[_-]?thought)/i;

function assertClean(value: unknown, path = "data"): void {
  if (value === null || typeof value !== "object") return;
  for (const [k, v] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.test(k)) throw new Error(`Audit event field "${path}.${k}" is not allowed.`);
    assertClean(v, `${path}.${k}`);
  }
}

export type NewAuditEvent = Omit<AuditEvent, "id" | "at"> & { at?: string };

/** Build a structured audit event. Rejects secrets and hidden-reasoning fields. */
export function createAuditEvent(input: NewAuditEvent): AuditEvent {
  assertClean(input.data);
  return { id: newId("evt"), at: input.at ?? new Date().toISOString(), ...input };
}
