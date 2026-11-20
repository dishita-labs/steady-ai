/**
 * Gemma observations → GLiNER Decide → validation, on the DEVELOPMENT images.
 *
 * Run (real model calls; needs SIE_API_KEY):
 *   HAZARD_EXPERIMENT=1 fnox exec -- aube exec vitest run --config experiments/hazard-classification/vitest.config.mts
 *     HAZARD_IMAGES=STD-D01,STD-D03   subset (default: priority D01,D03,D04,D07,D09, then the rest)
 *     STEADY_PREP_DIR=...             dataset location (default ../steady-prep)
 *
 * Tune (no model calls, no key): re-validate a finished run across the threshold grid.
 *   HAZARD_RESCORE=.data/experiments/hazard-classification/<run> aube exec vitest run --config experiments/hazard-classification/vitest.config.mts
 *
 * Output: .data/experiments/hazard-classification/<run>/ (git-ignored). Model calls are cached in
 * .data/experiments/hazard-classification/cache/, so reruns don't repeat them.
 * Needs no SingleStore, Firedrill, Exa, Hono or Workflow SDK.
 */

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { missingEnv } from "../../src/lib/config";
import { validateVisionResult } from "../../src/lib/vision";
import { classifyObservations, type GlinerMode } from "../../src/lib/vision/observe-classify/classify";
import { loadDevelopmentSet, mimeTypeFor, type DevRecord } from "./dataset";
import { observe } from "../../src/lib/vision/observe-classify/observe";
import { installRecorder } from "./record";
import { renderReport } from "./report";
import { score } from "./score";
import { predict, renderSweep, sweep, type StoredImage } from "./tune";
import { DEFAULT_VALIDATOR, traceProblems } from "../../src/lib/vision/observe-classify/validate";

const PRIORITY = ["STD-D01", "STD-D03", "STD-D04", "STD-D07", "STD-D09"];
/**
 * HAZARD_GLINER_MODE=single|batch-texts|batch-questions. Default batch-texts: measured 2026-11-20 on
 * all 939 reads, identical to single calls (max |ΔP| 0.001, no label changes) with ~3x fewer
 * requests. batch-questions shifted answers (p95 |ΔP| 0.23, 20 label changes) and scored worse.
 */
const GLINER_MODE = (process.env.HAZARD_GLINER_MODE ?? "batch-texts") as GlinerMode;
const OUT = join(".data", "experiments", "hazard-classification");

it.skipIf(process.env.HAZARD_EXPERIMENT !== "1")("hazard classification experiment (development images, real SIE calls)", { timeout: 60 * 60 * 1000 }, async () => {
  const missing = missingEnv("sie-vision");
  if (missing.length) throw new Error(`Missing ${missing.join(", ")}. Run under \`fnox exec --\` with SIE_API_KEY in the keychain.`);

  const all = await loadDevelopmentSet();
  const wanted = process.env.HAZARD_IMAGES?.split(",").map((s) => s.trim()).filter(Boolean);
  const order = [...PRIORITY, ...all.map((r) => r.imageId).filter((id) => !PRIORITY.includes(id))];
  const images: DevRecord[] = (wanted ?? order).map((id) => {
    const r = all.find((x) => x.imageId === id);
    if (!r) throw new Error(`${id} is not a development image.`);
    return r;
  });

  const run = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = join(OUT, run);
  await mkdir(join(dir, "images"), { recursive: true });
  const rec = installRecorder(join(OUT, "cache"));
  const stored: StoredImage[] = [];

  for (const img of images) {
    const bytes = new Uint8Array(await readFile(img.file));
    const mark = rec.count;
    const o = await observe({ bytes, mimeType: mimeTypeFor(img.file), room: img.room });
    const tObs = rec.since(mark).reduce((n, c) => n + c.latencyMs, 0);
    const out: Record<string, unknown> = { imageId: img.imageId, room: img.room, caseType: img.caseType, gt: img.labels, gtEvidence: img.visibleEvidence };
    out.observe = { ok: o.ok, error: o.error, model: o.model, raw: o.raw };

    let tCls = 0;
    const s: StoredImage = { imageId: img.imageId, gt: img.labels, latencyMs: tObs };
    if (o.ok && o.output) {
      const markCls = rec.count;
      const t0 = performance.now();
      const cls = await classifyObservations(o.output, 4, GLINER_MODE);
      const calls = rec.since(markCls);
      const live = calls.every((c) => !c.cached);
      tCls = live ? Math.round(performance.now() - t0) : calls.reduce((n, c) => n + c.latencyMs, 0);
      s.observations = o.output;
      s.classified = { parts: cls.parts, stairCondition: cls.stairCondition, structures: cls.structures, lamps: cls.lamps, wear: cls.wear };
      s.latencyMs = tObs + tCls;
      const { result } = predict(s, DEFAULT_VALIDATOR);
      Object.assign(out, {
        observations: o.output,
        classified: { parts: cls.parts, stairCondition: cls.stairCondition, structures: cls.structures, lamps: cls.lamps, wear: cls.wear },
        classifyCalls: cls.calls,
        failedClassifications: cls.calls.filter((c) => !c.ok).length,
        roles: result!.roles,
        labels: result!.categoryLabels,
        trace: result!.trace,
        findings: result!.findings,
        problems: [...validateVisionResult(result!), ...traceProblems(result!, o.output)],
        latencyMs: {
          observe: tObs,
          classify: tCls,
          classifyMeasuredAs: live ? "wall clock, 4 concurrent calls" : "sum of call latencies (cached rerun)",
          total: tObs + tCls,
          classifyCalls: calls.length,
        },
      });
    }
    out.calls = rec.since(mark).map((c) => ({ ...c, response: c.method === "extract" ? c.response : undefined })); // Gemma raw is in observe.raw
    stored.push(s);
    await writeFile(join(dir, "images", `${img.imageId}.json`), JSON.stringify(out, null, 2));
    console.log(`${img.imageId}: ${o.ok ? "ok" : `invalid (${o.error})`} ${tObs + tCls}ms`);
  }

  const rows = stored.map((s) => predict(s, DEFAULT_VALIDATOR).row);
  const summary = { run, glinerMode: GLINER_MODE, images: images.map((i) => i.imageId), validator: DEFAULT_VALIDATOR, score: score(rows), rows };
  await writeFile(join(dir, "summary.json"), JSON.stringify(summary, null, 2));
  await writeFile(join(dir, "report.md"), `${renderReport(summary)}\n## Threshold sweep (same run, no new calls)\n\n${renderSweep(sweep(stored))}\n`);
  console.log(`Results: ${dir}`);
  expect(rows.length).toBe(images.length);
});

it.skipIf(!process.env.HAZARD_RESCORE)("re-score a finished run across validator thresholds (no model calls)", async () => {
  const dir = process.env.HAZARD_RESCORE!;
  const files = (await readdir(join(dir, "images"))).filter((f) => f.endsWith(".json")).sort();
  const stored: StoredImage[] = [];
  for (const f of files) {
    const j = JSON.parse(await readFile(join(dir, "images", f), "utf8"));
    stored.push({ imageId: j.imageId, gt: j.gt, observations: j.observations, classified: j.classified, latencyMs: j.latencyMs?.total ?? 0 });
  }
  const table = renderSweep(sweep(stored));
  await writeFile(join(dir, `tuning-${new Date().toISOString().replace(/[:.]/g, "-")}.md`), `# Threshold sweep: ${dir}\n\n${table}\n`);
  console.log(table);
  expect(stored.length).toBeGreaterThan(0);
});
