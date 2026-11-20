import { describe, expect, it } from "vitest";
import { createAuditEvent } from "@/lib/audit";
import { IntegrationUnavailableError } from "@/lib/integrations";
import { getProductSearchProvider } from "@/lib/product-search";
import { approve, executeApproved, ApprovalRequiredError, type ShoppingAdapter } from "@/lib/shopping";
import { validateVisionResult, type VisionAnalysisResult } from "@/lib/vision";
import { HAZARD_CATEGORIES, type HazardCategoryId, type ShoppingAction } from "@/types/domain";

const at = "2026-11-20T00:00:00.000Z";

describe("shopping approval guard", () => {
  const adapter: ShoppingAdapter = {
    name: "test",
    simulated: true,
    prepare: async () => {
      throw new Error("unused");
    },
    execute: async (a) => ({ ...a, status: "executed" }),
  };
  const pending: ShoppingAction = {
    id: "act_1",
    caseId: "c",
    type: "prepare_cart",
    candidateIds: ["cand_1"],
    decisionIds: ["dec_1"],
    status: "awaiting_approval",
    simulated: true,
    adapter: "test",
    createdAt: at,
    updatedAt: at,
  };

  it("refuses to execute without explicit approval", async () => {
    await expect(executeApproved(adapter, pending)).rejects.toBeInstanceOf(ApprovalRequiredError);
  });

  it("executes after approval and records who approved", async () => {
    const approved = approve(pending, "user_1");
    expect(approved.approval?.method).toBe("explicit_user_confirmation");
    expect((await executeApproved(adapter, approved)).status).toBe("executed");
  });
});

describe("integration boundaries", () => {
  it("throw a clear error instead of returning placeholder data", async () => {
    expect(() => getProductSearchProvider().search({ requirementId: "r", query: "grab bar" })).toThrow(
      IntegrationUnavailableError,
    );
  });
});

describe("audit events", () => {
  it("rejects secrets and hidden reasoning", () => {
    const base = { caseId: "c", type: "case.created" as const, actor: { kind: "system" as const, id: "s" }, stage: "CASE_CREATED" as const, summary: "x" };
    expect(createAuditEvent(base).id).toMatch(/^evt_/);
    expect(() => createAuditEvent({ ...base, data: { headers: { Authorization: "x" } } })).toThrow();
    expect(() => createAuditEvent({ ...base, data: { reasoning: "..." } })).toThrow();
  });
});

describe("vision output contract", () => {
  const labels = Object.fromEntries(
    (Object.keys(HAZARD_CATEGORIES) as HazardCategoryId[]).map((id) => [id, "absent"]),
  ) as VisionAnalysisResult["categoryLabels"];
  const result = (over: Partial<VisionAnalysisResult>): VisionAnalysisResult => ({
    categoryLabels: labels,
    findings: [],
    uncertainties: [],
    humanAssessmentRequired: false,
    source: { provider: "vision", at },
    ...over,
  });

  it("accepts a complete, evidence-backed result", () => {
    expect(validateVisionResult(result({}))).toEqual([]);
  });

  it("rejects 'present' without visible evidence", () => {
    const r = result({
      categoryLabels: { ...labels, H09: "present" },
      findings: [
        {
          category: "H09",
          label: "present",
          summary: "No grab bar by tub",
          visibleEvidence: [],
          severity: "high",
          notEstablishedFromPhoto: [],
          humanAssessmentRequired: false,
          professionalAssessmentRecommended: true,
        },
      ],
    });
    expect(validateVisionResult(r).join(" ")).toMatch(/without visible evidence/);
  });
});
