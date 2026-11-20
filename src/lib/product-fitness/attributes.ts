/**
 * GLiNER checklist reads + the verified seller sheet → evidence-backed product attributes.
 * Pure. Decision 15 (docs/decisions.md):
 *
 *   - An item sets its attribute only when GLiNER reads yes (max P(yes) ≥ `yes`) AND a verified
 *     seller quote backs it: a quote line matching the item's pattern, or, for a numeric item, a
 *     value the parser reads from the sheet. The attribute cites the sheet evidence row and
 *     carries the exact quote. GLiNER alone sets nothing; a keyword alone sets nothing.
 *   - A numeric attribute is set even when the value fails the threshold, so the rules engine
 *     rejects with the observed value ("Weight capacity: 150 lb" vs load_lb ≥ 250).
 *   - Red flags run last and overwrite the gate attribute they share (mount_type = "suction").
 *   - Nothing here decides eligibility. The rules engine compares attributes with constraints.
 */

import type { ProductAttribute } from "../../types/domain";
import { ATTRIBUTES, type ProductChecklist } from "./checklist";
import { checkNumeric } from "./extract";

export interface AttributeTrace {
  itemId: string;
  attribute: string;
  pYes: number | null;
  /** Set: the attribute was written. Otherwise why not. */
  result: "set" | "model_said_no" | "no_read" | "no_backing_quote" | "no_number";
  value?: ProductAttribute["value"];
  quote?: string;
}

/**
 * `sheet` is the verified seller sheet as stored in evidence (`sheetText`: one verified quote per
 * line: the name, each description sentence, each "Spec: value" row). Quotes are matched per line,
 * so a pattern can't stitch words from two quotes together.
 */
export function deriveAttributes(
  checklist: ProductChecklist,
  pYesByItem: Record<string, number | null>,
  sheet: string,
  evidenceId: string,
  yes = 0.5,
): { attributes: ProductAttribute[]; trace: AttributeTrace[] } {
  const lines = sheet.split("\n").filter((l) => l.trim());
  const text = sheet;
  const byName = new Map<string, ProductAttribute>();
  const trace: AttributeTrace[] = [];
  // Gates and preferred items first; red flags last so they overwrite the gate they share.
  const ordered = [...checklist.items.filter((i) => i.kind !== "red_flag"), ...checklist.items.filter((i) => i.kind === "red_flag")];
  for (const item of ordered) {
    const spec = ATTRIBUTES[item.id];
    const pYes = pYesByItem[item.id] ?? null;
    const base = { itemId: item.id, attribute: spec.name, pYes };
    if (pYes === null) {
      trace.push({ ...base, result: "no_read" });
      continue;
    }
    if (pYes < yes) {
      trace.push({ ...base, result: "model_said_no" });
      continue;
    }
    if (spec.value === "number") {
      const n = checkNumeric([text], item.numeric!);
      if (n.status === "unknown") {
        trace.push({ ...base, result: "no_number" });
        continue;
      }
      byName.set(spec.name, { name: spec.name, value: n.value, ...(spec.unit ? { unit: spec.unit } : {}), evidenceId, quote: n.match });
      trace.push({ ...base, result: "set", value: n.value, quote: n.match });
      continue;
    }
    const quote = lines.find((l) => spec.quote!.test(l));
    if (!quote) {
      trace.push({ ...base, result: "no_backing_quote" });
      continue;
    }
    byName.set(spec.name, { name: spec.name, value: spec.value, evidenceId, quote });
    trace.push({ ...base, result: "set", value: spec.value, quote });
  }
  return { attributes: [...byName.values()], trace };
}
