/**
 * Scoring per steady-prep/docs/evaluation-methodology.md §3–4. The unit is one (image, category)
 * cell. Labels stay distinct: absent, not_applicable and cannot_determine are never merged.
 * An image whose output was invalid scores "invalid" in every cell (all real hazards missed).
 * Rates are reported as counts with their denominator; a 0 denominator is `undefined`, not 0.
 */

import type { CategoryLabel, HazardCategoryId } from "../../src/types/domain";
import { CATEGORY_IDS } from "./definitions";

export type Pred = CategoryLabel | "invalid";

export interface ImagePrediction {
  imageId: string;
  gt: Record<HazardCategoryId, CategoryLabel>;
  /** null = invalid/unparseable output for the whole image. */
  pred: Record<HazardCategoryId, CategoryLabel> | null;
  /** Categories predicted present whose finding has no visible evidence. */
  presentWithoutEvidence: HazardCategoryId[];
  /** Shopping requirements `deriveRequirements` would create from the prediction. */
  requirementCount: number;
  latencyMs: number;
}

export interface Ratio {
  num: number;
  den: number;
  /** undefined when den is 0. */
  value?: number;
}
const ratio = (num: number, den: number): Ratio => ({ num, den, value: den ? num / den : undefined });

export interface Score {
  images: number;
  invalidImages: string[];
  matrix: Record<CategoryLabel, Record<Pred, number>>;
  tp: number;
  fp: number;
  fn: number;
  deferred: number;
  precision: Ratio;
  strictRecall: Ratio;
  caughtOrEscalatedRecall: Ratio;
  uncertainty: { appropriate: Ratio; unsupportedPlus: number; unsupportedMinus: number; overDeferral: Ratio };
  presentWithoutEvidence: number;
  perCategory: Record<HazardCategoryId, { gtPresent: number; tp: number; fp: number; fn: number; deferred: number }>;
  falsePositives: string[];
  falseNegatives: string[];
  imageLevel: {
    positiveImagesFlagged: Ratio;
    /** Images with no GT present: FP count and how many would create a shopping requirement. */
    negativeImages: { imageId: string; fp: number; requirements: number; fullyNegative: boolean }[];
  };
  latencyMs: { total: number; perImage: Record<string, number>; median?: number };
}

const LABELS: CategoryLabel[] = ["present", "absent", "not_applicable", "cannot_determine"];

export function score(rows: ImagePrediction[]): Score {
  const matrix = Object.fromEntries(LABELS.map((g) => [g, Object.fromEntries([...LABELS, "invalid"].map((p) => [p, 0]))])) as Score["matrix"];
  const perCategory = Object.fromEntries(CATEGORY_IDS.map((c) => [c, { gtPresent: 0, tp: 0, fp: 0, fn: 0, deferred: 0 }])) as Score["perCategory"];
  let tp = 0, fp = 0, fn = 0, deferred = 0, gtPresent = 0, gtCd = 0, appropriate = 0, uPlus = 0, uMinus = 0, gtNeg = 0, overDef = 0;
  const falsePositives: string[] = [];
  const falseNegatives: string[] = [];

  for (const r of rows) {
    for (const c of CATEGORY_IDS) {
      const g = r.gt[c];
      const p: Pred = r.pred ? r.pred[c] : "invalid";
      matrix[g][p]++;
      const cell = `${r.imageId}/${c}`;
      if (g === "present") {
        gtPresent++;
        perCategory[c].gtPresent++;
        if (p === "present") {
          tp++;
          perCategory[c].tp++;
        } else if (p === "cannot_determine") {
          deferred++;
          perCategory[c].deferred++;
        } else {
          fn++;
          perCategory[c].fn++;
          falseNegatives.push(`${cell} (${p})`);
        }
      } else if (g === "cannot_determine") {
        gtCd++;
        if (p === "cannot_determine") appropriate++;
        else if (p === "present") uPlus++;
        else if (p === "absent" || p === "not_applicable") uMinus++;
      } else {
        gtNeg++;
        if (p === "present") {
          fp++;
          perCategory[c].fp++;
          falsePositives.push(`${cell} (gt ${g})`);
        } else if (p === "cannot_determine") overDef++;
      }
    }
  }

  const positives = rows.filter((r) => CATEGORY_IDS.some((c) => r.gt[c] === "present"));
  const lat = rows.map((r) => r.latencyMs).sort((a, b) => a - b);
  return {
    images: rows.length,
    invalidImages: rows.filter((r) => !r.pred).map((r) => r.imageId),
    matrix,
    tp,
    fp,
    fn,
    deferred,
    precision: ratio(tp, tp + fp),
    strictRecall: ratio(tp, gtPresent),
    caughtOrEscalatedRecall: ratio(tp + deferred, gtPresent),
    uncertainty: { appropriate: ratio(appropriate, gtCd), unsupportedPlus: uPlus, unsupportedMinus: uMinus, overDeferral: ratio(overDef, gtNeg) },
    presentWithoutEvidence: rows.reduce((n, r) => n + r.presentWithoutEvidence.length, 0),
    perCategory,
    falsePositives,
    falseNegatives,
    imageLevel: {
      positiveImagesFlagged: ratio(positives.filter((r) => r.pred && CATEGORY_IDS.some((c) => r.pred![c] === "present")).length, positives.length),
      negativeImages: rows
        .filter((r) => !positives.includes(r))
        .map((r) => ({
          imageId: r.imageId,
          fp: r.pred ? CATEGORY_IDS.filter((c) => r.pred![c] === "present").length : 0,
          requirements: r.requirementCount,
          fullyNegative: CATEGORY_IDS.every((c) => r.gt[c] === "absent" || r.gt[c] === "not_applicable"),
        })),
    },
    latencyMs: {
      total: lat.reduce((a, b) => a + b, 0),
      perImage: Object.fromEntries(rows.map((r) => [r.imageId, r.latencyMs])),
      median: lat.length ? (lat.length % 2 ? lat[(lat.length - 1) / 2] : (lat[lat.length / 2 - 1] + lat[lat.length / 2]) / 2) : undefined,
    },
  };
}

export const fmt = (r: Ratio) => (r.value === undefined ? `${r.num}/${r.den} (undefined)` : `${r.num}/${r.den}`);
