# Hazard classification experiment

The pipeline: **Gemma visual observation → GLiNER2.5 Decide hazard classification → deterministic evidence validation**, tuned on the development images. Success means fewer unsupported hazard claims while still detecting real problems.

Branch `feat/hazard-classification-experiment`. Isolated: no production file is modified, and it needs no SingleStore, Firedrill, Exa, Hono or Workflow SDK. The production Gemma-only analyzer (`src/lib/vision`) is untouched and still runs the app. This experiment no longer calls it.

## Status (2026-11-20)

**Not run yet. No model results exist.** `SIE_API_KEY` isn't on Dishita's machine, so Nathan runs the experiment, then the results are tuned here with no model calls. The pipeline, validator, scoring and tuning sweep are unit-tested (`tests/hazard-experiment.test.ts`).

## 1. Run (Nathan's machine, real model calls)

```bash
HAZARD_EXPERIMENT=1 fnox exec -- aube exec vitest run --config experiments/hazard-classification/vitest.config.mts
# subset: HAZARD_IMAGES=STD-D01,STD-D03 ...   dataset elsewhere: STEADY_PREP_DIR=/path/to/steady-prep
```

- **Expects** `steady-prep` checked out next to `steady-ai`.
- **Output** goes to `.data/experiments/hazard-classification/<run>/`, which is git-ignored:
  - `images/<id>.json`: ground truth, raw Gemma reply, observations, every GLiNER call and answer with probabilities, the validator trace and labels;
  - `summary.json`;
  - `report.md`, which includes a threshold sweep.
- **Cache:** every model call is cached in `.data/experiments/hazard-classification/cache/`, so rerunning with the same prompt and questions makes no new calls.
- **Call volume:** 1 Gemma call per image, plus 6 GLiNER calls per observation, 4 at a time.

Send back the whole `.data/experiments/hazard-classification/` folder, including `cache/`.

## 2. Tune (anywhere, no model calls, no key)

```bash
HAZARD_RESCORE=.data/experiments/hazard-classification/<run> aube exec vitest run --config experiments/hazard-classification/vitest.config.mts
```

This re-applies the validator to the stored observations and GLiNER answers across a grid of thresholds, and writes `tuning-<time>.md` into the run folder.

**What can be tuned, and what costs what:**

| Lever | Where | Needs new model calls? |
|---|---|---|
| `minHazardProbability`, `minClearProbability`: a weak `hazard` or `no_hazard` read becomes `unclear` | `validate.ts` (`ValidatorConfig`) | **No.** Use the re-score sweep. |
| GLiNER criteria wording, question grouping | `definitions.ts` | Yes, GLiNER only. Gemma observations stay cached. |
| Observation prompt | `observe.ts` | Yes, Gemma and GLiNER for that image. |

**Fixed rules, not tunable:**
- `present` needs a fully visible observation;
- a partial-only hazard is `cannot_determine`;
- H04 (stair lighting) is never `absent`;
- a failed classification is never `absent`;
- every label cites real observation IDs.

**Guarding against over-fitting:** the development set has 10 images, 8 `present` cells and one fully negative image.
- Change a setting only when it removes false positives or unsupported claims **without losing a true positive**.
- Prefer the simpler setting when two settings tie.
- Confirm the final setting **once** on the held-out evaluation set, and never tune on it.

## Dataset: development split only

Read from `steady-prep/data/manifests/development.json`. The loader refuses any record that isn't `split: development` or whose file is outside `data/development/`. Nothing under `data/evaluation/`, `manifests/evaluation.json` or `labels/hazard-labels.json` (which mixes splits) is opened.

| | Images |
|---|---|
| **Positives** (8 `present` cells) | H02 ×4 (D01, D05, D06, D10) · H09 + H10 (D03) · H05 + H07 (D09) |
| **Fully negative** (only absent/n.a.) | **D02 only** |
| **No `present`, but has GT `cannot_determine`** | D04 (H09, H10), D07 (H07), D08 (H02, H04, H06) |
| **GT `cannot_determine` cells** (11) | D04 H09/H10 · D05 H04 · D06 H03/H04 · D07 H07 · D08 H02/H04/H06 · D10 H03 |
| **Coverage gaps** | No positive for H01, H03, H04, H06, H08, H11. H08 is `not_applicable` everywhere. Recall is undefined for those categories, and per-category rates must not be quoted. One fully negative image can't support a false-positive rate. |

## Pipeline

1. **Observe** (`observe.ts`). Gemma 4 with a neutral prompt returns `{roomType, observations[{id, feature, description, location, visibility: full|partial|obscured, limitations[]}], unknowns[]}`. The prompt never names a category, a hazard or a hazard object, and forbids safety judgements and unphotographable properties. A unit test enforces this.
2. **Classify** (`classify.ts`). GLiNER2.5 Decide, through the production `getProductDecider().decide()` used unchanged, reads **one observation at a time**. It answers a 4-way `choice` per category: `hazard | no_hazard | unclear | unrelated`. The criteria are narrow restatements of the taxonomy's `visible` text (`definitions.ts`). GLiNER never sees the image, and every read is tied to an observation ID. Categories are asked in small groups so each call stays under a 1,800-character budget for the 512-token window. Oversized calls are not sent, and they count as invalid.
3. **Validate** (`validate.ts`, pure). The fixed rules above, plus the tunable thresholds. The output uses the production `VisionAnalysisResult` shape, so `validateVisionResult` and `deriveRequirements` accept it unchanged, and only `present` reaches shopping.

## Scoring

Scoring follows `steady-prep/docs/evaluation-methodology.md` §3–4. Labels are never merged, and ground-truth `cannot_determine` cells are kept out of precision and recall and scored as uncertainty. The report covers:
- TP, FP, FN and deferred counts;
- precision, strict recall, and caught-or-escalated recall;
- appropriate CD, unsupported claims (±) and over-deferral;
- `present` without evidence;
- for each negative image: false positives and the shopping requirements it would create;
- latency.

All values are counts with their denominator. A zero denominator is reported as undefined.

## Known limitations (to be measured)

- **Severity is a fixed placeholder** per category (`definitions.ts`), because the pipeline does no risk scoring. Production `HazardFinding` requires a severity.
- **`not_applicable` vs `absent` follows a dataset convention** that the rules can't always reproduce. For example, GT marks H04 `not_applicable` on outdoor entrance steps, while the validator returns `cannot_determine`. That shows up as over-deferral.
- **Latency:** about 6 GLiNER calls per observation, against 1 call in production. Measured in every run.
