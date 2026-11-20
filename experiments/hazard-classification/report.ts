/** Render summary.json as a side-by-side markdown report. Numbers only; commentary goes in docs/. */

import { CATEGORY_IDS } from "./definitions";
import { fmt, type ImagePrediction, type Score } from "./score";

interface Summary {
  run: string;
  images: string[];
  baseline: Score;
  experiment: Score;
  rows: { baseline: ImagePrediction[]; experiment: ImagePrediction[] };
}

const row = (name: string, a: string | number, b: string | number) => `| ${name} | ${a} | ${b} |`;

export function renderReport(s: Summary): string {
  const { baseline: A, experiment: B } = s;
  const lines = [
    `# Hazard classification experiment: ${s.run}`,
    "",
    `Development images only (${s.images.length}): ${s.images.join(", ")}. A = production Gemma-only analyzer. B = Gemma observations → GLiNER2.5 Decide → validation.`,
    "Scoring: steady-prep/docs/evaluation-methodology.md §3–4. Counts, not rates; 'undefined' means no examples.",
    "",
    "| Metric | A: Gemma-only | B: observe → GLiNER → validate |",
    "|---|---|---|",
    row("Invalid / incomplete outputs (images)", `${A.invalidImages.length} ${A.invalidImages.join(" ")}`, `${B.invalidImages.length} ${B.invalidImages.join(" ")}`),
    row("TP", A.tp, B.tp),
    row("FP (present where GT absent/n.a.)", A.fp, B.fp),
    row("FN (GT present → absent/n.a./invalid)", A.fn, B.fn),
    row("Deferred (GT present → cannot_determine)", A.deferred, B.deferred),
    row("Precision", fmt(A.precision), fmt(B.precision)),
    row("Strict recall", fmt(A.strictRecall), fmt(B.strictRecall)),
    row("Caught-or-escalated recall", fmt(A.caughtOrEscalatedRecall), fmt(B.caughtOrEscalatedRecall)),
    row("Appropriate cannot_determine", fmt(A.uncertainty.appropriate), fmt(B.uncertainty.appropriate)),
    row("Unsupported claim (+): GT CD → present", A.uncertainty.unsupportedPlus, B.uncertainty.unsupportedPlus),
    row("Unsupported claim (−): GT CD → absent/n.a.", A.uncertainty.unsupportedMinus, B.uncertainty.unsupportedMinus),
    row("Over-deferral: GT absent/n.a. → CD", fmt(A.uncertainty.overDeferral), fmt(B.uncertainty.overDeferral)),
    row("Present without visible evidence", A.presentWithoutEvidence, B.presentWithoutEvidence),
    row("Positive images with any hazard flagged", fmt(A.imageLevel.positiveImagesFlagged), fmt(B.imageLevel.positiveImagesFlagged)),
    row("Median latency per image (ms)", A.latencyMs.median ?? "n/a", B.latencyMs.median ?? "n/a"),
    row("Total latency (ms)", A.latencyMs.total, B.latencyMs.total),
    "",
    "## Images with no GT present (negative controls)",
    "",
    "| Image | fully negative | A: FP | A: shopping reqs | B: FP | B: shopping reqs |",
    "|---|---|---|---|---|---|",
    ...A.imageLevel.negativeImages.map((n) => {
      const m = B.imageLevel.negativeImages.find((x) => x.imageId === n.imageId)!;
      return `| ${n.imageId} | ${n.fullyNegative ? "yes" : "no (has GT CD)"} | ${n.fp} | ${n.requirements} | ${m.fp} | ${m.requirements} |`;
    }),
    "",
    "## Per-image labels (GT / A / B)",
    "",
    `| Image | ${CATEGORY_IDS.join(" | ")} |`,
    `|---|${CATEGORY_IDS.map(() => "---").join("|")}|`,
    ...s.rows.baseline.map((ra, i) => {
      const rb = s.rows.experiment[i];
      const ab = (l?: string) => ({ present: "P", absent: "a", not_applicable: "na", cannot_determine: "cd" })[l ?? ""] ?? "✗";
      return `| ${ra.imageId} | ${CATEGORY_IDS.map((c) => `${ab(ra.gt[c])}/${ab(ra.pred?.[c])}/${ab(rb.pred?.[c])}`).join(" | ")} |`;
    }),
    "",
    "P present · a absent · na not_applicable · cd cannot_determine · ✗ invalid output",
    "",
    "## False positives / negatives",
    "",
    `- A FP: ${A.falsePositives.join(", ") || "none"}`,
    `- B FP: ${B.falsePositives.join(", ") || "none"}`,
    `- A FN: ${A.falseNegatives.join(", ") || "none"}`,
    `- B FN: ${B.falseNegatives.join(", ") || "none"}`,
    "",
  ];
  return lines.join("\n");
}
