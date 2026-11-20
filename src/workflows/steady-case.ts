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
  markFailed,
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
  const { workflowRunId } = getWorkflowMetadata();
  await recordCase(input, workflowRunId);
  try {
    return await runCase(input);
  } catch (e) {
    // Record the failure on the case, then rethrow so the run shows as failed in the Workflow UI.
    await markFailed(input.caseId, e instanceof Error ? e.message : String(e));
    throw e;
  } finally {
    await closeProgress();
  }
}

/** The case pipeline. Called only from `steadyCase`, so it runs inside the workflow sandbox. */
async function runCase(input: StartCaseInput): Promise<CaseRunResult> {
  const { caseId } = input;
  await analyzePhoto(caseId, input.image.id);

  // Requirements, then wait for the family to answer any open context questions.
  let req = await defineRequirements(caseId);
  let ready = req.requirementIds;
  if (req.openQuestionIds.length > 0) {
    const token = contextToken(caseId);
    const answers = contextHook.create({ token });
    await announceWaiting(caseId, "context", token, `Waiting on ${req.openQuestionIds.length} context question(s).`);
    for await (const payload of answers) {
      const r = await applyContextAnswers(caseId, payload);
      if (r.stillOpen === 0) break;
    }
    req = await defineRequirements(caseId);
    ready = req.requirementIds;
  }
  if (ready.length === 0) {
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
    return { caseId, stage: evaluated.stage, status: evaluated.status, outcome: "nothing_eligible" };
  }

  // Nothing is bought without this explicit approval.
  const token = approvalToken(caseId, prepared.actionId);
  const approval = approvalHook.create({ token });
  await announceWaiting(caseId, "approval", token, "Waiting for explicit purchase approval.");
  const decision = await approval;
  const final = await recordApprovalDecision(caseId, { ...decision, actionId: prepared.actionId });
  return { caseId, ...final, outcome: decision.approved ? "purchase_executed" : "purchase_declined" };
}
