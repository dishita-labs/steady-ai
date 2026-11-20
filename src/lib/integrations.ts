/**
 * Integration registry: what each external service is for, which env vars it needs,
 * and whether a real call has been verified. Server-side only: reads process.env.
 *
 * `verified` is set by hand, and only after a real API call succeeds. Configured ≠ working.
 */

export type IntegrationName = "guild" | "vision" | "exa" | "superlinked" | "singlestore" | "shopping";

export interface IntegrationInfo {
  name: IntegrationName;
  label: string;
  role: string;
  envVars: string[];
  docs: string;
  /** Flip to true only after a real API call has succeeded (note the date in docs/decisions.md). */
  verified: boolean;
}

export const INTEGRATIONS: Record<IntegrationName, IntegrationInfo> = {
  guild: {
    name: "guild",
    label: "Guild AI",
    role: "Agent execution, governance, tool access, session traces",
    envVars: ["GUILD_API_BASE_URL", "GUILD_WORKSPACE_ID", "GUILD_AGENT_ID", "GUILD_API_KEY_ID", "GUILD_API_KEY_SECRET"],
    docs: "https://docs.guild.ai",
    verified: false,
  },
  vision: {
    name: "vision",
    label: "Vision-language model",
    role: "Hazard findings with visible evidence and uncertainty",
    envVars: ["VISION_PROVIDER", "VISION_MODEL", "VISION_API_KEY"],
    docs: "(provider not chosen yet)",
    verified: false,
  },
  exa: {
    name: "exa",
    label: "Exa",
    role: "Product discovery and product-page content",
    envVars: ["EXA_API_KEY"],
    docs: "https://docs.exa.ai/sdks/typescript-sdk-specification",
    verified: false,
  },
  superlinked: {
    name: "superlinked",
    label: "Superlinked SIE (GLiNER2.5 Decide)",
    role: "Classify product text against requirements (advisory)",
    envVars: ["SIE_API_KEY", "SIE_BASE_URL", "SIE_DECIDE_MODEL"],
    docs: "https://superlinked.com/models/fastino-gliner2-5-decide",
    verified: false,
  },
  singlestore: {
    name: "singlestore",
    label: "SingleStore",
    role: "Case state, findings, candidates, evidence, decisions, actions, audit",
    envVars: ["SINGLESTORE_HOST", "SINGLESTORE_PORT", "SINGLESTORE_USER", "SINGLESTORE_PASSWORD", "SINGLESTORE_DATABASE"],
    docs: "https://docs.singlestore.com/cloud/developer-resources/connect-with-application-development-tools/connect-with-node-js/",
    verified: false,
  },
  shopping: {
    name: "shopping",
    label: "Shopping adapter",
    role: "Prepare a cart or purchase request; executes only after explicit approval",
    envVars: ["SHOPPING_MODE"],
    docs: "docs/architecture/README.md",
    verified: false,
  },
};

/** Optional env vars that have documented defaults, so they don't count as missing. */
const OPTIONAL = new Set(["SIE_BASE_URL", "SINGLESTORE_PORT", "GUILD_API_BASE_URL", "SHOPPING_MODE"]);

export function missingEnv(name: IntegrationName, env: Record<string, string | undefined> = process.env): string[] {
  return INTEGRATIONS[name].envVars.filter((v) => !OPTIONAL.has(v) && !env[v]);
}

export class IntegrationUnavailableError extends Error {
  constructor(
    public readonly integration: IntegrationName,
    reason: string,
  ) {
    super(`${INTEGRATIONS[integration].label} unavailable: ${reason}`);
    this.name = "IntegrationUnavailableError";
  }
}

/**
 * Throw a clear error for an integration boundary that has no adapter yet.
 * Use this instead of returning placeholder data.
 */
export function notImplemented(name: IntegrationName, operation: string): never {
  const missing = missingEnv(name);
  throw new IntegrationUnavailableError(
    name,
    `${operation} is not implemented yet` +
      (missing.length ? `; missing env: ${missing.join(", ")}` : "") +
      `. See ${INTEGRATIONS[name].docs}.`,
  );
}
