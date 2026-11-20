/**
 * Integration registry and env access. Server-side only: reads process.env.
 *
 * `verified` is set by hand, and only after a real API call succeeds. Configured ≠ working.
 */

export type IntegrationName = "sie-vision" | "sie-decide" | "exa" | "singlestore" | "shopping";

export interface IntegrationInfo {
  name: IntegrationName;
  label: string;
  role: string;
  /** Env vars that must be set for the integration to be used. */
  required: string[];
  /** Env vars with documented defaults. */
  optional: Record<string, string>;
  docs: string;
  /** Flip to true only after a real API call has succeeded (note the date in docs/decisions.md). */
  verified: boolean;
}

export const INTEGRATIONS: Record<IntegrationName, IntegrationInfo> = {
  "sie-vision": {
    name: "sie-vision",
    label: "Superlinked SIE: Gemma 4 31B (VLM)",
    role: "Photo → hazard findings with visible evidence and stated uncertainty",
    required: ["SIE_API_KEY"],
    optional: { SIE_BASE_URL: "", SIE_VISION_MODEL: "google/gemma-4-31B-it" },
    docs: "https://superlinked.com/models/google-gemma-4-31b-it",
    verified: false,
  },
  "sie-decide": {
    name: "sie-decide",
    label: "Superlinked SIE: GLiNER2.5 Decide",
    role: "Product-page text → typed decisions (advisory)",
    required: ["SIE_API_KEY"],
    optional: { SIE_BASE_URL: "", SIE_DECIDE_MODEL: "fastino/GLiNER2.5-Decide" },
    docs: "https://superlinked.com/models/fastino-gliner2-5-decide",
    verified: false,
  },
  exa: {
    name: "exa",
    label: "Exa",
    role: "Product discovery and product-page content",
    required: ["EXA_API_KEY"],
    optional: {},
    docs: "https://docs.exa.ai/sdks/typescript-sdk-specification",
    verified: false,
  },
  singlestore: {
    name: "singlestore",
    label: "SingleStore",
    role: "System of record: case, findings, products, evidence, decisions, actions, audit",
    required: ["SINGLESTORE_HOST", "SINGLESTORE_USER", "SINGLESTORE_PASSWORD"],
    optional: { SINGLESTORE_PORT: "3306", SINGLESTORE_DATABASE: "steady" },
    docs: "https://docs.singlestore.com/cloud/developer-resources/connect-with-application-development-tools/connect-with-node-js/",
    verified: false,
  },
  shopping: {
    name: "shopping",
    label: "Shopping adapter",
    role: "Prepare a cart or purchase request; executes only after explicit approval",
    required: [],
    optional: { SHOPPING_MODE: "simulated" },
    docs: "docs/architecture/README.md",
    verified: false,
  },
};

type Env = Record<string, string | undefined>;

export function missingEnv(name: IntegrationName, env: Env = process.env): string[] {
  return INTEGRATIONS[name].required.filter((v) => !env[v]);
}

export function isConfigured(name: IntegrationName, env: Env = process.env): boolean {
  return missingEnv(name, env).length === 0;
}

/** Read an env var, falling back to the integration's documented default. */
export function envOr(name: IntegrationName, key: string, env: Env = process.env): string {
  return env[key] || INTEGRATIONS[name].optional[key] || "";
}

export class IntegrationUnavailableError extends Error {
  /** Workflow SDK treats `fatal: true` as FatalError: retrying won't fix missing config. */
  readonly fatal = true;
  constructor(
    public readonly integration: IntegrationName,
    reason: string,
  ) {
    super(`${INTEGRATIONS[integration].label} unavailable: ${reason}`);
    this.name = "IntegrationUnavailableError";
  }
}

/** Throw a clear error when an integration is needed but not configured. Never return placeholder data. */
export function requireConfigured(name: IntegrationName, env: Env = process.env): void {
  const missing = missingEnv(name, env);
  if (missing.length) {
    throw new IntegrationUnavailableError(name, `missing env: ${missing.join(", ")}. See ${INTEGRATIONS[name].docs}.`);
  }
}

/** Where local files (uploads, JSONL records, workflow data) live. */
export function dataDir(env: Env = process.env): string {
  return env.STEADY_DATA_DIR || ".data";
}
