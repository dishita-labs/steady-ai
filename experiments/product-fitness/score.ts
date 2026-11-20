/**
 * Evaluation: GLiNER's per-item reads against a reference (gold or silver, never mixed), and the
 * checklist ranking against the ranking the same rules give from the reference labels.
 * Every rate is reported with its denominator; a zero denominator is "undefined".
 */

import type { ProductChecklist } from "./checklist";
import type { Label } from "./labels";
import { sortRankings, type Outcome, type PageRanking } from "./rank";

export interface Confusion {
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  /** Pages where GLiNER had no usable read for the item. */
  noRead: number;
}

export const rate = (n: number, d: number) => (d === 0 ? "undefined" : `${n}/${d} (${Math.round((100 * n) / d)}%)`);

/** reads: url → itemId → P(yes) | null.  ref: url → itemId → label. Only labelled pairs count. */
export function itemConfusion(
  checklist: ProductChecklist,
  reads: Record<string, Record<string, number | null>>,
  ref: Record<string, Record<string, Label>>,
  yes: number,
): Record<string, Confusion> {
  const out: Record<string, Confusion> = {};
  for (const it of checklist.items) {
    const c: Confusion = { tp: 0, fp: 0, fn: 0, tn: 0, noRead: 0 };
    for (const [url, labels] of Object.entries(ref)) {
      const truth = labels[it.id];
      if (!truth || !(url in reads)) continue;
      const p = reads[url][it.id];
      if (p === null || p === undefined) {
        c.noRead++;
        continue;
      }
      const pred = p >= yes;
      if (pred && truth === "yes") c.tp++;
      else if (pred) c.fp++;
      else if (truth === "yes") c.fn++;
      else c.tn++;
    }
    out[it.id] = c;
  }
  return out;
}

export interface RankingAgreement {
  pages: number;
  /** Pages whose outcome (eligible / needs_verification / reject) matches the reference ranking's. */
  outcomeAgree: number;
  /** Model said eligible, reference says reject: the dangerous error. */
  eligibleButRejected: number;
  /** Of the model's top k, how many the reference calls eligible. */
  topK: { k: number; model: number; exaOrder: number; referenceEligible: number };
  confusion: Record<Outcome, Record<Outcome, number>>;
}

export function rankingAgreement(model: PageRanking[], reference: PageRanking[], k = 3): RankingAgreement {
  const refByUrl = new Map(reference.map((r) => [r.url, r]));
  const both = model.filter((m) => refByUrl.has(m.url));
  const outcomes: Outcome[] = ["eligible", "needs_verification", "reject"];
  const confusion = Object.fromEntries(outcomes.map((o) => [o, Object.fromEntries(outcomes.map((p) => [p, 0]))])) as RankingAgreement["confusion"];
  for (const m of both) confusion[refByUrl.get(m.url)!.outcome][m.outcome]++;
  const eligible = (url: string) => refByUrl.get(url)?.outcome === "eligible";
  const top = sortRankings(both).slice(0, k);
  const exaTop = [...both].sort((a, b) => a.exaRank - b.exaRank).slice(0, k);
  return {
    pages: both.length,
    outcomeAgree: both.filter((m) => refByUrl.get(m.url)!.outcome === m.outcome).length,
    eligibleButRejected: both.filter((m) => m.outcome === "eligible" && refByUrl.get(m.url)!.outcome === "reject").length,
    topK: { k, model: top.filter((r) => eligible(r.url)).length, exaOrder: exaTop.filter((r) => eligible(r.url)).length, referenceEligible: both.filter((m) => eligible(m.url)).length },
    confusion,
  };
}
