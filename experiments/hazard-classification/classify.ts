/**
 * Stage 2: GLiNER2.5 Decide labels Gemma's structure parts and items. ONE `noul` (yes/no)
 * question per call, always phrased POSITIVELY ("Is this a handrail?").
 *
 * Why this shape (probes, 2026-11-20, experiments/hazard-classification/probe.experiment.ts):
 *   - Grouped 4-way `choice` questions gave near-uniform probabilities (~0.3 each) and nonsense
 *     reads (a window as evidence of a clear floor).
 *   - Decide can't read negation: "There is no handrail" vs "handrails not mentioned" both → no,
 *     and "without a handrail?" was answered YES (0.95) for handrails on both sides.
 *   - Positive yes/no questions were sharp: "mentions a handrail?" 1.0 vs 0.0.
 * So GLiNER answers only "is this structure X?", "is this part X?" and "is this item Y?". A part
 * can take a stair/bath/bed role only if its structure is one (a bathtub's "right side" read as a
 * stair side on 2026-11-20 without this gate). Absence comes from Gemma's
 * explicit empty `items` lists, and validate.ts turns the reads into labels.
 *
 * GLiNER never sees the image. Every read is tied to an observation id and part index.
 * Reads are stored as raw P(yes), so thresholds can be tuned later without new calls.
 * Uses the production Decide adapter (`getProductDecider`, src/lib/product-decisions) unchanged.
 */

import { getProductDecider } from "../../src/lib/product-decisions";
import { ITEM_TYPES, PART_ROLES, type ItemType, type PartRole } from "./definitions";
import type { ObservationOutput } from "./observe";

/** Roles and item types GLiNER is asked about (`other` is what's left when none says yes). */
export const ASKED_ROLES = (Object.keys(PART_ROLES) as PartRole[]).filter((r) => r !== "other");
export const ASKED_ITEM_TYPES = (Object.keys(ITEM_TYPES) as ItemType[]).filter((t) => t !== "other" && t !== "fixture");
/** Structure gate: a part may take a stair/bath/bed role only if its structure is one. */
export const STRUCTURE_QUESTIONS = {
  stairs: "Is this a staircase or steps?",
  bath: "Is this a bathtub, shower or toilet?",
  bed: "Is this a bed?",
} as const;
export type Structure = keyof typeof STRUCTURE_QUESTIONS;
export const ROLE_NEEDS: Partial<Record<PartRole, Structure>> = {
  stair_side: "stairs",
  stair_treads: "stairs",
  bath_wall: "bath",
  bath_floor: "bath",
  bedside: "bed",
};

export const STAIR_CONDITION_QUESTION = "Does this describe a broken, missing or uneven step, or torn or lifted carpet on stairs?";

export const roleQuestion = (r: PartRole) => `Is this ${PART_ROLES[r]}?`;
export const itemQuestion = (t: ItemType) => `Is this ${ITEM_TYPES[t]}?`;
export const partText = (feature: string, part: string) => `${feature}: ${part}`;

/** P(yes), or null when the call failed. */
export type PYes = number | null;

export interface ItemRead {
  text: string;
  types: Partial<Record<ItemType, PYes>>;
}

export interface PartRead {
  observationId: string;
  partIndex: number;
  part: string;
  visibility: "full" | "partial" | "obscured";
  roles: Partial<Record<PartRole, PYes>>;
  items: ItemRead[];
}

export interface ClassifyCall {
  text: string;
  question: string;
  ok: boolean;
  pYes: PYes;
  error?: string;
}

export interface ClassifyResult {
  parts: PartRead[];
  /** Per observation that has parts: P(yes) that its description reports damaged steps. */
  stairCondition: Record<string, PYes>;
  /** Per observation that has parts: P(yes) it is each structure. */
  structures: Record<string, Partial<Record<Structure, PYes>>>;
  calls: ClassifyCall[];
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

export async function classifyObservations(obs: ObservationOutput, concurrency = 4): Promise<ClassifyResult> {
  const decider = getProductDecider();
  const ask = async (text: string, question: string): Promise<ClassifyCall> => {
    try {
      const res = await decider.decide({ text, questions: { q: { type: "noul", instructions: question } } });
      const p = res.answers[0]?.probabilities.yes;
      return { text, question, ok: typeof p === "number", pYes: typeof p === "number" ? p : null, error: typeof p === "number" ? undefined : "no probability in reply" };
    } catch (e) {
      return { text, question, ok: false, pYes: null, error: e instanceof Error ? e.message : String(e) };
    }
  };

  // One job per (text, question); identical items across parts share a call via the recorder cache.
  type Job = { text: string; question: string; set: (p: PYes) => void };
  const jobs: Job[] = [];
  const parts: PartRead[] = [];
  const stairCondition: Record<string, PYes> = {};
  const structures: Record<string, Partial<Record<Structure, PYes>>> = {};
  for (const o of obs.observations) {
    if (!o.parts.length) continue;
    const whole = `${o.feature}: ${o.description}`;
    jobs.push({ text: whole, question: STAIR_CONDITION_QUESTION, set: (p) => (stairCondition[o.id] = p) });
    const st = (structures[o.id] = {} as Partial<Record<Structure, PYes>>);
    for (const k of Object.keys(STRUCTURE_QUESTIONS) as Structure[]) jobs.push({ text: whole, question: STRUCTURE_QUESTIONS[k], set: (p) => (st[k] = p) });
    o.parts.forEach((p, partIndex) => {
      const read: PartRead = { observationId: o.id, partIndex, part: p.part, visibility: p.visibility, roles: {}, items: p.items.map((text) => ({ text, types: {} })) };
      parts.push(read);
      for (const r of ASKED_ROLES) jobs.push({ text: partText(o.feature, p.part), question: roleQuestion(r), set: (x) => (read.roles[r] = x) });
      for (const it of read.items) for (const t of ASKED_ITEM_TYPES) jobs.push({ text: it.text, question: itemQuestion(t), set: (x) => (it.types[t] = x) });
    });
  }
  const calls = await mapLimit(jobs, concurrency, async (j) => {
    const c = await ask(j.text, j.question);
    j.set(c.pYes);
    return c;
  });
  return { parts, stairCondition, structures, calls };
}
