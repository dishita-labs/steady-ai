/**
 * Stage 2: GLiNER2.5 Decide maps each Gemma observation to H01–H11, one observation at a time.
 *
 * GLiNER never sees the image, only one observation's text, so every label it gives is tied to a
 * specific observation id by construction and it cannot cite an observation that doesn't exist.
 * Each category is a 4-way `choice`, not a yes/no, so "no" never silently becomes "absent":
 *   hazard     the observation describes the hazard condition
 *   no_hazard  the observation describes the area and the condition is not there
 *   unclear    the observation is about the area but doesn't say enough
 *   unrelated  the observation is not about the area
 *
 * Reuses the production Decide adapter (`getProductDecider`, src/lib/product-decisions) unchanged.
 * Its generic `decide({ text, questions })` call is not product-specific.
 */

import { getProductDecider, type DecideQuestion } from "../../src/lib/product-decisions";
import type { HazardCategoryId, TypedAnswer } from "../../src/types/domain";
import { CATEGORY_SPECS, QUESTION_GROUPS } from "./definitions";
import type { Observation, ObservationOutput } from "./observe";

export const CHOICE_LABELS = ["hazard", "no_hazard", "unclear", "unrelated"] as const;
export type ChoiceLabel = (typeof CHOICE_LABELS)[number];

/**
 * Decide reads text and questions in one 512-token window. ~4 characters per token; this budget
 * leaves headroom. Calls over it are not sent (recorded as invalid) rather than truncated.
 */
export const CALL_CHAR_BUDGET = 1800;

export function observationText(o: Observation, roomType: string): string {
  const parts = [`Room: ${roomType}.`, `${o.feature}: ${o.description}`, `Location: ${o.location}.`, `Visibility: ${o.visibility}.`];
  if (o.limitations.length) parts.push(`Not shown: ${o.limitations.join("; ")}.`);
  return parts.join(" ");
}

export function categoryQuestion(id: HazardCategoryId): DecideQuestion {
  const s = CATEGORY_SPECS[id];
  return {
    type: "choice",
    instructions: `What does this observation say about ${s.area}?`,
    criteria: {
      hazard: s.hazard,
      no_hazard: s.clear,
      unclear: `It is about ${s.area} but does not say enough to tell.`,
      unrelated: `It is not about ${s.area}.`,
    },
  };
}

export function groupQuestions(group: HazardCategoryId[]): Record<string, DecideQuestion> {
  return Object.fromEntries(group.map((id) => [id, categoryQuestion(id)]));
}

export function callSize(text: string, questions: Record<string, DecideQuestion>): number {
  return text.length + JSON.stringify(questions).length;
}

export interface ObservationCategoryAnswer {
  observationId: string;
  category: HazardCategoryId;
  /** "invalid" when the call failed, was over budget, or returned an unknown label. */
  label: ChoiceLabel | "invalid";
  probabilities: Record<string, number>;
}

export interface ClassifyCall {
  observationId: string;
  group: HazardCategoryId[];
  chars: number;
  ok: boolean;
  error?: string;
  answers?: TypedAnswer[];
}

export interface ClassifyResult {
  answers: ObservationCategoryAnswer[];
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
  const jobs = obs.observations.flatMap((o) => QUESTION_GROUPS.map((group) => ({ o, group })));
  const calls = await mapLimit(jobs, concurrency, async ({ o, group }): Promise<ClassifyCall> => {
    const text = observationText(o, obs.roomType);
    const questions = groupQuestions(group);
    const chars = callSize(text, questions);
    if (chars > CALL_CHAR_BUDGET) return { observationId: o.id, group, chars, ok: false, error: `over budget (${chars} > ${CALL_CHAR_BUDGET} chars)` };
    try {
      const res = await decider.decide({ text, questions });
      return { observationId: o.id, group, chars, ok: true, answers: res.answers };
    } catch (e) {
      return { observationId: o.id, group, chars, ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });
  const answers = calls.flatMap((c) =>
    c.group.map((category): ObservationCategoryAnswer => {
      const a = c.answers?.find((x) => x.questionId === category);
      const label = a && (CHOICE_LABELS as readonly string[]).includes(a.answer) ? (a.answer as ChoiceLabel) : "invalid";
      return { observationId: c.observationId, category, label, probabilities: a?.probabilities ?? {} };
    }),
  );
  return { answers, calls };
}
