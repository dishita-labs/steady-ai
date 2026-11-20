# Product fitness experiment

**Exa product pages (shop domains only, structured seller sheet) → GLiNER2.5 Decide checklist questions → deterministic ranking**, for the three products the requirement rules shop for today. These are R-H09 grab bar, R-H10 non-slip bath mat and R-H11 night light, in `src/lib/rules/requirements.ts`.

The question this experiment answers: can GLiNER read product pages well enough to rank them against a fitness checklist for an older adult's home, and does that ranking beat Exa's own order?

It uses `getProductSearchProvider()` (Exa) and SIE `extract` as production does. The only production change is an optional, backward-compatible `extract: { query, schema }` on the Exa provider, which maps to Exa's `contents.summary`, plus a raw `summary` on `RetrievedPage`. It needs no SingleStore, Workflow SDK or Hono.

The checklist, seller-sheet verification, shop list, page check, number parser and GLiNER reader live in `src/lib/product-fitness/`, shared with the workflow, so a change measured here is the change production runs. This folder holds only the evaluation: collection with caching, the comparison modes, labels, scoring and the report.

## Run

```bash
# Live: real Exa + SIE calls, all cached in .data/experiments/product-fitness/{exa,sie}-cache/
PRODUCT_EXPERIMENT=1 fnox exec -- aube exec vitest run --config experiments/product-fitness/vitest.config.mts
#   PRODUCT_TYPES=grab_bar,plug_in_night_light   PRODUCT_RESULTS=10 (per query)

# Re-score a finished run after labelling or a rule change: no calls, no keys
PRODUCT_RESCORE=.data/experiments/product-fitness/<run> aube exec vitest run --config experiments/product-fitness/vitest.config.mts
```

Output in `.data/experiments/product-fitness/<run>/` (git-ignored):
- `report.md`: rankings, per-item reads, scores, threshold sweep.
- `run.json`: pages, chunks, every P(yes).
- `labels-template.json`.

**Cost of a full run:**
- 9 Exa searches with a summary per result: about $0.03. Exa reported $0.011 for 4 results, of which $0.004 was summaries.
- About 210 batched GLiNER requests: roughly 75 reading sheets, 135 reading whole pages.
- About 60 s cold. A rerun is free.

## Pipeline

1. **Collect** (`collect.ts`, `src/lib/product-fitness/shops.ts`).
   - Three Exa queries per product. The first is the production rule's own `searchQuery`, which a test enforces.
   - Each query is restricted with `includeDomains` to that product's **US shops**: Amazon, Home Depot, Lowe's, Walmart, Target, plus per product CVS, Walgreens, Best Buy, Vitality Medical, Vive, Moen and HealthCraft.
   - Each search also asks Exa for a **structured product sheet** per result (`contents.summary` with `SHEET_SCHEMA`): page type, product name, the seller's description sentences and spec rows, copied word for word, never reviews or Q&A.
2. **Verify the sheet** (`src/lib/product-fitness/sheet.ts`). Exa's summary is written by a model, so every description sentence, spec value and the product name are kept **only if they appear verbatim in the page text** (case, whitespace and quote marks normalized). Unverified quotes are dropped and listed in the report. A name that isn't on the page falls back to the page title.
3. **Single-product pages only** (`productPageCheck`, `src/lib/product-fitness/page.ts`). A page is kept only if Exa says `single_product` and the URL matches the shop's product-URL pattern where one is known: `/p/…/<id>` at Home Depot, `/pd/` at Lowe's, `/dp/` at Amazon, and so on. This drops category pages and catalog PDFs before anything is read.
4. **Read** (`decide.ts` over the shared reader `src/lib/product-fitness/read.ts`).
   - GLiNER reads **the verified sheet**. Each checklist item is one positive, single-concept yes/no question, or several such questions meaning "any of". "X or Y" in one question reads poorly. A test enforces that no question contains negation.
   - For comparison, GLiNER also reads the **whole page** (the old way), and the report shows every product whose outcome changes.
5. **Check numbers** (`src/lib/product-fitness/extract.ts`).
   - GLiNER decides that a value is stated, and code parses it: `1-1/4"`, `32 mm`, `150 kg`, and spec rows that carry the unit in the name, like `Weight Capacity (lb.): 500`.
   - Another part's dimension doesn't count, e.g. `Escutcheon Diameter (in.)` is the flange cover, not the bar.
   - In sheet mode the parser reads the whole sheet, which is seller text only. In page mode it reads only the chunks GLiNER flagged, because of reviews.
   - A yes with no parsable number is *unknown*, never a pass.
6. **Rank** (`rank.ts`):
   - Not a single-product page, a red flag, or a numeric gate outside its threshold → **reject**.
   - A gate not shown → **needs_verification**.
   - Otherwise → **eligible**.
   - Within an outcome, pages are ordered by preferred-item score, then gates met, then Exa rank.
