/**
 * Stage 3: deterministic checklist scoring and ranking. Pure.
 *
 * The same function ranks from GLiNER's reads or from human labels (P(yes) = 1 or 0), so the
 * evaluation compares two rankings produced by identical rules and only the reads differ.
 *
 * A page that isn't a single-product page (`productPageCheck` in collect.ts) is rejected first.
 * Per item:
 *   red_flag   read yes → reject
 *   gate       read yes, and (numeric) the parsed value passes → met
 *              numeric value parsed and fails → reject; otherwise not met → needs_verification
 *   preferred  met as for a gate (a failing value is just "not met") → adds `weight`
 * Outcome order: eligible > needs_verification > reject. Within an outcome: score, then gates
 * met, then Exa's own rank.
 */

import type { ChecklistItem, ProductChecklist } from "./checklist";
import { checkNumeric, type NumericOutcome } from "./extract";

export type ItemStatus = "met" | "not_met" | "failed_value" | "red_flag" | "unknown_read";
export type Outcome = "eligible" | "needs_verification" | "reject";

export interface ItemInput {
  /** P(yes) from GLiNER (max over chunks), or 1/0 from a label. null: no usable read. */
  pYes: number | null;
  /** Passages the numeric parser reads: chunks GLiNER flagged, or the whole page for labels. */
  evidence: string[];
}

export interface ItemResult {
  itemId: string;
  kind: ChecklistItem["kind"];
  status: ItemStatus;
  pYes: number | null;
  numeric?: NumericOutcome;
}

export interface PageRanking {
  url: string;
  title?: string;
  exaRank: number;
  outcome: Outcome;
  score: number;
  maxScore: number;
  gatesMet: number;
  gates: number;
  reasons: string[];
  items: ItemResult[];
}

export interface RankConfig {
  /** A read counts as yes when P(yes) ≥ this. */
  yes: number;
}
export const DEFAULT_RANK: RankConfig = { yes: 0.5 };

function itemResult(item: ChecklistItem, input: ItemInput | undefined, cfg: RankConfig): ItemResult {
  const pYes = input?.pYes ?? null;
  const base = { itemId: item.id, kind: item.kind, pYes };
  if (pYes === null) return { ...base, status: "unknown_read" };
  const yes = pYes >= cfg.yes;
  if (item.kind === "red_flag") return { ...base, status: yes ? "red_flag" : "not_met" };
  if (!yes) return { ...base, status: "not_met" };
  if (!item.numeric) return { ...base, status: "met" };
  const numeric = checkNumeric(input!.evidence, item.numeric);
  return { ...base, numeric, status: numeric.status === "pass" ? "met" : numeric.status === "fail" ? "failed_value" : "not_met" };
}

export function rankPage(
  checklist: ProductChecklist,
  /** `notProduct`: why the page isn't a single-product page, if it isn't. */
  page: { url: string; title?: string; exaRank: number; notProduct?: string },
  inputs: Record<string, ItemInput>,
  cfg: RankConfig = DEFAULT_RANK,
): PageRanking {
  const items = checklist.items.map((it) => itemResult(it, inputs[it.id], cfg));
  const byId = new Map(checklist.items.map((it) => [it.id, it]));
  const reasons: string[] = [];
  let outcome: Outcome = "eligible";
  if (page.notProduct) {
    outcome = "reject";
    reasons.push(`not a product page: ${page.notProduct}`);
  }
  for (const r of items) {
    const it = byId.get(r.itemId)!;
    if (r.status === "red_flag") {
      outcome = "reject";
      reasons.push(`red flag: ${it.label}`);
    } else if (it.kind === "gate" && r.status === "failed_value" && r.numeric?.status === "fail") {
      outcome = "reject";
      reasons.push(`fails: ${it.label} (found "${r.numeric.match}")`);
    }
  }
  if (outcome !== "reject") {
    for (const r of items) {
      const it = byId.get(r.itemId)!;
      if (it.kind === "gate" && r.status !== "met") {
        outcome = "needs_verification";
        reasons.push(`not shown: ${it.label}`);
      }
    }
  }
  const preferred = checklist.items.filter((it) => it.kind === "preferred");
  const score = items.filter((r) => r.kind === "preferred" && r.status === "met").reduce((n, r) => n + byId.get(r.itemId)!.weight, 0);
  const gates = checklist.items.filter((it) => it.kind === "gate");
  return {
    url: page.url,
    title: page.title,
    exaRank: page.exaRank,
    outcome,
    score,
    maxScore: preferred.reduce((n, it) => n + it.weight, 0),
    gatesMet: items.filter((r) => r.kind === "gate" && r.status === "met").length,
    gates: gates.length,
    reasons,
    items,
  };
}

const ORDER: Record<Outcome, number> = { eligible: 0, needs_verification: 1, reject: 2 };

export function sortRankings(rs: PageRanking[]): PageRanking[] {
  return [...rs].sort((a, b) => ORDER[a.outcome] - ORDER[b.outcome] || b.score - a.score || b.gatesMet - a.gatesMet || a.exaRank - b.exaRank);
}
