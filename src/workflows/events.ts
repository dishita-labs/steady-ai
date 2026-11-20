/**
 * Progress events each step writes to the run's stream (`getWritable`). The Datastar SSE
 * route reads them back with `getRun(runId).getReadable()`. They hold summaries only: the
 * system of record is the recorder, not the stream.
 */

import type { CaseStatus, WorkflowStage } from "../lib/case/state";

export interface ProgressEvent {
  caseId: string;
  at: string;
  step: string;
  stage: WorkflowStage;
  status: CaseStatus;
  message: string;
  /** Hook token the run is waiting on, when it is waiting. */
  waitingOn?: { kind: "context" | "approval"; token: string };
}
