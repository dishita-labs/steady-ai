/**
 * Points where a case run pauses for a person. Tokens are deterministic (built from case
 * and action IDs), so the API can resume them without a lookup. Tokens are NOT a
 * credential: the routes that call `resume()` sit behind the API bearer token (see server.ts).
 */

import { defineHook } from "workflow";
import { z } from "zod";

/** Answers to open context questions. Unlisted questions stay open. */
export const contextHook = defineHook({
  schema: z.object({
    answers: z.array(
      z.object({
        questionId: z.string(),
        answer: z.string().optional(),
        skip: z.boolean().optional(),
      }),
    ),
    answeredBy: z.string(),
  }),
});

/** The explicit purchase decision. Nothing executes without `approved: true` here. */
export const approvalHook = defineHook({
  schema: z.object({
    actionId: z.string(),
    approved: z.boolean(),
    approvedBy: z.string(),
  }),
});

export const contextToken = (caseId: string) => `steady:context:${caseId}`;
export const approvalToken = (caseId: string, actionId: string) => `steady:approval:${caseId}:${actionId}`;
