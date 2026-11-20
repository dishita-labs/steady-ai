/**
 * Picks the recorder from env: SingleStore when SINGLESTORE_* is set, otherwise local JSONL.
 * STEADY_RECORDER=jsonl|singlestore forces one. One instance per process.
 */

import { join } from "node:path";
import { dataDir, isConfigured } from "../config";
import { JsonlCaseRepository } from "./jsonl";
import type { CaseRepository } from "./repository";
import { SingleStoreCaseRepository, createSingleStorePool } from "./singlestore";

export * from "./repository";

let repo: CaseRepository | undefined;

export function selectRecorder(env = process.env): "singlestore" | "jsonl" {
  const forced = env.STEADY_RECORDER;
  if (forced === "singlestore" || forced === "jsonl") return forced;
  return isConfigured("singlestore", env) ? "singlestore" : "jsonl";
}

export function getRepository(): CaseRepository {
  if (repo) return repo;
  repo =
    selectRecorder() === "singlestore"
      ? new SingleStoreCaseRepository(createSingleStorePool())
      : new JsonlCaseRepository(join(dataDir(), "records"));
  return repo;
}
