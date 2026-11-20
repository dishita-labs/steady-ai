import { describe, expect, it } from "vitest";
import { evaluateCandidate } from "../src/lib/rules/engine";
import type { ProductCandidate, ProductClassification, ShoppingRequirement } from "../src/types/domain";

const at = "2026-11-20T00:00:00.000Z";

const requirement: ShoppingRequirement = {
  id: "req_1",
  caseId: "case_1",
  ruleId: "R-test",
  hazardIds: ["haz_1"],
  productType: "grab_bar",
  mandatory: [
    { id: "c_len", attribute: "length_in", op: "gte", value: 16, unit: "in", rationale: "Long enough to grip" },
    { id: "c_mount", attribute: "mount_type", op: "eq", value: "screw-mounted", rationale: "No suction cups" },
  ],
  preferred: [],
  safetyCritical: true,
  installation: "professional_recommended",
  openQuestionIds: [],
  status: "ready",
};

function candidate(attrs: ProductCandidate["attributes"], extra: Partial<ProductCandidate> = {}): ProductCandidate {
  return {
    id: "cand_1",
    caseId: "case_1",
    requirementIds: ["req_1"],
    title: "Test product",
    url: "https://example.com/p",
    attributes: attrs,
    evidenceIds: attrs.map((a) => a.evidenceId),
    discoveredBy: { provider: "exa", query: "q", at },
    status: "discovered",
    ...extra,
  };
}

const good = [
  { name: "length_in", value: 18, unit: "in", evidenceId: "ev_1" },
  { name: "mount_type", value: "Screw-Mounted", evidenceId: "ev_2" },
];

describe("rules engine", () => {
  it("is eligible only when every mandatory constraint passes with evidence", () => {
    const d = evaluateCandidate({ id: "dec_1", requirement, candidate: candidate(good) });
    expect(d.outcome).toBe("eligible");
    expect(d.evidenceIds).toEqual(["ev_1", "ev_2"]);
    expect(d.notes.join(" ")).toMatch(/Safety-critical/);
  });

  it("rejects on any failed constraint", () => {
    const d = evaluateCandidate({
      id: "dec_2",
      requirement,
      candidate: candidate([good[0], { name: "mount_type", value: "suction", evidenceId: "ev_3" }]),
    });
    expect(d.outcome).toBe("rejected");
    expect(d.ruleResults.find((r) => r.attribute === "mount_type")?.outcome).toBe("fail");
  });

  it("needs verification when evidence is missing, never assumes a pass", () => {
    const d = evaluateCandidate({ id: "dec_3", requirement, candidate: candidate([good[0]]) });
    expect(d.outcome).toBe("needs_verification");
    expect(d.ruleResults.find((r) => r.attribute === "mount_type")?.outcome).toBe("unknown");
  });

  it("treats unit mismatches as unknown instead of converting", () => {
    const d = evaluateCandidate({
      id: "dec_4",
      requirement,
      candidate: candidate([{ name: "length_in", value: 45, unit: "cm", evidenceId: "ev_4" }, good[1]]),
    });
    expect(d.outcome).toBe("needs_verification");
  });

  it("lets a classifier concern downgrade eligible, but never upgrade a rejection", () => {
    const concern: ProductClassification = {
      id: "cls_1",
      caseId: "case_1",
      candidateId: "cand_1",
      requirementId: "req_1",
      answers: [{ questionId: "suitability", type: "choice", answer: "reject", probabilities: { reject: 0.8 } }],
      concern: true,
      evidenceIds: ["ev_2"],
      source: { provider: "sie-decide", at },
    };
    const down = evaluateCandidate({ id: "dec_5", requirement, candidate: candidate(good), classifications: [concern] });
    expect(down.outcome).toBe("needs_verification");
    expect(down.classificationIds).toEqual(["cls_1"]);

    const fine = { ...concern, concern: false };
    const bad = candidate([good[0], { name: "mount_type", value: "suction", evidenceId: "ev_3" }]);
    expect(evaluateCandidate({ id: "dec_6", requirement, candidate: bad, classifications: [fine] }).outcome).toBe(
      "rejected",
    );
  });

  it("flags unverified prices as possibly stale", () => {
    const d = evaluateCandidate({
      id: "dec_7",
      requirement,
      candidate: candidate(good, {
        price: { amount: 29.99, currency: "USD", observedAt: at, sourceUrl: "https://example.com/p", verified: false },
      }),
    });
    expect(d.notes.join(" ")).toMatch(/stale/);
  });
});