7. **Score** (`score.ts`, `labels.ts`).
   - References describe what the **seller states**. Silver labels are keyword matches on the verified sheet; gold labels go in `labels.json` (human). Both read sources are scored against the same reference.
   - Gold and silver are never combined. The same `rankPage` runs on the reference labels.
   - The dangerous error, "eligible" where the reference says "reject", is counted separately. Top-3 is compared with Exa's order.

## Checklist (`src/lib/product-fitness/checklist.ts`)

Sources were found with Exa on 2026-11-20. Each item carries its source URL and the sentence it rests on.

| Product | Gates (must be shown) | Red flag | Preferred (weight) |
|---|---|---|---|
| Grab bar | is a grab bar · **≥ 250 lb** (ADA §609.8) · screw-mounted (§609.8 covers the fastener) | suction-cup mount | diameter 1¼–2 in, §609.2.1 (2) · 1½ in wall clearance, §609.3 (1) · ADA claim (1) · textured grip (1) · stainless (1) |
| Non-slip mat | for inside the tub/shower (MedlinePlus, NIA) · grips with suction or adhesive | — | **lists compatible tub surfaces** (3, "the most important detail") · drainage holes (2) · slip test or certification (2) · size (1) · washable (1) |
| Night light | plug-in night light (NIA) · **turns on by itself** (NIA, CDC) | — | motion sensor (2) · warm or amber light, LRC studies (1) · floor-directed, low glare (1) · adjustable (1) · UL/ETL (1) |

**Evidence strength varies:**
- The grab bar gates rest on the ADA Standards' own text.
- Mat guidance is consumer-level. Note that the **ASTM bathtub slip-resistance standard was withdrawn in 2016** (CPSC, via Simple Aging). That's why "non-slip" gates nothing, and a published test only adds to the score.
- Amber night light evidence is from lab and feasibility studies. The 34% fall reduction in Zimmerman et al. 2024 was not significant (p = 0.18).
- "Textured grip" and "stainless" are practice, cited loosely.
- UL 1786 is named but its page wasn't fetched.

## Results

### Run 2 (2026-11-20): shop domains + verified seller sheets

86 single-product pages out of 89 (27 grab bars, 30 mats, 29 night lights). Every page came from a listed shop, and no listicle appeared.

| | Grab bar | Non-slip mat | Night light |
|---|---|---|---|
| Excluded before reading | Home Depot category page, 2 Moen catalog PDFs | none | none (after fixing the Best Buy URL pattern) |
| Sheet quotes verbatim on the page | 379/403 (94%) | 317/332 (95%) | 344/360 (96%) |
| Outcome changes, sheet vs whole page | 4 | 2 | 0 |
| Outcome agreement vs silver: sheet / whole page | **22/27 / 19/27** | 28/30 / 28/30 | 27/29 / 27/29 |

**What reading the sheet instead of the page changed:**
- **Fixed: all 3 false "suction cup" rejects disappear.** MITER, Seachrome and IMPEU were rejected from the whole page by review and related-product text. Run 1's HealthCraft review case ("super easy to install" → suction 0.73) is the same pattern.
- **Cost: 3 products drop to needs_verification because Exa's sheet left out a fact the seller does state.** IJDD's "500lbs Capacity"; Wirhao's and Target SlipX's suction cups. Wirhao has them only in a long keyword title, where even "Does the mat have suction cups?" reads 0.10. These errors are on the safe side.
- **Not done on purpose:** falling back to whole-page reads for a missing gate. A review saying "holds my 250 lb husband" would then pass the ADA capacity gate, the worst error this system can make. A targeted second extraction is the better fix (see Next).

**These numbers are not quotable:** silver labels only, 27–30 pages per product, and most of the pool is eligible.

### Run 1 (2026-11-20): open web, whole pages

90 pages, 30 per product. 8 of 30 night light "products" were listicles until a title rule removed them, and GLiNER's own page-type question failed (finding 1). Outcome agreement vs silver: 26/30, 27/30, 30/30.

## Findings

Findings 1–7 are from run 1, the open web with whole pages. Findings 8–12 are from run 2.

1. **GLiNER can't tell a product page from a page about products.**
   - "Is this text a shop listing for a single product?" scored 0.45–0.70 on almost every page.
   - It scored 0.84 on a "Best Motion Sensor Night Lights for Seniors" listicle.
   - Taking the max over chunks makes this worse: a listicle has a chunk per product.
   - Before the fix, 8 of the 30 night light "products" were articles, all ranked eligible.
   - Page type is now deterministic (`pageKind`). It catches all 8 articles and both Moen catalog PDFs, with no product page caught by mistake.
   - Category pages are not caught (Seachrome "Safety Grab Bars", Vive "Textured Grab Bars", Apache "Grab Bars, Stainless Steel"). They get ranked like products.
2. **Review and Q&A text drives false readings.**
   - HealthCraft Easy Mount (white) was rejected for "suction cups" at P = 0.73. The page never says "suction". GLiNER fired on a customer review: "super easy to install … holds my weight perfectly".
   - The stainless listing of the same product, with different reviews, is eligible.
   - Errors from reviews land on the safe side (reject), but they're still wrong. A likely fix is to read only the seller's description and specs. Exa's text doesn't mark sections, so that needs a heuristic.
