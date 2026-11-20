/**
 * The Steady case workflow: photo → hazards → requirements → products → typed decisions →
 * rules-engine decisions → purchase request → explicit approval → (simulated) execution.
 *
 * This function only orchestrates. It runs in the Workflow SDK's deterministic sandbox and is
 * replayed from the event log, so it does no I/O itself: everything happens in steps
 * (./steps.ts). Monitor runs with `aube run workflow:web`.
 */

import { getWorkflowMetadata } from "workflow";
import { approvalHook, approvalToken, contextHook, contextToken } from "./hooks";
import {
  analyzePhoto,
  announceWaiting,
  applyContextAnswers,
  closeProgress,
  decideProduct,
  defineRequirements,
  evaluateProducts,
  preparePurchase,
  recordApprovalDecision,
  recordCase,
  researchProducts,
  type CaseState,
  type StartCaseInput,
} from "./steps";

export interface CaseRunResult extends CaseState {
  caseId: string;
  outcome: "purchase_executed" | "purchase_declined" | "nothing_eligible" | "no_requirements";
}

export async function steadyCase(input: StartCaseInput): Promise<CaseRunResult> {
  "use workflow";
  // No try/catch here: the compiler builds the Workflow UI graph from this body and skips
  // `try` blocks. Each step records its own terminal failure (see `guarded` in ./steps.ts).
  const { caseId } = input;
  const { workflowRunId } = getWorkflowMetadata();
  await recordCase(input, workflowRunId);
  await analyzePhoto(caseId, input.image.id);

  // Requirements, then wait for the family to answer any open context questions.
  let req = await defineRequirements(caseId);
  let ready = req.requirementIds;
  if (req.openQuestionIds.length > 0) {
    const contextHookToken = contextToken(caseId);
    const answers = contextHook.create({ token: contextHookToken });
    await announceWaiting(caseId, "context", contextHookToken, `Waiting on ${req.openQuestionIds.length} context question(s).`);
    for await (const payload of answers) {
      const r = await applyContextAnswers(caseId, payload);
      if (r.stillOpen === 0) break;
    }
    req = await defineRequirements(caseId);
    ready = req.requirementIds;
  }
  if (ready.length === 0) {
    await closeProgress();
    return { caseId, stage: req.stage, status: req.status, outcome: "no_requirements" };
  }

  // Research every ready requirement in parallel, then ask Decide about each candidate.
  const researched = await Promise.all(ready.map((id) => researchProducts(caseId, id)));
  await Promise.all(
    researched.flatMap((r, i) => r.candidateIds.map((candidateId) => decideProduct(caseId, candidateId, ready[i]))),
  );

  const evaluated = await evaluateProducts(caseId);
  const prepared = await preparePurchase(caseId);
  if (!prepared) {
    await closeProgress();
    return { caseId, stage: evaluated.stage, status: evaluated.status, outcome: "nothing_eligible" };
  }

  // Nothing is bought without this explicit approval.
  const approvalHookToken = approvalToken(caseId, prepared.actionId);
  const approval = approvalHook.create({ token: approvalHookToken });
  await announceWaiting(caseId, "approval", approvalHookToken, "Waiting for explicit purchase approval.");
  const decision = await approval;
  const final = await recordApprovalDecision(caseId, { ...decision, actionId: prepared.actionId });
  await closeProgress();
  return { caseId, ...final, outcome: decision.approved ? "purchase_executed" : "purchase_declined" };
}
