/**
 * Vision prompt and response schema. FIRST DRAFT, not evaluated.
 * Changes here should be measured against the held-out eval images (H01–H11 labels).
 */

import { HAZARD_CATEGORIES, type HouseholdContext, type RoomType } from "../../types/domain";

const ids = Object.keys(HAZARD_CATEGORIES);
const labelEnum = ["present", "absent", "cannot_determine", "not_applicable"];

/** Strict JSON schema sent as `response_format`. Mirrors `VisionModelOutput` in ./index.ts. */
export const VISION_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["categoryLabels", "findings", "uncertainties", "humanAssessmentRequired"],
  properties: {
    categoryLabels: {
      type: "object",
      additionalProperties: false,
      required: ids,
      properties: Object.fromEntries(ids.map((id) => [id, { type: "string", enum: labelEnum }])),
    },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "category",
          "label",
          "summary",
          "visibleEvidence",
          "location",
          "severity",
          "notEstablishedFromPhoto",
          "humanAssessmentRequired",
          "professionalAssessmentRecommended",
        ],
        properties: {
          category: { type: "string", enum: ids },
          label: { type: "string", enum: ["present", "cannot_determine"] },
          summary: { type: "string" },
          visibleEvidence: { type: "array", items: { type: "string" } },
          location: {
            anyOf: [
              { type: "object", additionalProperties: false, required: ["description"], properties: { description: { type: "string" } } },
              { type: "null" },
            ],
          },
          severity: { type: "string", enum: ["low", "moderate", "high"] },
          notEstablishedFromPhoto: { type: "array", items: { type: "string" } },
          humanAssessmentRequired: { type: "boolean" },
          professionalAssessmentRecommended: { type: "boolean" },
        },
      },
    },
    uncertainties: { type: "array", items: { type: "string" } },
    humanAssessmentRequired: { type: "boolean" },
  },
} as const;

export function visionSystemPrompt(input: { room: RoomType; household?: HouseholdContext }): string {
  const categories = Object.entries(HAZARD_CATEGORIES)
    .map(([id, slug]) => `${id}: ${slug}`)
    .join("\n");
  return [
    "You review one photo of a room in an older adult's home for visible fall hazards.",
    "Label every category below with exactly one of: present, absent, cannot_determine, not_applicable.",
    "",
    categories,
    "",
    "Rules:",
    "- Label a category present only if you can see the hazard. List what you see in visibleEvidence.",
    "- If the photo doesn't show enough to decide, use cannot_determine. Don't guess.",
    "- Don't state anything a photo can't show (anchoring, slipperiness, load rating, wall structure) as fact. Put it in notEstablishedFromPhoto.",
    "- Create a finding only for categories labeled present or cannot_determine.",
    "- Recommend a professional assessment for anything that bears weight or needs installing into a wall.",
    "",
    `Room (from the user): ${input.room}.`,
    input.household?.notes ? `Notes from the family: ${input.household.notes}` : "",
    "Return only JSON that matches the schema.",
  ]
    .filter((l) => l !== "")
    .join("\n");
}
