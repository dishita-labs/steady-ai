/**
 * Development images only. The loader reads steady-prep/data/manifests/development.json and
 * refuses any record that is not `split: development` or whose file isn't under
 * data/development/. It never opens the evaluation manifest, evaluation images or
 * labels/hazard-labels.json (which mixes splits).
 */

import { readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { CategoryLabel, HazardCategoryId, RoomType } from "../../src/types/domain";

export interface DevRecord {
  imageId: string;
  file: string;
  room: RoomType;
  caseType: string;
  labels: Record<HazardCategoryId, CategoryLabel>;
  visibleEvidence: string;
  humanAssessmentRequired: boolean;
}

export function steadyPrepDir(env = process.env): string {
  return resolve(env.STEADY_PREP_DIR || join(process.cwd(), "..", "steady-prep"));
}

export function parseDevManifest(raw: unknown, root: string): DevRecord[] {
  if (!Array.isArray(raw)) throw new Error("development manifest must be an array");
  const devDir = resolve(root, "data", "development") + sep;
  return raw.map((r: Record<string, unknown>) => {
    if (r.split !== "development") throw new Error(`Refusing ${String(r.image_id)}: split is ${String(r.split)}, not development.`);
    const file = resolve(root, String(r.file));
    if (!file.startsWith(devDir)) throw new Error(`Refusing ${String(r.image_id)}: ${String(r.file)} is outside data/development/.`);
    return {
      imageId: String(r.image_id),
      file,
      room: r.room as RoomType,
      caseType: String(r.case_type),
      labels: r.category_labels as Record<HazardCategoryId, CategoryLabel>,
      visibleEvidence: String(r.visible_evidence ?? ""),
      humanAssessmentRequired: Boolean(r.human_assessment_required),
    };
  });
}

export async function loadDevelopmentSet(root = steadyPrepDir()): Promise<DevRecord[]> {
  const raw = JSON.parse(await readFile(join(root, "data", "manifests", "development.json"), "utf8"));
  return parseDevManifest(raw, root);
}

export function mimeTypeFor(file: string): "image/jpeg" | "image/png" | "image/webp" {
  if (/\.png$/i.test(file)) return "image/png";
  if (/\.webp$/i.test(file)) return "image/webp";
  return "image/jpeg";
}
