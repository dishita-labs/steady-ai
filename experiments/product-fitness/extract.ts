/**
 * Deterministic number parsing for numeric checklist items. GLiNER only points at the passages
 * that state a value; this reads the value. Conservative on purpose: a number counts only when a
 * context word is nearby, and implausible values are dropped. Nothing parsed → "unknown", never
 * "pass".
 */

import type { Quantity } from "./checklist";

export interface Parsed {
  value: number;
  /** The text the value came from, for the report. */
  match: string;
}

/** "1-1/4", "1 1/4", "1¼", "1.25" → 1.25 */
export function parseInches(s: string): number | undefined {
  const t = s.trim().replace(/¼/g, " 1/4").replace(/½/g, " 1/2").replace(/¾/g, " 3/4").replace(/\s+/g, " ");
  const mixed = t.match(/^(\d+)(?:[- ]+)(\d+)\/(\d+)$/);
  if (mixed) return Number(mixed[1]) + Number(mixed[2]) / Number(mixed[3]);
  const frac = t.match(/^(\d+)\/(\d+)$/);
  if (frac) return Number(frac[1]) / Number(frac[2]);
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

const NUM_IN = String.raw`(\d+(?:\.\d+)?(?:[- ]+\d+\/\d+)?\s*[¼½¾]?|\d+\/\d+)`;
const INCH = String.raw`\s*(?:"|”|''|in\.?\b|inch(?:es)?\b)`;
const WINDOW = 60;

/**
 * Every match of `re` whose surrounding text (± WINDOW chars) contains a context word, and whose
 * line doesn't name a different part (`exclude`).
 */
function near(text: string, re: RegExp, context: RegExp, exclude?: RegExp): RegExpExecArray[] {
  const out: RegExpExecArray[] = [];
  for (const m of text.matchAll(re)) {
    const around = text.slice(Math.max(0, m.index! - WINDOW), m.index! + m[0].length + WINDOW);
    const lineStart = text.lastIndexOf("\n", m.index!) + 1;
    const before = text.slice(Math.max(lineStart, m.index! - WINDOW), m.index!);
    if (context.test(around) && !(exclude && exclude.test(before))) out.push(m as RegExpExecArray);
  }
  return out;
}

/**
 * Another part's dimension on the same line before the number. Seen on Home Depot spec tables
 * (2026-11-20): "Escutcheon Diameter (in.): 1.25" is the flange cover, not the bar.
 */
const OTHER_PART: Partial<Record<Quantity, RegExp>> = {
  diameter_in: /escutcheon|flange|cover|base|mounting plate|post/i,
  length_in: /escutcheon|flange|package|box|carton/i,
};

const CONTEXT: Record<Quantity, RegExp> = {
  weight_lb: /capacity|support|load|holds?|rated|withstand|bear|strength|up to/i,
  diameter_in: /diameter|dia\b|tube|Ø|thick/i,
  length_in: /length|long|\bsize\b|\d+\s*(?:"|in)\s*(?:grab )?bar/i,
  clearance_in: /clearance|from (?:the )?wall|wall space|projection|knuckle/i,
};

const PLAUSIBLE: Record<Quantity, [number, number]> = {
  weight_lb: [50, 2000], // drops shipping weights like "2.5 lbs"
  diameter_in: [0.75, 2.5],
  length_in: [6, 72],
  clearance_in: [0.75, 4],
};

/**
 * Spec rows that carry the unit in the name, as shop spec tables do: "Bar Diameter (in.): 1.25",
 * "Weight Capacity (lb.): 500". The name must match the quantity's context and not name another
 * part.
 */
function specRows(text: string, q: Quantity): Parsed[] {
  const unit = q === "weight_lb" ? /\((?:lb|lbs|pounds)\.?\)/i : /\((?:in|inch|inches)\.?\)/i;
  const out: Parsed[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^(.{1,80}?):\s*([\d][\d .,/-]*)\s*(?:in\.?|inches|lb\.?|lbs\.?)?\s*$/i);
    if (!m || !unit.test(m[1]) || !CONTEXT[q].test(m[1]) || OTHER_PART[q]?.test(m[1])) continue;
    const v = q === "weight_lb" ? Number(m[2].replace(/,/g, "")) : parseInches(m[2]);
    if (v !== undefined && Number.isFinite(v)) out.push({ value: v, match: line.trim() });
  }
  return out;
}

export function parseQuantity(text: string, q: Quantity): Parsed[] {
  const found: Parsed[] = specRows(text, q);
  if (q === "weight_lb") {
    for (const m of near(text, /(\d{1,4}(?:,\d{3})?(?:\.\d+)?)\s*(?:-\s*)?(lbs?\b|pounds?\b|kg\b|kilograms?\b)/gi, CONTEXT[q])) {
      const n = Number(m[1].replace(/,/g, ""));
      found.push({ value: /^k/i.test(m[2]) ? Math.round(n * 2.20462) : n, match: m[0] });
    }
  } else {
    for (const m of near(text, new RegExp(NUM_IN + INCH, "gi"), CONTEXT[q], OTHER_PART[q])) {
      const v = parseInches(m[1]);
      if (v !== undefined) found.push({ value: v, match: m[0] });
    }
    for (const m of near(text, /(\d{2,3}(?:\.\d+)?)\s*mm\b/gi, CONTEXT[q], OTHER_PART[q])) found.push({ value: Math.round((Number(m[1]) / 25.4) * 100) / 100, match: m[0] });
  }
  const [lo, hi] = PLAUSIBLE[q];
  return found.filter((p) => p.value >= lo && p.value <= hi);
}

export type NumericOutcome = { status: "pass" | "fail"; value: number; match: string } | { status: "unknown" };

/**
 * Compare parsed values with the threshold. Several values (e.g. a 24/36/42 in range, or "250 lb"
 * and "500 lb") → the item passes if ANY stated variant passes, because the shopper can pick it.
 */
export function checkNumeric(texts: string[], spec: { quantity: Quantity; min?: number; max?: number }): NumericOutcome {
  const values = texts.flatMap((t) => parseQuantity(t, spec.quantity));
  if (!values.length) return { status: "unknown" };
  const ok = (v: number) => (spec.min === undefined || v >= spec.min - 1e-9) && (spec.max === undefined || v <= spec.max + 1e-9);
  const pass = values.find((p) => ok(p.value));
  if (pass) return { status: "pass", value: pass.value, match: pass.match };
  return { status: "fail", value: values[0].value, match: values[0].match };
}