3. **The keyword reference is wrong in exactly the way GLiNER was designed around.**
   - Vive's FAQ says "Is the Vive textured grab bar installed with screws or with suction cups? … only … with the included screws."
   - The keyword match says suction (a "reject"). GLiNER correctly says no.
   - So the only "dangerous" disagreement against silver labels is a silver error. Gold labels are needed before any accuracy claim.
4. **Soft preferred items get yes too easily** compared with silver labels:
   - low glare 9/22
   - UL/ETL 9/22
   - washable 15/29
   - mat size 16/26
   - slip test 0/5

   Either GLiNER over-reads related phrases ("soft glow" → low glare) or the keyword patterns are too narrow. Only gold labels will settle which. These items affect order within an outcome, never the outcome itself.
5. **Strong items** (agreement with silver): product type, weight capacity, diameter, stainless, suction/adhesive, drainage, automatic, motion sensor. The ADA 250 lb gate held up: every grab bar marked eligible had a parsed capacity ≥ 250 lb, mostly "500 lbs".
6. **Exa returns page markup.** A JSON-LD breadcrumb (`schema.org` with escaped slashes), 1,188 characters long, made SIE fail the *whole batch* on every question. The error was "Inference completed without a valid conserved billing settlement", most likely a token overflow reported badly. Fixed by stripping code and JSON-LD blocks, and by retrying failed batches one text at a time. The transient "API key authorization state is temporarily unavailable" errors went away on rerun (failures aren't cached).
7. **A mat that suits the tub depends on the tub.** The top-weighted mat item is "lists compatible surfaces", because suction mats fail on textured or tiled tubs. The real check is a context question ("Is the tub floor smooth or textured?") matched against the listing. That belongs in the R-H10 rule's `questions`.

8. **Exa's structured extraction is accurate but not complete.**
   - 94–96% of quotes were verbatim.
   - The dropped ones are paraphrases: "ADA compliant: specifications noted as ADA compliant", or a "Maximum weight capacity: 500 lbs. (when installed per instructions)" stitched together from a spec table. Verification catches both.
   - What verification can't catch is an *omission* (IJDD's capacity, Wirhao's suction cups).
   - The page type was right on every check: Home Depot's category page was `category_or_search`, a Moen PDF was `article_or_review_list`.
9. **Restricting to shops ends the listicle problem.** It costs every shop not listed. `shops.ts` is a product decision, not a technical one. `includeDomains: ["moen.com"]` also admits `assets.moen.com` PDFs; the page type and URL check remove them.
10. **The parser must read the whole seller sheet, not just the chunks GLiNER flags.** On Vive's sheet, GLiNER flagged the *shipping weight* chunk ("1 Pound (12")…") at 0.98 for "states a weight capacity", and the "Supporting up to 440 pounds" chunk at 0.46. Because the sheet holds only seller text, parsing all of it is safe.
11. **"X or Y" questions fail; "any of" single questions work better.**
    - "…grip the tub with suction cups or adhesive?" read 0.03 on Wirhao.
    - "…fastened with screws?" alone missed HealthCraft's "Easy Mount Anchors" (0.34).
    - The screw question is now "screws?" or "wall anchors?", and the HealthCraft anchor products pass.
12. **Silver labels keep failing on negation, now inside seller text.** ACEDSGN's sheet says "**Unlike** suction grab bars that may fall off…". The keyword match calls it a suction red flag; GLiNER correctly reads no. That is the one remaining grab bar "eligible but reject" against silver.

## Next

- **Gold labels.** The template now carries the verified sheet, so labelling means reading about 15 lines per product, not a whole page.
- **A targeted second extraction for missing gates.** For a product that ends at needs_verification, ask Exa (`getContents` with a summary schema) for verbatim quotes of exactly the missing facts (capacity, mounting, grip method). Then verify and re-read. This closes the omission gap without reading reviews.
- **The household's tub surface.** Add a context question to R-H10 and match it against the sheet's surface claims.

## Gold labels: how to add them

1. Copy entries from `<run>/labels-template.json` into `experiments/product-fitness/labels.json`, shaped `{ "pages": { "<url>": {...} } }`. Each entry is pre-filled with the keyword suggestion. Under `_help` it shows GLiNER's P(yes) and the keyword snippet, to speed review.
2. Read `_help.sheet` (and the page if in doubt). Set each item to `"yes"` or `"no"` for what the **seller** states. "no" means the seller doesn't state it; reviews don't count. Fill `labeledBy` and `at`, and delete `_help`.
3. Re-score: `PRODUCT_RESCORE=<run> …`. Gold tables and gold ranking agreement appear once a page has every item labelled.

**Guard against over-fitting:** change a question, threshold or rule only when it fixes errors on gold labels without losing a correct gate. Keep a held-out set of pages (a fresh Exa run with new queries) for one final check.

## Not done

- No production wiring. `src/lib/rules/requirements.ts` still has no constraints, and `decideProduct` still asks the single suitability question.
- No price, availability or seller checks.
- Context questions (tub surface, wall type) aren't connected to items yet.
