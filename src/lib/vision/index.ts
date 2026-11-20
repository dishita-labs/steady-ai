/**
 * Vision boundary: photo → structured hazard findings with visible evidence and uncertainty.
 *
 * Model: Gemma 4 31B on Superlinked SIE (`client.chatCompletions`, OpenAI-compatible), with a
 * strict JSON-schema `response_format`. The model ID is configurable (SIE_VISION_MODEL) so a
 * profile suffix such as `:h100-96k-hires-out8k-no-spec` can be chosen after evaluation.
 *
 * Contract: one label per category H01–H11. "present" needs visible evidence.
 * Anything a photo can't show (anchoring, slipperiness, wall structure) is "cannot_determine"
 * or goes in `notEstablishedFromPhoto`, never a fact.
 *
 * NOT evaluated yet. The prompt in ./prompt.ts is a first draft for the eval set.
 */

import { z } from "zod";
import { envOr } from "../config";
import { getSieClient } from "../sie";
import {
  HAZARD_CATEGORIES,
  type CategoryLabel,
  type HazardCategoryId,
  type HazardFinding,
  type HouseholdContext,
  type ProviderRef,
  type UploadedImage,
} from "../../types/domain";
import { VISION_RESPONSE_SCHEMA, visionSystemPrompt } from "./prompt";

export interface VisionAnalysisInput {
  image: UploadedImage;
  bytes: Uint8Array;
  household?: HouseholdContext;
}

export type VisionFindingDraft = Omit<HazardFinding, "id" | "caseId" | "imageId" | "source">;

export interface VisionAnalysisResult {
  categoryLabels: Record<HazardCategoryId, CategoryLabel>;
  findings: VisionFindingDraft[];
  uncertainties: string[];
  humanAssessmentRequired: boolean;
  source: ProviderRef;
}

export interface VisionAnalyzer {
  analyze(input: VisionAnalysisInput): Promise<VisionAnalysisResult>;
}

const categoryIds = Object.keys(HAZARD_CATEGORIES) as [HazardCategoryId, ...HazardCategoryId[]];
const label = z.enum(["present", "absent", "cannot_determine", "not_applicable"]);

/** Runtime parse of the model's JSON. Shape only; safety rules are in `validateVisionResult`. */
export const VisionModelOutput = z.object({
  categoryLabels: z.record(z.enum(categoryIds), label),
  findings: z.array(
    z.object({
      category: z.enum(categoryIds),
      label: z.enum(["present", "cannot_determine"]),
      summary: z.string(),
      visibleEvidence: z.array(z.string()),
      location: z.object({ description: z.string() }).nullable().optional(),
      severity: z.enum(["low", "moderate", "high"]),
      notEstablishedFromPhoto: z.array(z.string()),
      humanAssessmentRequired: z.boolean(),
      professionalAssessmentRecommended: z.boolean(),
    }),
  ),
  uncertainties: z.array(z.string()),
  humanAssessmentRequired: z.boolean(),
});
export type VisionModelOutput = z.infer<typeof VisionModelOutput>;

export function getVisionAnalyzer(): VisionAnalyzer {
  return {
    async analyze({ image, bytes, household }) {
      const model = envOr("sie-vision", "SIE_VISION_MODEL");
      const dataUrl = `data:${image.mimeType};base64,${Buffer.from(bytes).toString("base64")}`;
      const reply = await getSieClient().chatCompletions({
        model,
        messages: [
          { role: "system", content: visionSystemPrompt({ room: image.room, household }) },
          { role: "user", content: [{ type: "image_url", image_url: { url: dataUrl } }] },
        ],
        temperature: 0,
        max_completion_tokens: 4096,
        response_format: {
          type: "json_schema",
          json_schema: { name: "hazard_findings", strict: true, schema: VISION_RESPONSE_SCHEMA },
        },
      });
      const content = reply.choices[0]?.message.content;
      if (typeof content !== "string") throw new Error("Vision model returned no text content.");
      const parsed = VisionModelOutput.parse(JSON.parse(content));
      return {
        categoryLabels: parsed.categoryLabels as Record<HazardCategoryId, CategoryLabel>,
        findings: parsed.findings.map((f) => ({ ...f, location: f.location ?? undefined })),
        uncertainties: parsed.uncertainties,
        humanAssessmentRequired: parsed.humanAssessmentRequired,
        source: { provider: "sie-vision", model, externalRef: reply.id, at: new Date().toISOString() },
      };
    },
  };
}

/** Check model output against the contract before anything is stored. Returns problems (empty = ok). */
export function validateVisionResult(r: VisionAnalysisResult): string[] {
  const problems: string[] = [];
  const ids = Object.keys(HAZARD_CATEGORIES) as HazardCategoryId[];
  for (const id of ids) {
    if (!r.categoryLabels[id]) problems.push(`Missing label for ${id}.`);
  }
  for (const key of Object.keys(r.categoryLabels)) {
    if (!(key in HAZARD_CATEGORIES)) problems.push(`Unknown category ${key}.`);
  }
  for (const f of r.findings) {
    if (r.categoryLabels[f.category] !== f.label) {
      problems.push(`${f.category}: finding says ${f.label} but category label is ${r.categoryLabels[f.category]}.`);
    }
    if (f.label === "present" && f.visibleEvidence.filter((e) => e.trim()).length === 0) {
      problems.push(`${f.category}: "present" without visible evidence.`);
    }
  }
  for (const id of ids) {
    if (r.categoryLabels[id] === "present" && !r.findings.some((f) => f.category === id && f.label === "present")) {
      problems.push(`${id}: labeled present but has no finding with evidence.`);
    }
  }
  return problems;
}
