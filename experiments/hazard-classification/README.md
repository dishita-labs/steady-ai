# Hazard classification experiment

Question: does splitting **visual observation** (Gemma) from **hazard classification** (GLiNER2.5 Decide), with **deterministic evidence validation**, make fewer unsupported hazard claims than the production Gemma-only analyzer, while still finding real hazards?

Branch `feat/hazard-classification-experiment`. Isolated: no production file is modified, and it needs no SingleStore, Firedrill, Exa, Hono or Workflow SDK.

## Status (2026-11-20)

**Not run yet. No model results exist.** `SIE_API_KEY` doesn't resolve on Dishita's machine: fnox reports `steady-aiSIE_API_KEY` missing from the keychain. The pipeline, validator and scoring are built and unit-tested (`tests/hazard-experiment.test.ts`). The comparison report gets written only from a real run.

## Run

```bash
HAZARD_EXPERIMENT=1 fnox exec -- aube exec vitest run --config experiments/hazard-classification/vitest.config.mts
# subset: HAZARD_IMAGES=STD-D01,STD-D03 ...   dataset elsewhere: STEADY_PREP_DIR=/path/to/steady-prep
```

- **Expects** `steady-prep` checked out next to `steady-ai`.
- **Output** goes to `.data/experiments/hazard-classification/<run>/`, which is git-ignored:
  - `images/<id>.json`: ground truth, A's labels, findings and raw replies, B's raw observations, every GLiNER call and answer, the validator trace and labels;
  - `summary.json`;
  - `report.md`.
- **Cache:** every model call is cached in `.data/experiments/hazard-classification/cache/`, so a rerun makes no new calls. A cached call keeps the latency measured when it really ran.
- **Call volume:** about 1 Gemma call per image for A. For B, 1 Gemma call plus about 6 GLiNER calls per observation.

## Dataset: development split only

Read from `steady-prep/data/manifests/development.json`. The loader refuses any record that isn't `split: development` or whose file is outside `data/development/`. Nothing under `data/evaluation/`, `manifests/evaluation.json` or `labels/hazard-labels.json` (which mixes splits) is opened.

| | Images |
|---|---|
| **Positives** (8 `present` cells) | H02 ×4 (D01, D05, D06, D10) · H09 + H10 (D03) · H05 + H07 (D09) |
| **Fully negative** (only absent/n.a.) | **D02 only** |
| **No `present`, but has GT `cannot_determine`** | D04 (H09, H10), D07 (H07), D08 (H02, H04, H06) |
| **GT `cannot_determine` cells** (11) | D04 H09/H10 · D05 H04 · D06 H03/H04 · D07 H07 · D08 H02/H04/H06 · D10 H03 |
| **Coverage gaps** | No positive for H01, H03, H04, H06, H08, H11. H08 is `not_applicable` everywhere. Recall is undefined for those categories, and per-category rates must not be quoted. One fully negative image can't support a false-positive rate. |

The task brief described D04 as "partial visibility". That matches the manifest (`case_type: ambiguous`; toilet grab bar visible, tub mostly out of frame). D07 is `no_obvious_hazard`, but its GT includes H07 `cannot_determine`, so it isn't a fully negative image.

## Approaches

**A. Production Gemma-only.** This is `getVisionAnalyzer().analyze()` from `src/lib/vision`, called unchanged. Output that breaks `validateVisionResult` counts as invalid, because production would stop the run.

**B. Observe → classify → validate.**
1. **Observe.** Gemma 4 with a neutral prompt (`observe.ts`) returns `{roomType, observations[{id, feature, description, location, visibility: full|partial|obscured, limitations[]}], unknowns[]}`. The prompt never names a category, a hazard or a hazard object, and forbids safety judgements and unphotographable properties. A unit test enforces this.
2. **Classify.** GLiNER2.5 Decide, through the production `getProductDecider().decide()`, reads **one observation at a time** and answers a 4-way `choice` per category: `hazard | no_hazard | unclear | unrelated`. The criteria are narrow restatements of the taxonomy's `visible` text (`definitions.ts`). GLiNER never sees the image, and every read is tied to an observation ID. Categories are asked in small groups (6 calls per observation) so text plus questions stay under a 1,800-character budget for the 512-token window. Oversized calls are not sent, and they count as invalid.
3. **Validate** (`validate.ts`, pure). PRESENT needs a `hazard` read on a fully visible observation. Partial-only hazard reads become CANNOT_DETERMINE. A failed classification is CANNOT_DETERMINE. ABSENT needs a fully visible `no_hazard` read on a category whose deciding fact is photographable; H04's switches and bulbs aren't. Unclear or partial reads defer. Areas nobody mentions are NOT_APPLICABLE. The output uses the production `VisionAnalysisResult` shape, so `validateVisionResult` and `deriveRequirements` accept it unchanged, and only PRESENT reaches shopping.

## Scoring

Scoring follows `steady-prep/docs/evaluation-methodology.md` §3–4. Labels are never merged, and ground-truth `cannot_determine` cells are kept out of precision and recall and scored as uncertainty. The full report covers:
- TP, FP, FN and deferred counts;
- precision, strict recall, and caught-or-escalated recall;
- appropriate CD, unsupported claims (±) and over-deferral;
- `present` without evidence;
- positive images flagged;
- for each negative image: false positives and the shopping requirements `deriveRequirements` would create;
- latency.

All values are counts with their denominator. A zero denominator is reported as undefined.

## Known limitations of B (by design, to be measured)

- **Severity is a fixed placeholder** per category (`definitions.ts`), because B does no risk scoring. Production `HazardFinding` requires a severity.
- **`not_applicable` vs `absent` follows a dataset convention** that B can't always reproduce. For example, GT marks H04 `not_applicable` on outdoor entrance steps, while B returns `cannot_determine` by rule. That shows up as over-deferral.
- **Latency:** B makes many GLiNER calls (6 per observation), run 4 at a time. Its latency is part of the comparison.
