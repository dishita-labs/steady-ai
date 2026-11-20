/**
 * Product classification boundary (Superlinked SIE, GLiNER2.5 Decide).
 *
 * Read from the docs on 2026-11-20 and NOT yet exercised by a real call (`@superlinked/sie-sdk` 0.11.1, not installed yet):
 *   - model id: "fastino/GLiNER2.5-Decide"; 512-token text limit, so chunk product text
 *   - auth: SIE_API_KEY (Bearer), optional SIE_BASE_URL
 *   - client.extract(model, { text }, { labels | outputSchema, instruction, threshold })
 *   - the SDK requires Node >= 22
 * Not confirmed: whether SIE Serverless serves Decide (self-hosting needs a GPU), and the
 * exact outputSchema field types.
 *
 * The output is ADVISORY. The rules engine decides; a classification can only add a concern.
 */

import { notImplemented } from "@/lib/integrations";
import type { CandidateId, RequirementId } from "@/types/domain";

export interface ClassificationRequest {
  candidateId: CandidateId;
  requirementId: RequirementId;
  /** Product text taken from retained evidence. Keep within the model's token limit. */
  text: string;
  labels: string[];
  instruction?: string;
}

export interface ClassificationResponse {
  labels: { label: string; score: number }[];
  model: string;
  externalRef?: string;
}

export interface ProductClassifier {
  classify(req: ClassificationRequest): Promise<ClassificationResponse>;
}

export function getProductClassifier(): ProductClassifier {
  return { classify: () => notImplemented("superlinked", "classify") };
}
