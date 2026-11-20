/**
 * Stage 1: Gemma 4 (SIE `chatCompletions`) describes what is visible. NO hazard judgement.
 *
 * The prompt never names H01–H11, never asks about safety or risk, and asks the model to state
 * what it cannot see. Same call pattern as the production analyzer (src/lib/vision/index.ts):
 * temperature 0 and a strict JSON-schema response_format.
 */

import { z } from "zod";
import { envOr } from "../../src/lib/config";
import { getSieClient } from "../../src/lib/sie";
import type { RoomType } from "../../src/types/domain";

const ROOMS = ["bathroom", "stairs", "entrance", "bedroom", "hallway", "other_living_area", "unknown"] as const;
const VISIBILITY = ["full", "partial", "obscured"] as const;

export const OBSERVATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["roomType", "observations", "unknowns"],
  properties: {
    roomType: { type: "string", enum: ROOMS },
    observations: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "feature", "description", "location", "visibility", "limitations"],
        properties: {
          id: { type: "string" },
          feature: { type: "string" },
          description: { type: "string" },
          location: { type: "string" },
          visibility: { type: "string", enum: VISIBILITY },
          limitations: { type: "array", items: { type: "string" } },
        },
      },
    },
    unknowns: { type: "array", items: { type: "string" } },
  },
} as const;

export const ObservationOutput = z.object({
  roomType: z.enum(ROOMS),
  observations: z.array(
    z.object({
      id: z.string().regex(/^O\d+$/),
      feature: z.string().min(1),
      description: z.string().min(1),
      location: z.string(),
      visibility: z.enum(VISIBILITY),
      limitations: z.array(z.string()),
    }),
  ),
  unknowns: z.array(z.string()),
});
export type ObservationOutput = z.infer<typeof ObservationOutput>;
export type Observation = ObservationOutput["observations"][number];

export function observationPrompt(room: RoomType): string {
  return [
    "Describe what is visible in this photo of a room in a home. Be literal and specific.",
    "",
    "Return JSON with:",
    "- roomType: the kind of room shown.",
    "- observations: one entry per visible object, fixture, structure or surface. Give each an id O1, O2, O3 ... in order.",
    "  - feature: what it is (e.g. 'staircase', 'bathtub', 'floor', 'chair', 'window').",
    "  - description: what it looks like and its visible condition, in plain words.",
    "  - location: where it is, and what it is next to, on or under.",
    "  - visibility: full if the whole thing is in frame and clearly seen; partial if part is cut off, hidden or blurry; obscured if it can barely be made out.",
    "  - limitations: what about it the photo does not show.",
    "- unknowns: parts of the room or scene the photo does not show.",
    "",
    "Rules:",
    "- For structures such as stairs, steps, bathtubs, showers, toilets, beds and doorways, say what is attached to or placed next to each visible side, and say when a visible side has nothing.",
    "- Describe the floor and anything lying on it.",
    "- Describe only what you can see. Do not guess about anything out of frame.",
    "- Do not judge whether anything is safe or unsafe, and do not suggest changes or products.",
    "- Do not state properties a photo cannot show, such as how firmly something is fixed, how much weight it holds, or how slippery a surface is. Put those in limitations.",
    "",
    `Room type stated by the user: ${room}.`,
    "Return only JSON that matches the schema.",
  ].join("\n");
}

export interface ObserveResult {
  ok: boolean;
  output?: ObservationOutput;
  /** Raw model text, kept for the results file. */
  raw?: string;
  error?: string;
  model: string;
}

export async function observe(input: { bytes: Uint8Array; mimeType: string; room: RoomType }): Promise<ObserveResult> {
  const model = envOr("sie-vision", "SIE_VISION_MODEL");
  const dataUrl = `data:${input.mimeType};base64,${Buffer.from(input.bytes).toString("base64")}`;
  let raw: string | undefined;
  try {
    const reply = await getSieClient().chatCompletions({
      model,
      messages: [
        { role: "system", content: observationPrompt(input.room) },
        { role: "user", content: [{ type: "image_url", image_url: { url: dataUrl } }] },
      ],
      temperature: 0,
      max_completion_tokens: 4096,
      response_format: { type: "json_schema", json_schema: { name: "visual_observations", strict: true, schema: OBSERVATION_SCHEMA } },
    });
    const content = reply.choices[0]?.message.content;
    if (typeof content !== "string") return { ok: false, error: "No text content in reply.", model };
    raw = content;
    const output = ObservationOutput.parse(JSON.parse(content));
    const ids = output.observations.map((o) => o.id);
    if (new Set(ids).size !== ids.length) return { ok: false, raw, error: "Duplicate observation ids.", model };
    return { ok: true, output, raw, model };
  } catch (e) {
    return { ok: false, raw, error: e instanceof Error ? e.message : String(e), model };
  }
}
