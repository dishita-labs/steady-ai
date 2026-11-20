/**
 * GLiNER question-format probe: which `outputSchema` shape gives Decide clear, correct answers on
 * unambiguous sentences? Real calls (cached), tiny. Not a dataset result.
 *
 *   HAZARD_PROBE=1 fnox exec -- aube exec vitest run --config experiments/hazard-classification/vitest.config.mts
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { it } from "vitest";
import { getProductDecider, type DecideQuestion } from "../../src/lib/product-decisions";
import { loadDevelopmentSet, mimeTypeFor } from "./dataset";
import { observe } from "./observe";
import { installRecorder } from "./record";

const OUT = join(".data", "experiments", "hazard-classification");

const TEXTS: Record<string, { text: string; expect: string }> = {
  no_rail: { text: "Steps: four concrete steps lead up to the front door. Neither side of the steps has a handrail.", expect: "hazard" },
  both_rails: { text: "Steps: four concrete steps lead up to the front door. A metal handrail runs along both sides of the steps.", expect: "no_hazard" },
  window: { text: "Window: a double-pane window with white frames, on the house wall to the left of the door.", expect: "unrelated" },
  steps_silent: { text: "Steps: four concrete steps leading up to the door, in front of the door.", expect: "unclear" },
};

const FORMATS: Record<string, Record<string, DecideQuestion>> = {
  // Round-1 format, as it was (grouped 4-way choice with described criteria).
  choice_described: {
    H02: {
      type: "choice",
      instructions: "What does this observation say about the sides of stairs or steps?",
      criteria: {
        hazard: "A side of the stairs or steps has no handrail, or there is a handrail on only one side.",
        no_hazard: "Both sides of the stairs or steps are described and each has a handrail.",
        unclear: "It is about the sides of stairs or steps but does not say enough to tell.",
        unrelated: "It is not about the sides of stairs or steps.",
      },
    },
  },
  choice_labels: { H02: { type: "choice", instructions: "What does this text say about handrails on the stairs or steps?", criteria: ["no handrail on a side", "handrails on both sides", "handrails not mentioned", "not about stairs"] } },
  noul: {
    about: { type: "noul", instructions: "Is this text about stairs or steps?" },
    hazard: { type: "noul", instructions: "Does the text say a side of the stairs or steps has no handrail?" },
    clear: { type: "noul", instructions: "Does the text say there is a handrail on both sides of the stairs or steps?" },
  },
};

/** Round 2: can any wording carry an ABSENCE through Decide? */
const NEGATION_TEXTS: Record<string, { text: string; expect: string }> = {
  none_plain: { text: "Steps: four concrete steps lead up to the front door. There is no handrail.", expect: "hazard" },
  without: { text: "Steps: four concrete steps without handrails lead up to the front door.", expect: "hazard" },
  one_side: { text: "Stairs: a wooden banister runs along the left side. The right side is a plain wall.", expect: "hazard" },
  sides_nothing: { text: "Steps: four concrete steps. Left side: nothing. Right side: nothing.", expect: "hazard" },
  both_rails: TEXTS.both_rails,
  steps_silent: TEXTS.steps_silent,
};
const NEGATION_FORMATS: Record<string, Record<string, DecideQuestion>> = {
  noul_missing: { q: { type: "noul", instructions: "Is a handrail missing from the stairs or steps?" } },
  noul_without: { q: { type: "noul", instructions: "Are the stairs or steps without a handrail on at least one side?" } },
  noul_present: { q: { type: "noul", instructions: "Does the text mention a handrail, railing or banister?" } },
};

/** Observation-only probe: what does the current Gemma prompt return for a few dev images? */
it.skipIf(!process.env.HAZARD_PROBE_OBSERVE)("Gemma observation probe", { timeout: 10 * 60 * 1000 }, async () => {
  installRecorder(join(OUT, "cache"));
  const dev = await loadDevelopmentSet();
  for (const id of process.env.HAZARD_PROBE_OBSERVE!.split(",")) {
    const img = dev.find((d) => d.imageId === id.trim());
    if (!img) throw new Error(`${id} is not a development image.`);
    const o = await observe({ bytes: new Uint8Array(await readFile(img.file)), mimeType: mimeTypeFor(img.file), room: img.room });
    console.log(`== ${img.imageId} ok=${o.ok} ${o.error ?? ""}`);
    for (const x of o.output?.observations ?? []) {
      console.log(`${x.id} [${x.visibility}] ${x.feature}: ${x.description}`);
      for (const p of x.parts) console.log(`    - ${p.part} [${p.visibility}]: ${JSON.stringify(p.items)}`);
    }
  }
});

it.skipIf(process.env.HAZARD_PROBE !== "1")("GLiNER format probe", { timeout: 10 * 60 * 1000 }, async () => {
  installRecorder(join(OUT, "cache"));
  const decider = getProductDecider();
  const rows: Record<string, unknown>[] = [];
  const rounds: [Record<string, Record<string, DecideQuestion>>, Record<string, { text: string; expect: string }>][] =
    process.env.HAZARD_PROBE_ROUND === "2" ? [[NEGATION_FORMATS, NEGATION_TEXTS]] : [[FORMATS, TEXTS]];
  for (const [formats, texts] of rounds) for (const [fmt, questions] of Object.entries(formats)) {
    for (const [name, t] of Object.entries(texts)) {
      const res = await decider.decide({ text: t.text, questions });
      rows.push({ fmt, text: name, expect: t.expect, answers: res.answers.map((a) => ({ q: a.questionId, answer: a.answer, p: a.probabilities })) });
      console.log(fmt.padEnd(17), name.padEnd(13), `expect ${t.expect.padEnd(10)}`, res.answers.map((a) => `${a.questionId}=${a.answer} ${JSON.stringify(Object.fromEntries(Object.entries(a.probabilities).map(([k, v]) => [k, Math.round(v * 100) / 100])))}`).join("  "));
    }
  }
  await mkdir(join(OUT, "probes"), { recursive: true });
  await writeFile(join(OUT, "probes", `gliner-format-${new Date().toISOString().replace(/[:.]/g, "-")}.json`), JSON.stringify(rows, null, 2));
});
