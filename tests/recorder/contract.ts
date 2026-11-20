/**
 * Recorder contract, shared by every backend: memory and JSONL in tests/recorder.test.ts, and
 * real SingleStore in tests/singlestore.smoke.test.ts. Not a test file itself.
 */

import { expect, it } from "vitest";
import { stableId } from "../../src/lib/ids";
import { COLLECTIONS, loadCaseHistory, loadSnapshot, type CaseCollections, type CaseRepository } from "../../src/lib/recorder/repository";
import type { AuditEvent, HomeownerCase } from "../../src/types/domain";

const at = "2026-11-20T12:00:00.000Z";

export function fixtureCase(caseId: string): HomeownerCase {
  return { id: caseId, createdAt: at, updatedAt: at, stage: "CASE_CREATED", status: "in_progress", household: { budgetMaxUsd: 150, ownership: "own", notes: "uses a cane" }, workflowRunId: `wrun_${caseId}` };
}

/** One realistic row per collection, ids derived the way steps derive them. */
export function fixtureCollections(caseId: string): CaseCollections {
  const imageId = stableId("img", caseId);
  const hazardId = stableId("haz", imageId, "H09", 0);
  const reqId = stableId("req", caseId, "H09");
  const questionId = stableId("q", reqId, "wall_type");
  const candId = stableId("cand", reqId, "https://example.com/grab-bar");
  const evId = stableId("ev", candId, "page_text");
  const clsId = stableId("cls", candId, reqId, evId, 0);
  const decId = stableId("dec", candId, reqId);
  return {
    images: [{ id: imageId, caseId, storageKey: `${caseId}/bath.jpg`, mimeType: "image/jpeg", sha256: "a".repeat(64), width: 1024, height: 768, room: "bathroom", consentConfirmed: true, uploadedAt: at, analysisStatus: "analyzed" }],
    hazards: [{ id: hazardId, caseId, imageId, category: "H09", label: "present", summary: "No grab bar beside the tub.", visibleEvidence: ["bare wall next to tub"], location: { description: "right of tub", bbox: [0.1, 0.2, 0.3, 0.4] }, severity: "high", notEstablishedFromPhoto: ["wall stud location"], humanAssessmentRequired: false, professionalAssessmentRecommended: true, modelConfidence: 0.87, source: { provider: "sie-vision", model: "google/gemma-4-31B-it", at } }],
    questions: [{ id: questionId, caseId, hazardId, requirementId: reqId, question: "What is the wall made of?", field: "wall_type", status: "open", askedAt: at }],
    requirements: [{ id: reqId, caseId, ruleId: "H09-grab-bar", hazardIds: [hazardId], productType: "grab_bar", mandatory: [{ id: "c_load", attribute: "load_lb", op: "gte", value: 250, unit: "lb", rationale: "Must hold body weight." }], preferred: [], safetyCritical: true, installation: "professional_recommended", openQuestionIds: [questionId], status: "needs_context" }],
    candidates: [{ id: candId, caseId, requirementIds: [reqId], title: "Steel grab bar 24in", url: "https://example.com/grab-bar", retailer: "example.com", attributes: [], evidenceIds: [evId], discoveredBy: { provider: "exa", query: "grab bar 24 inch", at }, status: "discovered" }],
    evidence: [{ id: evId, caseId, candidateId: candId, sourceUrl: "https://example.com/grab-bar", kind: "page_text", excerpt: "Unicode check: 24″ bar — supports up to 250 lb ✓", source: { provider: "exa", at } }],
    classifications: [{ id: clsId, caseId, candidateId: candId, requirementId: reqId, answers: [{ questionId: "c_load", type: "noul", answer: "yes", probabilities: { yes: 0.91, no: 0.09 }, constraintId: "c_load" }], concern: false, evidenceIds: [evId], source: { provider: "sie-decide", model: "fastino/GLiNER2.5-Decide", at } }],
    decisions: [{ id: decId, caseId, candidateId: candId, requirementId: reqId, outcome: "needs_verification", ruleResults: [{ constraintId: "c_load", attribute: "load_lb", outcome: "unknown", explanation: "No evidence-backed load_lb." }], evidenceIds: [], classificationIds: [clsId], notes: ["Safety-critical install: in-person check recommended."], engineVersion: "rules-0.1", decidedAt: at }],
    actions: [{ id: stableId("act", caseId, decId), caseId, type: "purchase_request", candidateIds: [candId], decisionIds: [decId], status: "awaiting_approval", simulated: true, adapter: "simulated", createdAt: at, updatedAt: at }],
  };
}

