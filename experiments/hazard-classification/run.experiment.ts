/**
 * Runs approach A (production Gemma-only analyzer) and approach B (Gemma observations → GLiNER
 * Decide → validation) on the DEVELOPMENT images and writes everything to local JSON.
 *
 *   HAZARD_EXPERIMENT=1 fnox exec -- aube exec vitest run --config experiments/hazard-classification/vitest.config.mts
 *
 * Env: SIE_API_KEY (required), STEADY_PREP_DIR (default ../steady-prep),
 *      HAZARD_IMAGES=STD-D01,STD-D03 (default: priority D01,D03,D04,D07,D09, then the rest).
 * Output: .data/experiments/hazard-classification/<run>/ (git-ignored). Model calls are cached in
 *         .data/experiments/hazard-classification/cache/, so reruns don't repeat them.
 * Needs no SingleStore, Firedrill, Exa, Hono or Workflow SDK.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { missingEnv } from "../../src/lib/config";
import { deriveRequirements } from "../../src/lib/rules/requirements";
import { getVisionAnalyzer, validateVisionResult, type VisionAnalysisResult } from "../../src/lib/vision";
import type { HazardCategoryId, HazardFinding, UploadedImage } from "../../src/types/domain";
import { classifyObservations } from "./classify";
import { loadDevelopmentSet, mimeTypeFor, type DevRecord } from "./dataset";
import { observe } from "./observe";
import { installRecorder } from "./record";
import { renderReport } from "./report";
import { score, type ImagePrediction } from "./score";
import { traceProblems, validateClassifications } from "./validate";

const enabled = process.env.HAZARD_EXPERIMENT === "1";
const PRIORITY = ["STD-D01", "STD-D03", "STD-D04", "STD-D07", "STD-D09"];
const OUT = join(".data", "experiments", "hazard-classification");

function requirementsFrom(r: VisionAnalysisResult, imageId: string): number {
  const hazards: HazardFinding[] = r.findings.map((f, i) => ({ ...f, id: `haz_${i}`, caseId: "experiment", imageId, source: r.source }));
  return deriveRequirements("experiment", hazards).requirements.length;
}

function presentWithoutEvidence(r: VisionAnalysisResult): HazardCategoryId[] {
  return (Object.keys(r.categoryLabels) as HazardCategoryId[]).filter(
    (c) => r.categoryLabels[c] === "present" && !r.findings.some((f) => f.category === c && f.label === "present" && f.visibleEvidence.some((e) => e.trim())),
  );
}

it.skipIf(!enabled)("hazard classification experiment (development images, real SIE calls)", { timeout: 60 * 60 * 1000 }, async () => {
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
  const rowsA: ImagePrediction[] = [];
  const rowsB: ImagePrediction[] = [];

  for (const img of images) {
    const bytes = new Uint8Array(await readFile(img.file));
    const mimeType = mimeTypeFor(img.file);
    const uploaded: UploadedImage = {
      id: img.imageId, caseId: "experiment", storageKey: img.file, mimeType, sha256: createHash("sha256").update(bytes).digest("hex"),
      room: img.room, consentConfirmed: true, uploadedAt: new Date().toISOString(), analysisStatus: "pending",
    };

    // A: production analyzer, unchanged.
    let mark = rec.count;
    const a: Record<string, unknown> = {};
    let resultA: VisionAnalysisResult | undefined;
    try {
      resultA = await getVisionAnalyzer().analyze({ image: uploaded, bytes });
      a.labels = resultA.categoryLabels;
      a.findings = resultA.findings;
      a.uncertainties = resultA.uncertainties;
      a.problems = validateVisionResult(resultA);
    } catch (e) {
      a.error = e instanceof Error ? e.message : String(e);
    }
    a.calls = rec.since(mark);
    const latA = rec.since(mark).reduce((n, c) => n + c.latencyMs, 0);
    a.latencyMs = latA;
    const validA = resultA && (a.problems as string[]).length === 0;
    rowsA.push({
      imageId: img.imageId, gt: img.labels, pred: validA ? resultA!.categoryLabels : null,
      presentWithoutEvidence: resultA ? presentWithoutEvidence(resultA) : [], requirementCount: validA ? requirementsFrom(resultA!, img.imageId) : 0, latencyMs: latA,
    });

    // B: observations → GLiNER → validation.
    mark = rec.count;
    const b: Record<string, unknown> = {};
    const o = await observe({ bytes, mimeType, room: img.room });
    b.observe = { ok: o.ok, error: o.error, model: o.model, raw: o.raw };
    let resultB: ReturnType<typeof validateClassifications> | undefined;
    const tObs = rec.since(mark).reduce((n, c) => n + c.latencyMs, 0);
    let tCls = 0;
    if (o.ok && o.output) {
      b.observations = o.output;
      const markCls = rec.count;
      const t0 = performance.now();
      const cls = await classifyObservations(o.output);
      const clsCalls = rec.since(markCls);
      // Wall clock when every call was live; sum of recorded latencies / concurrency is not used.
      tCls = clsCalls.every((c) => !c.cached) ? Math.round(performance.now() - t0) : clsCalls.reduce((n, c) => n + c.latencyMs, 0);
      b.classifyCalls = cls.calls;
      b.answers = cls.answers;
      resultB = validateClassifications(o.output, cls.answers, { provider: "sie-decide", model: "experiment:gemma-observe+gliner-decide", at: new Date().toISOString() });
      b.labels = resultB.categoryLabels;
      b.trace = resultB.trace;
      b.findings = resultB.findings;
      b.downgradedHazardReads = resultB.downgradedHazardReads;
      b.problems = [...validateVisionResult(resultB), ...traceProblems(resultB, o.output)];
      b.invalidClassifications = cls.answers.filter((x) => x.label === "invalid").length;
    }
    b.calls = rec.since(mark).map((c) => ({ ...c, response: c.method === "extract" ? c.response : undefined })); // Gemma raw is in observe.raw
    const extractCalls = rec.since(mark).filter((c) => c.method === "extract");
    b.latencyMs = {
      observe: tObs,
      classify: tCls,
      classifyMeasuredAs: extractCalls.every((c) => !c.cached) ? "wall clock, 4 concurrent calls" : "sum of call latencies (cached rerun)",
      classifySumOfCalls: extractCalls.reduce((n, c) => n + c.latencyMs, 0),
      total: tObs + tCls,
      classifyCalls: extractCalls.length,
    };
    const validB = resultB && (b.problems as string[]).length === 0;
    rowsB.push({
      imageId: img.imageId, gt: img.labels, pred: validB ? resultB!.categoryLabels : null,
      presentWithoutEvidence: resultB ? presentWithoutEvidence(resultB) : [], requirementCount: validB ? requirementsFrom(resultB!, img.imageId) : 0, latencyMs: tObs + tCls,
    });

    await writeFile(join(dir, "images", `${img.imageId}.json`), JSON.stringify({ imageId: img.imageId, room: img.room, caseType: img.caseType, gt: img.labels, gtEvidence: img.visibleEvidence, baseline: a, experiment: b }, null, 2));
    console.log(`${img.imageId}: A ${validA ? "ok" : "invalid"} ${latA}ms | B ${validB ? "ok" : "invalid"} ${tObs + tCls}ms`);
  }

  const summary = { run, images: images.map((i) => i.imageId), baseline: score(rowsA), experiment: score(rowsB), rows: { baseline: rowsA, experiment: rowsB } };
  await writeFile(join(dir, "summary.json"), JSON.stringify(summary, null, 2));
  await writeFile(join(dir, "report.md"), renderReport(summary));
  console.log(`Results: ${dir}`);
  expect(rowsA.length).toBe(images.length);
});
