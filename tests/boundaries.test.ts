import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createAuditEvent } from "../src/lib/audit";
import { IntegrationUnavailableError, requireConfigured } from "../src/lib/config";
import { newId, stableId } from "../src/lib/ids";
import { chunkText, questionsFor, toTypedAnswer } from "../src/lib/product-decisions";
import { selectRecorder } from "../src/lib/recorder";
import { JsonlCaseRepository } from "../src/lib/recorder/jsonl";
import { loadSnapshot } from "../src/lib/recorder/repository";
import { toDatetime } from "../src/lib/recorder/tables";
import { classificationConcern } from "../src/lib/rules/engine";
import { deriveRequirements, type RequirementRule } from "../src/lib/rules/requirements";
import {
  ApprovalRequiredError,
  SimulatedShoppingAdapter,
  approve,
  executeApproved,
  type ShoppingAdapter,
} from "../src/lib/shopping";
import { validateVisionResult, type VisionAnalysisResult } from "../src/lib/vision";
import {
  HAZARD_CATEGORIES,
  type ConstraintDecision,
  type HazardCategoryId,
  type HazardFinding,
  type ShoppingAction,
} from "../src/types/domain";

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

  it("simulated adapter labels its actions and only takes eligible decisions", async () => {
    const sim = new SimulatedShoppingAdapter(newId);
    const decision = { id: "dec_1", candidateId: "cand_1", outcome: "eligible" } as ConstraintDecision;
    const action = await sim.prepare({ caseId: "c", decisions: [decision] });
    expect(action.simulated).toBe(true);
    expect(action.status).toBe("awaiting_approval");
    await expect(
      sim.prepare({ caseId: "c", decisions: [{ ...decision, outcome: "needs_verification" }] }),
    ).rejects.toBeInstanceOf(ApprovalRequiredError);
  });
});

