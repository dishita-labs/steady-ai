/**
 * Tuning without model calls: re-run the validator over a finished run's stored Gemma
 * observations and GLiNER answers, for a grid of confidence thresholds, and score each setting.
 *
 * Guard against over-fitting: 10 development images, 8 `present` cells, 1 fully negative image.
 * Prefer a setting only when it removes FPs / unsupported claims WITHOUT losing a TP, and confirm
 * the chosen setting once on the held-out set (never tune on it).
 */

import { deriveRequirements } from "../../src/lib/rules/requirements";
import { validateVisionResult } from "../../src/lib/vision";
import type { CategoryLabel, HazardCategoryId, HazardFinding } from "../../src/types/domain";
import type { ClassifyResult } from "./classify";
import type { ObservationOutput } from "./observe";
import { fmt, score, type ImagePrediction, type Score } from "./score";
import { DEFAULT_VALIDATOR, traceProblems, validateClassifications, type ExperimentResult, type ValidatorConfig } from "./validate";

/** What a run stores per image (images/<id>.json), as far as tuning needs it. */
export interface StoredImage {
  imageId: string;
  gt: Record<HazardCategoryId, CategoryLabel>;
  observations?: ObservationOutput;
  classified?: Pick<ClassifyResult, "parts" | "stairCondition" | "structures" | "lamps" | "wear">;
  latencyMs: number;
}

const SOURCE = { provider: "sie-decide" as const, model: "experiment:gemma-observe+gliner-decide", at: "rescore" };

export function predict(img: StoredImage, cfg: ValidatorConfig): { row: ImagePrediction; result?: ExperimentResult } {
  if (!img.observations || !img.classified) {
    return { row: { imageId: img.imageId, gt: img.gt, pred: null, presentWithoutEvidence: [], requirementCount: 0, latencyMs: img.latencyMs } };
  }
  const result = validateClassifications(img.observations, { ...img.classified, calls: [] }, SOURCE, cfg);
  // Same contract production enforces before storing (validateVisionResult), plus traceability.
  const valid = validateVisionResult(result).length === 0 && traceProblems(result, img.observations).length === 0;
  const hazards: HazardFinding[] = result.findings.map((f, i) => ({ ...f, id: `haz_${i}`, caseId: "experiment", imageId: img.imageId, source: SOURCE }));
  return {
    result,
    row: {
      imageId: img.imageId,
      gt: img.gt,
      pred: valid ? result.categoryLabels : null,
      presentWithoutEvidence: result.findings.filter((f) => f.label === "present" && !f.visibleEvidence.length).map((f) => f.category),
      requirementCount: valid ? deriveRequirements("experiment", hazards).requirements.length : 0,
      latencyMs: img.latencyMs,
    },
  };
}

/** minYes × width of the "unknown" band below it (noBelow = minYes − band). */
export const SWEEP: ValidatorConfig[] = [0.5, 0.6, 0.7, 0.8].flatMap((y) => [0, 0.2, 0.4].map((band) => ({ minYes: y, noBelow: Math.round((y - band) * 100) / 100 })));

export function sweep(images: StoredImage[], grid: ValidatorConfig[] = SWEEP): { cfg: ValidatorConfig; score: Score }[] {
  return grid.map((cfg) => ({ cfg, score: score(images.map((i) => predict(i, cfg).row)) }));
}

export function renderSweep(results: { cfg: ValidatorConfig; score: Score }[]): string {
  const isDefault = (c: ValidatorConfig) => c.minYes === DEFAULT_VALIDATOR.minYes && c.noBelow === DEFAULT_VALIDATOR.noBelow;
  return [
    "| yes if P ≥ | no if P < | TP | FP | FN | deferred | precision | strict recall | appropriate CD | unsupported (+) | unsupported (−) | over-deferral | reqs on negative images |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|",
    ...results.map(({ cfg, score: s }) =>
      [
        `${cfg.minYes}${isDefault(cfg) ? " (default)" : ""}`,
        cfg.noBelow,
        s.tp, s.fp, s.fn, s.deferred,
        fmt(s.precision), fmt(s.strictRecall), fmt(s.uncertainty.appropriate),
        s.uncertainty.unsupportedPlus, s.uncertainty.unsupportedMinus, fmt(s.uncertainty.overDeferral),
        s.imageLevel.negativeImages.reduce((n, x) => n + x.requirements, 0),
      ].join(" | ").replace(/^/, "| ").concat(" |"),
    ),
  ].join("\n");
}
