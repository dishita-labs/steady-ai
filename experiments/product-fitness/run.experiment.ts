/**
 * Product-fitness evaluation: Exa product pages → GLiNER2.5 Decide checklist reads → ranking.
 *
 *   Live (real Exa + SIE calls, cached):
 *     PRODUCT_EXPERIMENT=1 fnox exec -- aube exec vitest run --config experiments/product-fitness/vitest.config.mts
 *     subset: PRODUCT_TYPES=grab_bar,plug_in_night_light   results per query: PRODUCT_RESULTS=10
 *
 *   Re-score a finished run (no calls, no keys), e.g. after labelling or changing rules:
 *     PRODUCT_RESCORE=.data/experiments/product-fitness/<run> aube exec vitest run --config experiments/product-fitness/vitest.config.mts
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { missingEnv } from "../../src/lib/config";
import { installRecorder } from "../hazard-classification/record";
import { analyze, renderProduct, type StoredProductRun } from "./analyze";
import { CHECKLISTS, PRODUCT_TYPES, type ProductType } from "./checklist";
import { collect, productPageCheck } from "./collect";
import { decidePages } from "./decide";
import { loadGold } from "./labels";

const OUT = join(".data", "experiments", "product-fitness");

async function writeReport(dir: string, runs: StoredProductRun[], label: string) {
  const gold = await loadGold();
  const sections: string[] = [];
  const template: Record<string, unknown> = {};
  for (const run of runs) {
    const checklist = CHECKLISTS[run.productType];
    const a = analyze(checklist, run, gold);
    sections.push(renderProduct(checklist, run, a));
    Object.assign(template, a.template);
  }
  const header = [
    `# Product fitness: ${label}`,
    "",
    "Exa (shop domains only, structured seller sheet per page, every quote verified verbatim) → GLiNER2.5 Decide (one positive yes/no question per checklist item) → deterministic checklist ranking.",
    "GLiNER also reads the whole page for comparison. Checklist and sources: `experiments/product-fitness/checklist.ts`. Silver labels are keyword matches on the seller sheet, not ground truth.",
    "",
  ];
  await writeFile(join(dir, "report.md"), [...header, ...sections].join("\n"));
  await writeFile(join(dir, "labels-template.json"), JSON.stringify({ pages: template }, null, 2));
  return sections;
}

it.skipIf(process.env.PRODUCT_EXPERIMENT !== "1")("product fitness (real Exa + SIE calls)", { timeout: 60 * 60 * 1000 }, async () => {
  const missing = [...missingEnv("exa"), ...missingEnv("sie-decide")];
  if (missing.length) throw new Error(`Missing ${missing.join(", ")}. Run under \`fnox exec --\`.`);
  const types = (process.env.PRODUCT_TYPES?.split(",").map((s) => s.trim()).filter(Boolean) ?? PRODUCT_TYPES) as ProductType[];
  for (const t of types) if (!CHECKLISTS[t]) throw new Error(`Unknown product type ${t}`);
  const numResults = Number(process.env.PRODUCT_RESULTS ?? 10);

  const run = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = join(OUT, run);
  await mkdir(dir, { recursive: true });
  installRecorder(join(OUT, "sie-cache"));

  const runs: StoredProductRun[] = [];
  for (const t of types) {
    const checklist = CHECKLISTS[t];
    const { pages, searches } = await collect(checklist, join(OUT, "exa-cache"), numResults);
    const t0 = performance.now();
    // Only single-product pages are read; the rest are excluded before GLiNER either way.
    const products = pages.filter((p) => productPageCheck(p).ok);
    const decide = { sheet: await decidePages(products, checklist.items, "sheet"), page: await decidePages(products, checklist.items, "page") };
    const failed = decide.sheet.failedRequests.length + decide.page.failedRequests.length;
    console.log(`${t}: ${pages.length} pages, ${products.length} single-product, ${decide.sheet.requests}+${decide.page.requests} GLiNER requests (${failed} failed), ${Math.round(performance.now() - t0)} ms`);
    runs.push({ productType: t, searches, pages, decide });
  }
  await writeFile(join(dir, "run.json"), JSON.stringify({ run, numResults, runs }, null, 2));
  await writeReport(dir, runs, run);
  console.log(`Results: ${dir}`);
  expect(runs.length).toBe(types.length);
});

it.skipIf(!process.env.PRODUCT_RESCORE)("re-score a finished run (no calls)", async () => {
  const dir = process.env.PRODUCT_RESCORE!;
  const stored = JSON.parse(await readFile(join(dir, "run.json"), "utf8")) as { run: string; runs: StoredProductRun[] };
  await writeReport(dir, stored.runs, `${stored.run} (re-scored ${new Date().toISOString()})`);
  console.log(`Re-scored: ${join(dir, "report.md")}`);
  expect(stored.runs.length).toBeGreaterThan(0);
});