export function fixtureAudit(caseId: string): AuditEvent[] {
  return [
    { id: stableId("evt", caseId, 1), caseId, at: "2026-11-20T12:00:01.000Z", type: "case.created", actor: { kind: "user", id: "api" }, stage: "CASE_CREATED", summary: "Case created." },
    { id: stableId("evt", caseId, 2), caseId, at: "2026-11-20T12:00:02.000Z", type: "decision.made", actor: { kind: "system", id: "rules-engine" }, stage: "PRODUCTS_RESEARCHED", subject: { kind: "candidate", id: "cand_x" }, summary: "needs_verification for grab_bar.", data: { ruleResults: [{ outcome: "unknown" }] } },
    { id: stableId("evt", caseId, 3), caseId, at: "2026-11-20T12:00:03.000Z", type: "action.approval_requested", actor: { kind: "system", id: "workflow" }, stage: "PURCHASE_PREPARED", summary: "Waiting for explicit approval.", toolCall: { provider: "shopping", operation: "prepare", ok: true, durationMs: 4 } },
  ];
}

/**
 * Register the contract's `it` blocks. `ctx()` returns the repository and a case id unique to
 * this run (and to the backend), so the suite is safe against a shared database.
 */
export function recorderContract(ctx: () => { repo: CaseRepository; caseId: string; otherCaseId: string }) {
  it("creates a case, reads it back, and refuses a duplicate", async () => {
    const { repo, caseId } = ctx();
    expect(await repo.getCase(caseId)).toBeNull();
    await repo.createCase(fixtureCase(caseId));
    expect(await repo.getCase(caseId)).toEqual(fixtureCase(caseId));
    await expect(repo.createCase(fixtureCase(caseId))).rejects.toThrow(/already exists/);
  });

  it("updates a case and persists the patch", async () => {
    const { repo, caseId } = ctx();
    const next = await repo.updateCase(caseId, { stage: "PHOTO_ANALYZED", status: "needs_input", statusReason: "wall type unknown" });
    expect(next.updatedAt).not.toBe(fixtureCase(caseId).updatedAt);
    const read = await repo.getCase(caseId);
    expect(read).toEqual(next);
    expect(read?.household).toEqual(fixtureCase(caseId).household);
    await expect(repo.updateCase(`${caseId}_missing`, { stage: "PHOTO_ANALYZED" })).rejects.toThrow(/not found/);
  });

  it("writes and reads back every collection exactly", async () => {
    const { repo, caseId } = ctx();
    const fx = fixtureCollections(caseId);
    for (const name of COLLECTIONS) for (const item of fx[name]) await repo.upsert(name, item as never);
    for (const name of COLLECTIONS) expect(await repo.list(name, caseId), name).toEqual(fx[name]);
  });

  it("is idempotent under retries: same id → one row, last write wins", async () => {
    const { repo, caseId } = ctx();
    const fx = fixtureCollections(caseId);
    // A retried step writes the same rows again.
    for (const name of COLLECTIONS) for (const item of fx[name]) await repo.upsert(name, item as never);
    for (const name of COLLECTIONS) expect(await repo.list(name, caseId), name).toHaveLength(fx[name].length);
    // A later step changes a row.
    await repo.upsert("actions", { ...fx.actions[0], status: "declined", updatedAt: "2026-11-20T12:05:00.000Z" });
    const actions = await repo.list("actions", caseId);
    expect(actions).toHaveLength(1);
    expect(actions[0].status).toBe("declined");
  });

  it("keeps cases isolated", async () => {
    const { repo, otherCaseId } = ctx();
    for (const name of COLLECTIONS) expect(await repo.list(name, otherCaseId), name).toEqual([]);
    expect(await repo.listAudit(otherCaseId)).toEqual([]);
  });

  it("appends audit events in time order, idempotently", async () => {
    const { repo, caseId } = ctx();
    const events = fixtureAudit(caseId);
    for (const e of events) await repo.appendAudit(e);
    expect(await repo.listAudit(caseId)).toEqual(events);
    // JSONL keeps duplicate appends (tests/boundaries.test.ts asserts that); proposed fix in
    // docs/integrations/singlestore.md. SingleStore's primary key and memory dedupe by id.
    if (repo.kind === "jsonl") return;
    await repo.appendAudit(events[1]); // retried step
    expect(await repo.listAudit(caseId)).toEqual(events);
  });

  it("reconstructs the full case and audit history from the recorder alone", async () => {
    const { repo, caseId } = ctx();
    const h = await loadCaseHistory(repo, caseId);
    expect(h).not.toBeNull();
    expect(h!.case.stage).toBe("PHOTO_ANALYZED");
    expect(h!.audit.map((e) => e.type)).toEqual(["case.created", "decision.made", "action.approval_requested"]);
    expect(h!.collections.evidence[0].excerpt).toContain("250 lb ✓");
    expect(h!.collections.actions[0].status).toBe("declined");
    const snap = await loadSnapshot(repo, caseId);
    expect(snap.requirements[0].hazardIds).toEqual([snap.hazards[0].id]);
    expect(snap.decisions[0].classificationIds).toEqual([h!.collections.classifications[0].id]);
    expect(await loadCaseHistory(repo, `${caseId}_missing`)).toBeNull();
  });
}
