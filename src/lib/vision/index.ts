/**
 * Vision boundary: photo → structured hazard findings with visible evidence and uncertainty.
 *
 * Provider and model are NOT chosen yet (VISION_PROVIDER / VISION_MODEL).
 * Contract: one label per category H01–H11. "present" needs visible evidence.
 * Anything a photo can't show (anchoring, slipperiness, wall structure) is "cannot_determine"
 * or goes in `notEstablishedFromPhoto`, never a fact.
 */

import { notImplemented } from "@/lib/integrations";
import {
  HAZARD_CATEGORIES,
  type CategoryLabel,
  type HazardCategoryId,
  type HazardFinding,
  type HouseholdContext,
  type ProviderRef,
  type UploadedImage,
} from "@/types/domain";

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

export function getVisionAnalyzer(): VisionAnalyzer {
  return { analyze: () => notImplemented("vision", "analyze") };
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
