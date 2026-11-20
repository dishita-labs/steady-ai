/**
 * Turn one product type's stored run (pages, verified sheets, GLiNER reads from both sources)
 * into rankings, scores and a Markdown report. No model calls, so it serves both the live run and
 * the re-score mode.
 *
 * Reference labels (silver and gold) describe what the SELLER states, so silver is computed on
 * the verified sheet. Both read sources are scored against the same reference: the comparison
 * shows what reading the whole page (reviews, Q&A, other products) adds or breaks.
 */

import { questionsOf, type ProductChecklist } from "./checklist";
import { productPageCheck, readText, type CollectedPage, type ReadSource, type SearchRecord } from "./collect";
import { maxYes, type DecideRun } from "./decide";
import { parseQuantity } from "./extract";
import { silverLabel, type GoldFile, type Label } from "./labels";
import { DEFAULT_RANK, rankPage, sortRankings, type ItemInput, type PageRanking, type RankConfig } from "./rank";
import { itemConfusion, rankingAgreement, rate, type Confusion, type RankingAgreement } from "./score";

export interface StoredProductRun {
  productType: ProductChecklist["productType"];
  searches: SearchRecord[];
  pages: CollectedPage[];
  decide: Record<ReadSource, DecideRun>;
}

export interface SourceAnalysis {
  model: PageRanking[];
  silverItems: Record<string, Confusion>;
  silverRanking: RankingAgreement;
  gold?: { pages: number; items: Record<string, Confusion>; ranking?: RankingAgreement };
}

export interface ProductAnalysis {
  bySource: Record<ReadSource, SourceAnalysis>;
  /** url → reason the page is not a single-product page. */
  excluded: Record<string, string>;
  sweep: { yes: number; silverOutcomeAgree: number; goldOutcomeAgree?: number; eligibleButRejected: number }[];
  /** Numeric items where the parser finds a value in the sheet but GLiNER flagged no chunk. */
  missedNumbers: { url: string; itemId: string; match: string }[];
  /** Pages whose outcome differs between reading the sheet and reading the whole page. */
  sourceDiffs: { url: string; title?: string; sheet: PageRanking; page: PageRanking }[];
  template: Record<string, unknown>;
}

/**
 * Evidence for the numeric parser:
 *   sheet  the whole verified sheet. It holds seller text only, so a number anywhere in it is the
 *          seller's. (Reading only the flagged chunks lost Vive's "Supporting up to 440 pounds":
 *          GLiNER flagged the shipping-weight chunk at 0.98 and that one at 0.46.)
 *   page   only the chunks GLiNER flagged, because the rest of a page includes reviews.
 */
function modelInputs(decide: DecideRun, url: string, cfg: RankConfig, source: ReadSource): Record<string, ItemInput> {
  const chunks = decide.chunks[url] ?? [];
  const out: Record<string, ItemInput> = {};
  for (const r of decide.reads.filter((x) => x.url === url)) {
    const flagged = r.chunks.filter((c) => c.pYes !== null && c.pYes >= cfg.yes).map((c) => chunks[c.chunk]);
    out[r.itemId] = { pYes: maxYes(r), evidence: source === "sheet" ? [chunks.join("\n")] : flagged };
  }
  return out;
}

function labelInputs(labels: Record<string, Label>, text: string): Record<string, ItemInput> {
  return Object.fromEntries(Object.entries(labels).map(([id, l]) => [id, { pYes: l === "yes" ? 1 : 0, evidence: [text] }]));
}

