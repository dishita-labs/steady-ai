/** Render a run's summary as markdown. Numbers only; commentary goes in the README/docs. */

import { CATEGORY_IDS } from "../../src/lib/vision/observe-classify/definitions";
import { fmt, type ImagePrediction, type Score } from "./score";
import type { ValidatorConfig } from "../../src/lib/vision/observe-classify/validate";

interface Summary {
  run: string;
  images: string[];
  validator: ValidatorConfig;
  score: Score;
  rows: ImagePrediction[];
}

const ab = (l?: string) => ({ present: "P", absent: "a", not_applicable: "na", cannot_determine: "cd" })[l ?? ""] ?? "✗";

export function renderReport(s: Summary): string {
  const S = s.score;
  return [
    `# Hazard classification experiment: ${s.run}`,
    "",
    `Development images only (${s.images.length}): ${s.images.join(", ")}. Pipeline: Gemma observations → GLiNER2.5 Decide → validation.`,
    `Validator thresholds: GLiNER yes if P(yes) ≥ ${s.validator.minYes}, no if P(yes) < ${s.validator.noBelow}.`,
    "Scoring: steady-prep/docs/evaluation-methodology.md §3–4. Counts, not rates; 'undefined' means no examples.",
    "",
    "| Metric | Value |",
    "|---|---|",
    `| Invalid / incomplete outputs (images) | ${S.invalidImages.length} ${S.invalidImages.join(" ")} |`,
    `| TP / FP / FN / deferred | ${S.tp} / ${S.fp} / ${S.fn} / ${S.deferred} |`,
    `| Precision | ${fmt(S.precision)} |`,
    `| Strict recall | ${fmt(S.strictRecall)} |`,
    `| Caught-or-escalated recall | ${fmt(S.caughtOrEscalatedRecall)} |`,
    `| Appropriate cannot_determine | ${fmt(S.uncertainty.appropriate)} |`,
    `| Unsupported claim (+): GT CD → present | ${S.uncertainty.unsupportedPlus} |`,
    `| Unsupported claim (−): GT CD → absent/n.a. | ${S.uncertainty.unsupportedMinus} |`,
    `| Over-deferral: GT absent/n.a. → CD | ${fmt(S.uncertainty.overDeferral)} |`,
    `| Present without visible evidence | ${S.presentWithoutEvidence} |`,
    `| Positive images with any hazard flagged | ${fmt(S.imageLevel.positiveImagesFlagged)} |`,
    `| Median / total latency (ms) | ${S.latencyMs.median ?? "n/a"} / ${S.latencyMs.total} |`,
    "",
    "## Images with no GT present (negative controls)",
    "",
    "| Image | fully negative | FP | shopping requirements |",
    "|---|---|---|---|",
    ...S.imageLevel.negativeImages.map((n) => `| ${n.imageId} | ${n.fullyNegative ? "yes" : "no (has GT CD)"} | ${n.fp} | ${n.requirements} |`),
    "",
    "## Per-image labels (GT / predicted)",
    "",
    `| Image | ${CATEGORY_IDS.join(" | ")} |`,
    `|---|${CATEGORY_IDS.map(() => "---").join("|")}|`,
    ...s.rows.map((r) => `| ${r.imageId} | ${CATEGORY_IDS.map((c) => `${ab(r.gt[c])}/${ab(r.pred?.[c])}`).join(" | ")} |`),
    "",
    "P present · a absent · na not_applicable · cd cannot_determine · ✗ invalid output",
    "",
    "## False positives / negatives",
    "",
    `- FP: ${S.falsePositives.join(", ") || "none"}`,
    `- FN: ${S.falseNegatives.join(", ") || "none"}`,
    "",
  ].join("\n");
}
