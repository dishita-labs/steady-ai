import { describe, expect, it } from "vitest";
import { checkGate, deriveStatus, tryAdvance, type CaseSnapshot } from "@/lib/agent/workflow";
import type { ShoppingAction, ShoppingRequirement } from "@/types/domain";

const at = "2026-11-20T00:00:00.000Z";
const empty: CaseSnapshot = {
  images: [],
  hazards: [],
  questions: [],
  requirements: [],
  candidates: [],
  decisions: [],
  actions: [],
};

const req = (id: string, status: ShoppingRequirement["status"]): ShoppingRequirement => ({
  id,
  caseId: "c",
  hazardIds: [],
  productType: "x",
  mandatory: [],
  preferred: [],
  safetyCritical: false,
  installation: "none",
  openQuestionIds: [],
  status,
});

const action = (status: ShoppingAction["status"], approved = false): ShoppingAction => ({
  id: "act_1",
  caseId: "c",
  type: "prepare_cart",
  candidateIds: [],
  decisionIds: [],
  status,
  simulated: true,
  adapter: "test",
  approval: approved ? { approvedBy: "u", approvedAt: at, method: "explicit_user_confirmation" } : undefined,
  createdAt: at,
  updatedAt: at,
});

describe("workflow", () => {
  it("does not advance past CASE_CREATED until a photo is analyzed", () => {
    const r = tryAdvance("CASE_CREATED", empty);
    expect(r.advanced).toBe(false);
    expect(r.blockers[0]).toMatch(/photo/);
  });

  it("lets one ready requirement proceed while another waits for context", () => {
    const s = { ...empty, requirements: [req("r1", "ready"), req("r2", "needs_context")] };
    expect(checkGate("REQUIREMENTS_DEFINED", s).ok).toBe(true);
  });

  it("reports needs_input when every requirement is waiting on the user", () => {
    const s: CaseSnapshot = {
      ...empty,
      requirements: [req("r2", "needs_context")],
      questions: [{ id: "q", caseId: "c", question: "Wall type?", field: "wall_type", status: "open", askedAt: at }],
    };
    expect(checkGate("REQUIREMENTS_DEFINED", s).ok).toBe(false);
    expect(deriveStatus("PHOTO_ANALYZED", s)).toBe("needs_input");
  });

  it("only completes after an approved action is executed", () => {
    expect(checkGate("ACTION_COMPLETED", { ...empty, actions: [action("executed")] }).ok).toBe(false);
    expect(checkGate("ACTION_COMPLETED", { ...empty, actions: [action("approved", true)] }).ok).toBe(false);
    expect(checkGate("ACTION_COMPLETED", { ...empty, actions: [action("executed", true)] }).ok).toBe(true);
  });

  it("never skips a stage", () => {
    const s = { ...empty, actions: [action("executed", true)] };
    expect(tryAdvance("CASE_CREATED", s).stage).toBe("CASE_CREATED");
  });
});
