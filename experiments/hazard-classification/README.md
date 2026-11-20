# Hazard classification experiment

The pipeline: **Gemma visual observation → GLiNER2.5 Decide → deterministic evidence validation**, tuned on the 10 development images. Success means fewer unsupported hazard claims while still detecting real problems.

**Results, examples, failure modes and the recommendation: [`REPORT.md`](REPORT.md).**

**Wired into the workflow** on branch `feat/vision-describe-classify`: `describePhoto` → `classifyPhoto` → `finalizeHazards` (see REPORT.md, Integration). The pipeline modules live in `src/lib/vision/observe-classify/`, and this folder holds the experiment runner, scoring, tuning and probes, which need no SingleStore, Firedrill, Exa, Hono or Workflow SDK.

## Run (real model calls; needs `SIE_API_KEY` via fnox)

```bash
HAZARD_EXPERIMENT=1 fnox exec -- aube exec vitest run --config experiments/hazard-classification/vitest.config.mts -t "development images"
# subset: HAZARD_IMAGES=STD-D01,STD-D03 ...   dataset elsewhere: STEADY_PREP_DIR=/path/to/steady-prep
# GLiNER request shape: HAZARD_GLINER_MODE=batch-texts (default) | single | batch-questions. See REPORT.md, Latency.
```

- **Expects** `steady-prep` checked out next to `steady-ai`.
- **Output** goes to `.data/experiments/hazard-classification/<run>/`, which is git-ignored:
  - `images/<id>.json`: ground truth, raw Gemma reply, observations, every GLiNER call with P(yes), part roles, the validator trace and labels;
  - `summary.json`;
  - `report.md`, which includes a threshold sweep.
- **Cache:** every model call is cached in `.data/experiments/hazard-classification/cache/`, so a rerun with unchanged prompts and questions makes **no** new calls.

## Tune (no model calls, no key)

```bash
HAZARD_RESCORE=.data/experiments/hazard-classification/<run> aube exec vitest run --config experiments/hazard-classification/vitest.config.mts -t "re-score"
```

This re-applies the validator to the stored reads across a grid of yes/no thresholds, and writes `tuning-<time>.md`.

| Lever | Where | New model calls? |
|---|---|---|
| `ValidatorConfig` (`minYes`, `noBelow`; the gap between them is "unknown") | `validate.ts` | No |
| GLiNER questions, part roles, item types | `classify.ts`, `definitions.ts` | GLiNER only. Gemma stays cached. |
| Observation prompt | `observe.ts` | Gemma and GLiNER for that image |

**Probes** (`probe.experiment.ts`) test GLiNER question formats on fixed sentences (`HAZARD_PROBE=1`, `HAZARD_PROBE_ROUND=2`) and show Gemma's output for chosen images (`HAZARD_PROBE_OBSERVE=STD-D01`).

**Guarding against over-fitting:** 10 images, 8 `present` cells, one fully negative image.
- Change a setting only when it removes false positives or unsupported claims without losing a true positive.
- Confirm the final setting **once** on the held-out set, and never tune on it.

## Pipeline

1. **Observe** (`observe.ts`). Gemma 4 with a neutral prompt; a unit test checks it never names a category, a hazard or a hazard object. It returns observations `{id, feature, description, location, visibility, limitations, parts}`. For stairs, tubs or showers, toilets, beds and the floor, `parts` lists each part with its visibility and the items on it. An **empty list means "clearly visible, nothing there"**: that's how absence is stated.
2. **Classify** (`classify.ts`). GLiNER2.5 Decide, through the production `getProductDecider().decide()` used unchanged, answers **one positive yes/no (`noul`) per call**, never about absence, because Decide can't read negation:
   - structure ("Is this a bathtub?");
   - part role, gated by structure ("Is this the left or right side of a staircase?");
   - item type ("Is this a grab bar?");
   - step damage and wear;
   - lamp, and lamp by the bed.

   GLiNER never sees the image. Every read is tied to an observation ID and a part.
3. **Validate** (`validate.ts`, pure). Fixed rules:
   - `present` needs a fully visible part;
   - an absence-type hazard needs the structure in view (for H02, both sides);
   - an unknown read is never `present` or `absent`;
   - H04 is never `absent`, and H08 is never `present` from a list;
   - no relevant part in the photo → `not_applicable`.

   The output is the production `VisionAnalysisResult`, so only `present` reaches `deriveRequirements`.

## Dataset: development split only

Read from `steady-prep/data/manifests/development.json`. The loader refuses anything that isn't `split: development` or is outside `data/development/`. Evaluation files and `labels/hazard-labels.json` (which mixes splits) are never opened.

| | Images |
|---|---|
| **Positives** (8 `present` cells) | H02 ×4 (D01, D05, D06, D10) · H09 + H10 (D03) · H05 + H07 (D09) |
| **Fully negative** | D02 only |
| **GT `cannot_determine` cells** (10) | D04 H09/H10 · D05 H04 · D06 H03/H04 · D07 H07 · D08 H02/H04/H06 · D10 H03 |
| **Coverage gaps** | No positive for H01, H03, H04, H06, H08, H11. Recall is undefined for those categories. |
