/**
 * Agent runtime boundary (Guild AI).
 *
 * Read from docs.guild.ai on 2026-11-20 and NOT yet exercised by a real call:
 *   - The agent itself is built and published on Guild's platform (TypeScript, `llmAgent(...)`).
 *     `@guildai/agents-sdk` is only available inside Guild's runtime, not on public npm.
 *   - This app talks to Guild over REST (`https://api.guild.ai/v1`), with an `<id>:<secret>`
 *     credential (Basic or Bearer).
 *       POST /workspaces/{ws}/sessions     { session_type: "chat", agent_id, initial_prompt }
 *       GET  /sessions/{id}/events?from_id=   (reply in a `runtime_done` event)
 *       POST /sessions/{id}/events            (follow-up message)
 *   - The docs don't name env vars; the GUILD_* names in .env.example are ours.
 *
 * Our app keeps the authoritative workflow state (lib/agent/workflow.ts). Guild session IDs
 * and event IDs are recorded on audit events so the two traces line up.
 */

import { notImplemented } from "@/lib/integrations";
import type { CaseId } from "@/types/domain";

export interface AgentSession {
  id: string;
  agentId: string;
  startedAt: string;
}

export interface AgentSessionEvent {
  id: string;
  type: string;
  at?: string;
  content?: unknown;
}

export interface AgentRuntime {
  startSession(input: { caseId: CaseId; prompt: string }): Promise<AgentSession>;
  sendMessage(sessionId: string, text: string): Promise<void>;
  listEvents(sessionId: string, fromId?: string): Promise<AgentSessionEvent[]>;
}

export function getAgentRuntime(): AgentRuntime {
  return {
    startSession: () => notImplemented("guild", "startSession"),
    sendMessage: () => notImplemented("guild", "sendMessage"),
    listEvents: () => notImplemented("guild", "listEvents"),
  };
}