export function analyze(checklist: ProductChecklist, run: StoredProductRun, gold: GoldFile, cfg: RankConfig = DEFAULT_RANK): ProductAnalysis {
  const excluded: Record<string, string> = {};
  for (const p of run.pages) {
    const c = productPageCheck(p);
    if (!c.ok) excluded[p.url] = c.reason;
  }
  const meta = (p: CollectedPage) => ({ url: p.url, title: p.sheet?.productName || p.title, exaRank: p.exaRank, notProduct: excluded[p.url] });
  const sheet = Object.fromEntries(run.pages.map((p) => [p.url, readText(p, "sheet")]));
  const rankWith = (source: ReadSource, c: RankConfig) => sortRankings(run.pages.map((p) => rankPage(checklist, meta(p), modelInputs(run.decide[source], p.url, c, source), c)));

  // References: seller-stated facts, so read from the verified sheet. Excluded pages carry no labels.
  const products = run.pages.filter((p) => !excluded[p.url]);
  const silverLabels: Record<string, Record<string, Label>> = {};
  const snippets: Record<string, Record<string, string | undefined>> = {};
  for (const p of products) {
    silverLabels[p.url] = {};
    snippets[p.url] = {};
    for (const it of checklist.items) {
      const s = silverLabel(it.id, sheet[p.url]);
      silverLabels[p.url][it.id] = s.label;
      snippets[p.url][it.id] = s.snippet;
    }
  }
  const silverRankings = sortRankings(products.map((p) => rankPage(checklist, meta(p), labelInputs(silverLabels[p.url], sheet[p.url]))));
  const goldLabels = Object.fromEntries(
    Object.entries(gold.pages).filter(([url, g]) => g.productType === checklist.productType && products.some((p) => p.url === url)).map(([url, g]) => [url, g.items]),
  );
  const complete = Object.entries(goldLabels).filter(([, items]) => checklist.items.every((it) => it.id in items));
  const goldRankings = sortRankings(complete.map(([url, items]) => rankPage(checklist, meta(products.find((p) => p.url === url)!), labelInputs(items, sheet[url]))));

  const bySource = {} as Record<ReadSource, SourceAnalysis>;
  for (const source of ["sheet", "page"] as const) {
    const model = rankWith(source, cfg);
    const productModel = model.filter((r) => !excluded[r.url]);
    const reads = Object.fromEntries(products.map((p) => [p.url, Object.fromEntries(run.decide[source].reads.filter((r) => r.url === p.url).map((r) => [r.itemId, maxYes(r)]))]));
    bySource[source] = {
      model,
      silverItems: itemConfusion(checklist, reads, silverLabels, cfg.yes),
      silverRanking: rankingAgreement(productModel, silverRankings),
      gold: Object.keys(goldLabels).length
        ? { pages: Object.keys(goldLabels).length, items: itemConfusion(checklist, reads, goldLabels, cfg.yes), ranking: goldRankings.length ? rankingAgreement(productModel, goldRankings) : undefined }
        : undefined,
    };
  }

  const sweep = [0.3, 0.5, 0.7].map((yes) => {
    const m = rankWith("sheet", { yes }).filter((r) => !excluded[r.url]);
    const s = rankingAgreement(m, silverRankings);
    const g = goldRankings.length ? rankingAgreement(m, goldRankings) : undefined;
    return { yes, silverOutcomeAgree: s.outcomeAgree, goldOutcomeAgree: g?.outcomeAgree, eligibleButRejected: (g ?? s).eligibleButRejected };
  });

  const missedNumbers: ProductAnalysis["missedNumbers"] = [];
  for (const it of checklist.items.filter((x) => x.numeric)) {
    for (const p of products) {
      const r = bySource.sheet.model.find((x) => x.url === p.url)!.items.find((x) => x.itemId === it.id)!;
      if (r.status !== "not_met" || (r.pYes ?? 0) >= cfg.yes) continue;
      const found = parseQuantity(sheet[p.url], it.numeric!.quantity)[0];
      if (found) missedNumbers.push({ url: p.url, itemId: it.id, match: found.match });
    }
  }

  const sourceDiffs = products
    .map((p) => ({ url: p.url, title: p.sheet?.productName || p.title, sheet: bySource.sheet.model.find((r) => r.url === p.url)!, page: bySource.page.model.find((r) => r.url === p.url)! }))
    .filter((d) => d.sheet.outcome !== d.page.outcome);

  const sheetReads = (url: string, id: string) => maxYes(run.decide.sheet.reads.find((r) => r.url === url && r.itemId === id)!);
  const template = Object.fromEntries(
    products.map((p) => [
      p.url,
      {
        productType: checklist.productType,
        title: p.sheet?.productName || p.title,
        labeledBy: "",
        at: "",
        items: Object.fromEntries(checklist.items.map((it) => [it.id, silverLabels[p.url][it.id]])),
        _help: {
          rule: "Label what the SELLER states (description and specs), not reviews or Q&A.",
          sheet: sheet[p.url],
          ...Object.fromEntries(checklist.items.map((it) => [it.id, { question: questionsOf(it).join(" / "), gliner: sheetReads(p.url, it.id), keyword: snippets[p.url][it.id] ?? null }])),
        },
      },
    ]),
  );

  return { bySource, excluded, sweep, missedNumbers, sourceDiffs, template };
}

