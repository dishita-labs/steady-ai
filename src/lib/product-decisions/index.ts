/**
 * Typed product decisions (Superlinked SIE, GLiNER2.5 Decide).
 *
 *   client.extract("fastino/GLiNER2.5-Decide", { text }, { outputSchema: { <id>: { type, instructions, criteria? } } })
 *   → result.data[<id>]:
 *       noul:   { type, noul: P(yes), answer: boolean, confidence }
 *       choice: { type, choice: label, probabilities: { label: p }, confidence }
 *       score:  { type, score, probabilities: { "0": p, ... }, confidence }
 *   (shapes confirmed against SIE Serverless on 2026-11-20)
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
  /** `criteria`: label → description (or a plain list of labels). */
  | { type: "choice"; instructions: string; criteria: Record<string, string> | string[] }
  /** `criteria`: one description per ordinal level "0".."k-1" (at most 10). */
  | { type: "score"; instructions: string; criteria: string[] };

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
    criteria: {
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

/** Normalize one entry of `result.data` into a TypedAnswer (shapes in the header comment). */
export function toTypedAnswer(questionId: string, q: DecideQuestion, raw: unknown): TypedAnswer {
  const r = (raw ?? {}) as Record<string, unknown>;
  if (q.type === "noul") {
    const pYes = typeof r.noul === "number" ? r.noul : undefined;
    const answer = r.answer === true ? "yes" : r.answer === false ? "no" : pYes === undefined ? "unknown" : pYes >= 0.5 ? "yes" : "no";
    return { questionId, type: "noul", answer, probabilities: pYes === undefined ? {} : { yes: pYes, no: 1 - pYes } };
  }
  const probabilities =
    r.probabilities && typeof r.probabilities === "object" ? (r.probabilities as Record<string, number>) : {};
  const answer = q.type === "choice" ? r.choice : r.score;
  return { questionId, type: q.type, answer: answer === undefined || answer === null ? "unknown" : String(answer), probabilities };
}

export function getProductDecider(): ProductDecider {
  return {
    async decide({ text, questions }) {
      const model = envOr("sie-decide", "SIE_DECIDE_MODEL");
      // overflow_policy "error": text over the 512-token window fails instead of being silently cut.
      const res = await getSieClient().extract(model, { text }, { outputSchema: questions, adapterOptions: { overflow_policy: "error" } });
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
