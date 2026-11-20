# Hazard classification experiment: results (2026-11-20)

The pipeline: **Gemma observations → GLiNER2.5 Decide → deterministic validation**, run on the **10 development images only** with real Superlinked SIE calls. Results and every raw model response are in `.data/experiments/hazard-classification/2026-11-20T22-36-19-841Z/` (git-ignored, regenerated from the call cache with zero new calls). Scoring follows `steady-prep/docs/evaluation-methodology.md` §3–4.

**Read this first:** the development set is tiny (8 `present` cells, one fully negative image). Every design change below was made in response to errors on these same images. These numbers show the pipeline *can* behave well. They are **not** an unbiased estimate. Score it **once** on the held-out set before deciding anything.

The Gemma-only baseline was removed from the experiment at Dishita's request, so this report doesn't compare against production. The same scorer can score the production analyzer on the held-out set when that comparison is needed (see "Next").

## Final results (default thresholds: GLiNER yes ≥ 0.5, no < 0.3)

| Metric | Value |
|---|---|
| Valid output | 10/10 images |
| TP / FP / FN / deferred | 6 / 1 / 0 / 2 |
| Precision | 6/7 |
| Strict recall | 6/8 |
| Caught-or-escalated recall | 8/8 |
| Appropriate `cannot_determine` | 9/10 |
| Unsupported claim (+): GT CD → present | 1 |
| Unsupported claim (−): GT CD → absent/n.a. | **0** |
| Over-deferral: GT absent/n.a. → CD | 12/92 |
| `present` without visible evidence | 0 |
| Shopping requirements on images with no GT `present` (D02, D04, D07, D08) | **0** |

Per category, there's only enough data for H02 (4 positives: TP on D01 and D05, deferred on D06 and D10), H09 + H10 (D03, both TP) and H05 + H07 (D09, both TP). H01, H03, H04, H06, H08 and H11 have no positive examples, so recall is undefined for them.

## How it got here (all development set, default thresholds of each version)

| Version | What changed | TP | FP | FN | Deferred | Unsupp. (+) | Unsupp. (−) | Shopping on negatives |
|---|---|---|---|---|---|---|---|---|
| v1 | 4-way `choice` per category, grouped questions | D01 only: GLiNER near-uniform (~0.33/0.31/0.20/0.15) | | | | | | |
| v2.0 | Explicit empty part lists from Gemma; one positive `noul` per call | 5 | 2 | 3 | 0 | 3 | 0 | 1 |
| v2.1 | Single-concept nouls; absence needs the whole structure in view; untyped floor items count as clutter; lamp-by-bed reads | 5 | 2 | 0 | 3 | 2 | 1 | 0 |
| v2.2 | H02 needs two sides in view (instead of the whole staircase); carpet item type; wear guard for H03 | 6 | 2 | 0 | 2 | 1 | 1 | 0 |
| v2.3 | Unknown-aware clutter rule; default thresholds yes ≥ 0.5 / no < 0.3 | **6** | **1** | **0** | 2 | 1 | **0** | **0** |

## What we learned about the models

**GLiNER2.5 Decide can't read negation.** Probes on unambiguous sentences (`probe.experiment.ts`):

| Sentence | Result |
|---|---|
| "There is no handrail" | No question wording got this right. "Is a handrail missing?" scored yes 0.40. |
| Handrails on **both** sides | Answered **yes 0.95** to "are the steps without a handrail on at least one side?" |
| Positive presence ("Does the text mention a handrail?") | Sharp: 1.0 vs 0.0. |
| "There is no handrail" vs handrails never mentioned | The positive question scores both the same (≈0), so it can't tell "stated absent" from "not mentioned". |

That rules GLiNER out as the source of truth for absence hazards (H02, H09, H10, H11). In the final design it only answers positive single-concept yes/no questions ("Is this a bathtub?", "Is this the left or right side of a staircase?", "Is this a grab bar?"). **Absence comes from Gemma's explicit empty item lists**, read by fixed rules. Grouped multi-concept questions are blurry: "bathtub, shower or toilet?" scored 0.45 on "white alcove bathtub", while "Is this a bathtub?" was clear.

**Gemma 4 describes well but omits.** With a neutral prompt that never mentions hazards, it filled structured part lists sensibly: D01 "left side: [] / right side: []", D03 walls listing only a faucet and a soap dish, D02 "handrail" on both sides. It also left out decisive things: D04's toilet and its grab bar entirely, D08's wooden rail, and the sides of D10's steps.

## Examples

**Correct:**
- **D01:** H02 `present`, citing `[O6] stairs, left side (full): nothing` and `right side (full): nothing`. Potted plants on the treads were typed plant/decoration (0.74), so H01 stayed `absent`.
- **D03:** H09 `present` (back wall lists only a soap dish) and H10 `present` (tub floor fully visible, empty).
- **D07:** H11 `absent`, from a lamp observed "on the nightstand", next to the bed. No shopping triggered for this ordinary bedroom.
- **D08** (partial, dim staircase): H02 is `cannot_determine` because the left side is obscured. v2.0 had claimed a missing rail here.