const short = (s: string | undefined, n = 60) => {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return (t.length > n ? `${t.slice(0, n - 1)}…` : t).replace(/\|/g, "/");
};
const p2 = (p: number | null) => (p === null ? "—" : p.toFixed(2));

function confusionTable(checklist: ProductChecklist, items: Record<string, Confusion>): string {
  const rows = checklist.items.map((it) => {
    const c = items[it.id];
    return `| ${it.id} | ${it.kind} | ${c.tp} | ${c.fp} | ${c.fn} | ${c.tn} | ${c.noRead} | ${rate(c.tp, c.tp + c.fp)} | ${rate(c.tp, c.tp + c.fn)} |`;
  });
  return ["| item | kind | TP | FP | FN | TN | no read | precision | recall |", "|---|---|---|---|---|---|---|---|---|", ...rows].join("\n");
}

function agreementLines(a: RankingAgreement): string {
  return [
    `- Outcome agreement: ${rate(a.outcomeAgree, a.pages)}`,
    `- **Model "eligible" where the reference says "reject": ${a.eligibleButRejected}**`,
    `- Top ${a.topK.k} that the reference calls eligible: checklist ranking ${rate(a.topK.model, Math.min(a.topK.k, a.pages))}, Exa's order ${rate(a.topK.exaOrder, Math.min(a.topK.k, a.pages))} (reference has ${a.topK.referenceEligible} eligible page(s))`,
    "",
    "| reference ↓ / model → | eligible | needs_verification | reject |",
    "|---|---|---|---|",
    ...(["eligible", "needs_verification", "reject"] as const).map((r) => `| ${r} | ${a.confusion[r].eligible} | ${a.confusion[r].needs_verification} | ${a.confusion[r].reject} |`),
  ].join("\n");
}

