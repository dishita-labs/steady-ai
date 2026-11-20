/**
 * Typed product decisions (Superlinked SIE, GLiNER2.5 Decide).
 *
 *   client.extract("fastino/GLiNER2.5-Decide", { text }, { outputSchema: { <id>: { type, instructions, ... } } })
 *   → result.data[<id>]: the answer and probabilities per option
 *
 * Every question in one call is read alongside the text in a single forward pass, and each
 * answer depends on the other questions sent with it. Text is limited to 512 tokens, so long
 * product pages have to be split into chunks (`chunkText`, a rough first version).
 *
 * The output is ADVISORY. The rules engine decides; a classification can only add a concern.
 * How (or whether) typed answers become evidence-backed attributes is an OPEN decision; see
 * docs/decisions.md.
 */

import { envOr } from "../config";
import { getSieClient } from "../sie";
import type { ProviderRef, RequirementConstraint, TypedAnswer } from "../../types/domain";

/** One typed question in SIE's `outputSchema` format. */
export type DecideQuestion =
  | { type: "noul"; instructions: string }
  | { type: "choice"; instructions: string; options: Record<string, string> }
  | { type: "score"; instructions: string; levels: string[] };

export interface DecideRequest {
  text: string;
  questions: Record<string, DecideQuestion>;
}

export interface DecideResponse {
  answers: TypedAnswer[];
  source: ProviderRef;
}

export interface ProductDecider {
  decide(req: DecideRequest): Promise<DecideResponse>;
}

/** The question every candidate gets, matching "candidate / reject / needs evidence" in the diagram. */
export const SUITABILITY_QUESTION_ID = "suitability";

export function suitabilityQuestion(productType: string): DecideQuestion {
  return {
    type: "choice",
    instructions: `Is this product page for a ${productType.replace(/_/g, " ")} that fits the stated need?`,
    options: {
      candidate: "The page describes a matching product.",
      reject: "The page is for a different kind of product, or not a product page.",
      needs_evidence: "The page doesn't give enough detail to tell.",
    },
  };
}

/** Build the question set for one requirement: suitability, plus one yes/no per probed constraint. */
export function questionsFor(productType: string, constraints: RequirementConstraint[]): Record<string, DecideQuestion> {
  const qs: Record<string, DecideQuestion> = { [SUITABILITY_QUESTION_ID]: suitabilityQuestion(productType) };
  for (const c of constraints) {
    if (c.decideQuestion) qs[c.id] = { type: "noul", instructions: c.decideQuestion };
  }
  return qs;
}

/**
 * Rough chunker: about 4 characters per token, with headroom for questions. Replace with a
 * real tokenizer-based split once we see where the limit actually bites.
 */
export function chunkText(text: string, maxChars = 1400): string[] {
  const chunks: string[] = [];
  let rest = text.trim();
  while (rest.length > maxChars) {
    let cut = rest.lastIndexOf(" ", maxChars);
    if (cut < maxChars / 2) cut = maxChars;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

/** Normalize one entry of `result.data` into a TypedAnswer. Shape seen in SDK docs; verify against real output. */
export function toTypedAnswer(questionId: string, q: DecideQuestion, raw: unknown): TypedAnswer {
  const r = (raw ?? {}) as Record<string, unknown>;
  const probabilities =
    r.probabilities && typeof r.probabilities === "object" ? (r.probabilities as Record<string, number>) : {};
  let answer: unknown = r.answer ?? r.choice ?? r.score ?? r.noul;
  if (q.type === "noul" && typeof answer === "number") answer = answer >= 0.5 ? "yes" : "no";
  return { questionId, type: q.type, answer: String(answer ?? "unknown"), probabilities };
}

export function getProductDecider(): ProductDecider {
  return {
    async decide({ text, questions }) {
      const model = envOr("sie-decide", "SIE_DECIDE_MODEL");
      const res = await getSieClient().extract(model, { text }, { outputSchema: questions });
      const data = (res.data ?? {}) as Record<string, unknown>;
      return {
        answers: Object.entries(questions).map(([id, q]) => ({
          ...toTypedAnswer(id, q, data[id]),
          ...(id === SUITABILITY_QUESTION_ID ? {} : { constraintId: id }),
        })),
        source: { provider: "sie-decide", model, at: new Date().toISOString() },
      };
    },
  };
}