describe("integration config", () => {
  it("throws a clear error instead of returning placeholder data", () => {
    expect(() => requireConfigured("exa", {})).toThrow(IntegrationUnavailableError);
    expect(() => requireConfigured("exa", { EXA_API_KEY: "x" })).not.toThrow();
  });

  it("selects SingleStore only when it is configured, unless forced", () => {
    expect(selectRecorder({})).toBe("jsonl");
    expect(selectRecorder({ SINGLESTORE_HOST: "h", SINGLESTORE_USER: "u", SINGLESTORE_PASSWORD: "p" })).toBe("singlestore");
    expect(selectRecorder({ SINGLESTORE_HOST: "h", SINGLESTORE_USER: "u", SINGLESTORE_PASSWORD: "p", STEADY_RECORDER: "jsonl" })).toBe("jsonl");
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
    source: { provider: "sie-vision", at },
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

describe("requirement rules", () => {
  const hazard = (category: HazardCategoryId, label: HazardFinding["label"]): HazardFinding => ({
    id: `haz_${category}_${label}`,
    caseId: "c",
    imageId: "img",
    category,
    label,
    summary: "",
    visibleEvidence: ["x"],
    severity: "moderate",
    notEstablishedFromPhoto: [],
    humanAssessmentRequired: false,
    professionalAssessmentRecommended: false,
    source: { provider: "sie-vision", at },
  });
  const rules: RequirementRule[] = [
    {
      id: "R-test",
      hazard: "H09",
      productType: "grab_bar",
      searchQuery: "q",
      safetyCritical: true,
      installation: "professional_recommended",
      mandatory: [{ attribute: "length_in", op: "gte", value: 16, unit: "in", rationale: "grip" }],
      preferred: [],
      questions: [{ field: "wall_type", question: "What is the wall made of?" }],
    },
  ];

  it("only 'present' findings drive requirements, and records the rule that fired", () => {
    const out = deriveRequirements("c", [hazard("H09", "present"), hazard("H09", "cannot_determine"), hazard("H05", "present")], rules);
    expect(out.requirements).toHaveLength(1);
    expect(out.requirements[0]).toMatchObject({ ruleId: "R-test", status: "needs_context", hazardIds: ["haz_H09_present"] });
    expect(out.requirements[0].mandatory[0].id).toBe("R-test.m0");
    expect(out.questions).toHaveLength(1);
    expect(out.unmatched).toEqual(["H05"]);
  });

  it("is deterministic, so a retried step writes the same IDs", () => {
    const a = deriveRequirements("c", [hazard("H09", "present")], rules);
    const b = deriveRequirements("c", [hazard("H09", "present")], rules);
    expect(a.requirements[0].id).toBe(b.requirements[0].id);
    expect(a.questions[0].id).toBe(b.questions[0].id);
    expect(stableId("x", "a", "b")).not.toBe(stableId("x", "ab"));
  });
});

describe("Decide boundary helpers", () => {
  it("builds suitability plus one yes/no per probed constraint", () => {
    const qs = questionsFor("grab_bar", [
      { id: "c1", attribute: "weight_lb", op: "gte", value: 250, rationale: "", decideQuestion: "Rated for 250 lb or more?" },
      { id: "c2", attribute: "finish", op: "present", rationale: "" },
    ]);
    expect(Object.keys(qs)).toEqual(["suitability", "c1"]);
  });

  it("chunks long text under the size limit without losing words", () => {
    const text = Array.from({ length: 800 }, (_, i) => `w${i}`).join(" ");
    const chunks = chunkText(text, 500);
    expect(chunks.every((c) => c.length <= 500)).toBe(true);
    expect(chunks.join(" ")).toBe(text);
  });

  it("normalizes real SIE answer shapes, keeping the probabilities", () => {
    const a = toTypedAnswer("suitability", { type: "choice", instructions: "", criteria: {} }, {
      type: "choice",
      choice: "reject",
      probabilities: { candidate: 0.1, reject: 0.9 },
      confidence: 0.8,
    });
    expect(a).toMatchObject({ answer: "reject", probabilities: { reject: 0.9 } });
    const yes = toTypedAnswer("c1", { type: "noul", instructions: "" }, { type: "noul", noul: 0.99, answer: true, confidence: 0.99 });
    expect(yes).toMatchObject({ answer: "yes", probabilities: { yes: 0.99 } });
    const no = toTypedAnswer("c1", { type: "noul", instructions: "" }, { type: "noul", noul: 0.1, answer: false });
    expect(no.answer).toBe("no");
  });

  it("concern policy: reject or 'no' raises a concern; 'yes' never counts as a pass", () => {
    expect(classificationConcern([{ questionId: "suitability", type: "choice", answer: "candidate", probabilities: {} }]).concern).toBe(false);
    expect(classificationConcern([{ questionId: "suitability", type: "choice", answer: "needs_evidence", probabilities: {} }]).concern).toBe(true);
    expect(classificationConcern([{ questionId: "c1", constraintId: "c1", type: "noul", answer: "no", probabilities: {} }]).concern).toBe(true);
  });
});

describe("JSONL recorder", () => {
  let dir = "";
  afterAll(() => (dir ? rm(dir, { recursive: true, force: true }) : undefined));

  it("round-trips a case, last write wins, audit is append-only", async () => {
    dir = await mkdtemp(join(tmpdir(), "steady-"));
    const repo = new JsonlCaseRepository(dir);
    await repo.createCase({ id: "c1", createdAt: at, updatedAt: at, stage: "CASE_CREATED", status: "in_progress", household: {} });
    await expect(repo.createCase({ id: "c1", createdAt: at, updatedAt: at, stage: "CASE_CREATED", status: "in_progress", household: {} })).rejects.toThrow();
    await repo.updateCase("c1", { stage: "PHOTO_ANALYZED" });
    expect((await repo.getCase("c1"))?.stage).toBe("PHOTO_ANALYZED");

    const img = { id: "i1", caseId: "c1", storageKey: "k", mimeType: "image/jpeg" as const, sha256: "s", room: "bathroom" as const, consentConfirmed: true, uploadedAt: at, analysisStatus: "pending" as const };
    await repo.upsert("images", img);
    await repo.upsert("images", { ...img, analysisStatus: "analyzed" });
    const snap = await loadSnapshot(repo, "c1");
    expect(snap.images).toHaveLength(1);
    expect(snap.images[0].analysisStatus).toBe("analyzed");

    const e = createAuditEvent({ caseId: "c1", type: "case.created", actor: { kind: "system", id: "t" }, stage: "CASE_CREATED", summary: "x" });
    await repo.appendAudit(e);
    await repo.appendAudit(e);
    expect(await repo.listAudit("c1")).toHaveLength(2);
  });

  it("formats DATETIME(6) for SingleStore", () => {
    expect(toDatetime("2026-11-20T01:02:03.456Z")).toBe("2026-11-20 01:02:03.456");
  });
});
