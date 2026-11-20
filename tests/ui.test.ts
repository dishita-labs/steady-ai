import { describe, expect, it } from "vitest";
import { html, safeHref } from "../src/ui/html";
import { renderApp, trail, type CaseView } from "../src/ui/view";
import type { CaseSnapshot } from "../src/lib/case/state";

const at = "2026-11-20T00:00:00.000Z";
const empty: CaseSnapshot = { images: [], hazards: [], questions: [], requirements: [], candidates: [], decisions: [], actions: [] };
const view = (over: Partial<CaseView> & { stage?: CaseView["case"]["stage"]; status?: CaseView["case"]["status"] } = {}): CaseView => ({
  ...empty,
  finished: false,
  ...over,
  case: { id: "case_1", createdAt: at, updatedAt: at, stage: over.stage ?? "CASE_CREATED", status: over.status ?? "in_progress", household: { notes: "<b>hi</b>" } },
});

describe("html escaping", () => {
  it("escapes interpolated text and attributes, but not nested templates", () => {
    expect(html`<p title="${'"x" onload=1'}">${"<script>alert(1)</script>"}${html`<b>ok</b>`}</p>`.value).toBe(
      '<p title="&quot;x&quot; onload=1">&lt;script&gt;alert(1)&lt;/script&gt;<b>ok</b></p>',
    );
  });
  it("only links http(s)", () => {
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("https://example.com/a")).toBe("https://example.com/a");
  });
  it("escapes a family's notes and a product title in the rendered app", () => {
    const out = renderApp(
      view({
        candidates: [{ id: "k", caseId: "case_1", requirementIds: [], title: "<img src=x onerror=alert(1)>", url: "javascript:x", attributes: [], evidenceIds: [], discoveredBy: { provider: "exa", query: "q", at }, status: "discovered" }],
      }),
    ).value;
    expect(out).not.toContain("<img src=x");
    expect(out).not.toContain("<b>hi</b>");
    expect(out).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(out).not.toContain('href="javascript');
  });
});

describe("decision trail", () => {
  it("is all pending with no case", () => {
    expect(trail(null).every((s) => s.state === "pending")).toBe(true);
  });
  it("marks the first unfinished step active, then the rest pending", () => {
    const states = trail(view({ stage: "PHOTO_ANALYZED" })).map((s) => s.state);
    expect(states).toEqual(["done", "done", "active", "pending", "pending", "pending", "pending"]);
  });
  it("marks the stopped step failed", () => {
    const t = trail(view({ status: "failed" }));
    expect(t[0]).toMatchObject({ state: "failed" });
  });
});