**Incorrect, or right for the wrong reason:**
- **D02** H06 `present` (FP): a doormat on the porch. The taxonomy counts "mats" for H06, but the labels mark outdoor entrances `not_applicable`. This is a convention clash, not a model error, and no shopping rule exists for H06.
- **D08** H06 `present` (unsupported +): Gemma called the threshold covering a "worn red rug". The label says it can't tell rug from fixed flooring.
- **D06 and D10** H02 deferred, not detected: D06's left side is only partly visible, and Gemma listed D10's steps without their sides.
- **D04** H09 / H10 `cannot_determine` is correct, but only because the tub is cut off. Gemma never mentioned the toilet or its grab bar.

## Failure modes checked

| Failure mode | Observed? |
|---|---|
| Gemma omits a relevant object | **Yes:** D04 toilet and grab bar, D08 rail, D10 step sides. This is the main remaining limit, and no classifier can recover it. |
| Gemma hallucinates an object | No invented objects spotted in the structure lists reviewed during tuning (it named D07's desk a "nightstand", which is naming, not invention). Not judged systematically; the methodology reserves that for a person reading evidence against images at final eval. |
| GLiNER treats uncertainty as a confirmed hazard | **Yes, in v1:** near-uniform choices produced "absent" from irrelevant observations. Now prevented: unknown reads never become present or absent, and untyped items keep the part undecided. |
| Missing handrail inferred from a partly visible staircase | **Yes in v2.0 (D08). Fixed:** H02 needs two sides fully in view. |
| A normal room triggers a purchase requirement | v2.0: D07 (headboard read as a bedside part with no lamp). **Fixed:** 0 requirements on all four images without a real hazard. |
| Two models add latency without improving correctness | **The latency is real** (below). The correctness gain over Gemma-only was not measured, because the baseline was removed. |

## Latency and cost (per image)

- **Gemma observation:** 2.7–17.7 s (median ≈ 9 s), 1 call.
- **GLiNER:** 60–122 single-question reads per image (median ≈ 100).

**How those reads are sent matters:**

| Mode | Requests (10 images) | GLiNER time | Accuracy vs single calls |
|---|---|---|---|
| `single`: 1 text + 1 question per request | ~1,000 | 3–6 s per image (4 concurrent) | (reference) |
| **`batch-texts` (default):** 1 question over up to 32 texts | **300** | **≈14 s for all 10 images** | **Identical:** 939 reads, max \|ΔP\| 0.001, 0 label changes |
| `batch-questions`: up to 12 questions about 1 text | 208 | ≈11 s for all 10 | **Worse:** p95 \|ΔP\| 0.23, max 0.53; 101 yes/no flips; 20 label changes; TP/FP 6/1 → 4/3 |

Decide reads all questions in a request in one pass, and they interfere; texts in a batch don't. So questions stay one per request, and texts are batched (`extract(model, items[], …)`). End to end, an image is now dominated by the single Gemma call (≈ 9 s median).

## Recommendation

**Keep production on the Gemma-only analyzer for now.** Keep this pipeline as an optional strategy, and decide after one held-out comparison. Its design properties are what the brief asked for:
- every `present` cites a fully visible part;
- nothing uncertain reaches shopping;
- unsupported (−) claims are 0 on the development set;
- no ordinary room triggers a purchase.

The evidence is 10 tuned-on images. Gemma's omissions cap recall, and latency is much higher than one call. If the held-out run shows fewer unsupported claims than Gemma-only at similar recall, switch. If not, keep Gemma-only. The brief's rule applies either way.

## Next

1. **Held-out check (once, no tuning):** run this pipeline and the production analyzer on the 30 evaluation images with the same scorer. A small runner change (allowing the evaluation manifest behind an explicit flag) is needed, and should be reviewed by someone other than the person tuning.
2. **Biggest lever if adopted:** Gemma's omissions. Try a second, structure-only Gemma pass ("list every side and what is on it") for images where a structure was found.

## Integration for Nathan (only if adopted; nothing changed in production now)

The pipeline returns the production `VisionAnalysisResult` shape, and passes `validateVisionResult` and `deriveRequirements` unchanged. So integration is one optional branch in `getVisionAnalyzer()`:

1. **`src/lib/vision/index.ts`:** add `SIE_VISION_STRATEGY=observe-classify` (default stays `gemma-only`). When it's set, call `observe()` → `classifyObservations()` → `validateClassifications(…, DEFAULT_VALIDATOR)` from `experiments/hazard-classification/` (move those files to `src/lib/vision/observe-classify/`), and return the result without the `trace` and `roles` fields, or store `trace` as audit data.
2. **`src/lib/config.ts`:** document `SIE_VISION_STRATEGY` under `sie-vision.optional`.
3. **`src/workflows/steps.ts` (`analyzePhoto`):**
   - allow for ~10–20 s per image (one Gemma call plus ~20 batched GLiNER requests);
   - audit the GLiNER call count in `toolCall`;
   - consider recording `trace` (observation and part citations) in the `vision.analyzed` audit `data`. It holds observable facts only, no model reasoning.
4. **Severity:** this pipeline sets a fixed per-category placeholder (`definitions.ts`). Decide whether shopping or the UI uses severity before switching.
5. **No changes needed** to rules, shopping, the recorder or the UI.
