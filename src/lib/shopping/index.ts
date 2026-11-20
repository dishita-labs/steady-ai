/**
 * Shopping boundary: prepare a cart or purchase request, then execute it only after
 * explicit user approval. No payment processing lives here.
 *
 * Any adapter that doesn't touch a real retailer must set `simulated: true`, and the UI
 * must label it "Simulated".
 */

import type { ConstraintDecision, ShoppingAction } from "@/types/domain";

export interface PrepareInput {
  caseId: string;
  decisions: ConstraintDecision[];
}

export interface ShoppingAdapter {
  readonly name: string;
  readonly simulated: boolean;
  /** Build a cart / purchase request. Must not spend money. */
  prepare(input: PrepareInput): Promise<ShoppingAction>;
  /** Carry out an approved action. Only ever called through `executeApproved`. */
  execute(action: ShoppingAction): Promise<ShoppingAction>;
}

export class ApprovalRequiredError extends Error {
  constructor(reason: string) {
    super(`Purchase action blocked: ${reason}`);
    this.name = "ApprovalRequiredError";
  }
}

/** Only eligible decisions can go into a cart. */
export function assertPreparable(decisions: ConstraintDecision[]): void {
  const bad = decisions.filter((d) => d.outcome !== "eligible");
  if (bad.length) throw new ApprovalRequiredError(`decisions not eligible: ${bad.map((d) => d.id).join(", ")}`);
  if (decisions.length === 0) throw new ApprovalRequiredError("no eligible decisions");
}

/** Record the user's explicit approval. Call this only from a direct user action. */
export function approve(action: ShoppingAction, userId: string, now = new Date()): ShoppingAction {
  if (action.status !== "awaiting_approval") {
    throw new ApprovalRequiredError(`action is ${action.status}, not awaiting approval`);
  }
  const at = now.toISOString();
  return {
    ...action,
    status: "approved",
    approval: { approvedBy: userId, approvedAt: at, method: "explicit_user_confirmation" },
    updatedAt: at,
  };
}

/** The only way to execute an action. Refuses unless it was explicitly approved. */
export async function executeApproved(adapter: ShoppingAdapter, action: ShoppingAction): Promise<ShoppingAction> {
  if (action.status !== "approved" || !action.approval) {
    throw new ApprovalRequiredError("explicit user approval is required");
  }
  if (action.adapter !== adapter.name) {
    throw new ApprovalRequiredError(`action was prepared by ${action.adapter}, not ${adapter.name}`);
  }
  return adapter.execute(action);
}
