/**
 * Picks the recorder from env: SingleStore when SINGLESTORE_* is set, otherwise local JSONL.
 * STEADY_RECORDER=jsonl|singlestore forces one. One instance per process.
 *
 * Never a silent fallback: an unknown STEADY_RECORDER value, or a SingleStore config with only
 * some of its required vars set, throws instead of quietly writing to JSONL. Once SingleStore is
 * selected, its errors surface as-is (see SingleStoreRecorderError).
 */

import { join } from "node:path";
import { INTEGRATIONS, IntegrationUnavailableError, dataDir, isConfigured } from "../config";
import { JsonlCaseRepository } from "./jsonl";
import type { CaseRepository } from "./repository";
import { SingleStoreCaseRepository, createSingleStorePool } from "./singlestore";

export * from "./repository";

let repo: CaseRepository | undefined;

export function selectRecorder(env: Record<string, string | undefined> = process.env): "singlestore" | "jsonl" {
  const forced = env.STEADY_RECORDER;
  if (forced === "singlestore" || forced === "jsonl") return forced;
  if (forced) {
    throw new IntegrationUnavailableError("singlestore", `STEADY_RECORDER="${forced}" is not "singlestore" or "jsonl".`);
  }
  if (isConfigured("singlestore", env)) return "singlestore";
  const set = INTEGRATIONS.singlestore.required.filter((k) => env[k]);
  if (set.length > 0) {
    const missing = INTEGRATIONS.singlestore.required.filter((k) => !env[k]);
    throw new IntegrationUnavailableError(
      "singlestore",
      `partly configured (${set.join(", ")} set; missing ${missing.join(", ")}). Set them all, or set STEADY_RECORDER=jsonl.`,
    );
  }
  return "jsonl";
}

export function getRepository(): CaseRepository {
  if (repo) return repo;
  repo =
    selectRecorder() === "singlestore"
      ? new SingleStoreCaseRepository(createSingleStorePool())
      : new JsonlCaseRepository(join(dataDir(), "records"));
  return repo;
}