export function renderProduct(checklist: ProductChecklist, run: StoredProductRun, a: ProductAnalysis): string {
  const lines: string[] = [];
  const products = run.pages.filter((p) => !a.excluded[p.url]);
  lines.push(`## ${checklist.productType} (${checklist.ruleId})`, "");
  lines.push(`**Exa searches** (shops: ${run.searches[0]?.includeDomains.join(", ") || "any"})`, "", "| query | results | cached | ms |", "|---|---|---|---|");
  for (const s of run.searches) lines.push(`| ${s.query} | ${s.results} | ${s.cached ? "yes" : "no"} | ${s.latencyMs} |`);
  const quotes = run.pages.reduce((n, p) => n + (p.sheet?.quotes ?? 0), 0);
  const dropped = run.pages.flatMap((p) => (p.sheet?.dropped ?? []).map((d) => ({ url: p.url, d })));
  lines.push(
    "",
    `${run.pages.length} unique pages with text, **${products.length} single-product pages**. Sheet quotes verified verbatim: ${rate(quotes - dropped.length, quotes)}.`,
    `GLiNER requests: sheet ${run.decide.sheet.requests} (${run.decide.sheet.failedRequests.length} failed), page ${run.decide.page.requests} (${run.decide.page.failedRequests.length} failed).`,
    "",
  );
  if (Object.keys(a.excluded).length) {
    lines.push("**Not single-product pages (excluded before reading)**", "");
    for (const [url, why] of Object.entries(a.excluded)) lines.push(`- ${why}: ${url}`);
    lines.push("");
  }
  if (dropped.length) {
    lines.push("**Sheet quotes dropped (not verbatim on the page)**", "");
    for (const x of dropped.slice(0, 15)) lines.push(`- "${short(x.d, 100)}" on ${x.url}`);
    if (dropped.length > 15) lines.push(`- … and ${dropped.length - 15} more`);
    lines.push("");
  }

  const s = a.bySource.sheet;
  lines.push("**Checklist ranking (GLiNER reads the verified seller sheet)**", "", "| # | product | outcome | score | gates | Exa # | why |", "|---|---|---|---|---|---|---|");
  s.model.filter((r) => !a.excluded[r.url]).forEach((r, i) => lines.push(`| ${i + 1} | [${short(r.title, 50) || short(r.url, 50)}](${r.url}) | ${r.outcome} | ${r.score}/${r.maxScore} | ${r.gatesMet}/${r.gates} | ${r.exaRank} | ${short(r.reasons.join("; "), 90)} |`));
  lines.push("");

  lines.push("**Per-item reads from the sheet (max P(yes) over chunks)**", "", `| product | ${checklist.items.map((it) => it.id.split(".")[1]).join(" | ")} |`, `|---|${checklist.items.map(() => "---").join("|")}|`);
  for (const r of s.model.filter((x) => !a.excluded[x.url])) lines.push(`| ${short(r.title, 30) || short(r.url, 30)} | ${r.items.map((x) => `${p2(x.pYes)}${x.status === "met" ? " ✓" : x.status === "red_flag" ? " ⚑" : x.status === "failed_value" ? " ✗" : ""}`).join(" | ")} |`);
  lines.push("", "✓ met · ⚑ red flag · ✗ value stated but outside the threshold", "");

  lines.push(`**Sheet vs whole page:** ${a.sourceDiffs.length} of ${products.length} products change outcome when GLiNER reads the whole page (reviews, Q&A, related products) instead of the seller sheet.`, "");
  if (a.sourceDiffs.length) {
    lines.push("| product | sheet | whole page | whole-page reasons |", "|---|---|---|---|");
    for (const d of a.sourceDiffs) lines.push(`| [${short(d.title, 45)}](${d.url}) | ${d.sheet.outcome} | ${d.page.outcome} | ${short(d.page.reasons.join("; "), 80)} |`);
    lines.push("");
  }

  for (const source of ["sheet", "page"] as const) {
    const x = a.bySource[source];
    const name = source === "sheet" ? "GLiNER on the seller sheet" : "GLiNER on the whole page";
    if (x.gold) {
      lines.push(`**${name} vs gold labels (${x.gold.pages} labelled page(s))**`, "", confusionTable(checklist, x.gold.items), "");
      if (x.gold.ranking) lines.push(agreementLines(x.gold.ranking), "");
    }
    lines.push(`**${name} vs silver labels** (keyword matches on the seller sheet: a sanity check, not ground truth)`, "", confusionTable(checklist, x.silverItems), "", agreementLines(x.silverRanking), "");
  }
  if (!s.gold) lines.push("**Gold labels:** none for this product type yet. Fill `labels.json` from `labels-template.json`.", "");

  lines.push("**Threshold sweep, sheet reads** (no new calls)", "", "| P(yes) ≥ | outcome agreement (silver) | outcome agreement (gold) | eligible-but-reject |", "|---|---|---|---|");
  for (const w of a.sweep) lines.push(`| ${w.yes}${w.yes === DEFAULT_RANK.yes ? " (default)" : ""} | ${w.silverOutcomeAgree}/${products.length} | ${w.goldOutcomeAgree ?? "—"} | ${w.eligibleButRejected} |`);
  lines.push("");

  if (a.missedNumbers.length) {
    lines.push("**Numbers GLiNER didn't point at** (the parser finds them in the sheet, but no chunk got P(yes) ≥ threshold)", "");
    for (const m of a.missedNumbers) lines.push(`- ${m.itemId}: "${m.match}" on ${m.url}`);
    lines.push("");
  }
  return lines.join("\n");
}
