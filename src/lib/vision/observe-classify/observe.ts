/**
 * Stage 1: Gemma 4 (SIE `chatCompletions`) describes what is visible. NO hazard judgement.
 *
 * The prompt never names H01–H11, never asks about safety or risk, and asks the model to state
 * what it cannot see. Same call pattern as the production analyzer (src/lib/vision/index.ts):
 * temperature 0 and a strict JSON-schema response_format.
 */

import { z } from "zod";
import { envOr } from "../../config";
import { getSieClient } from "../../sie";
import type { RoomType } from "../../../types/domain";

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
        required: ["id", "feature", "description", "location", "visibility", "limitations", "parts"],
        properties: {
          id: { type: "string" },
          feature: { type: "string" },
          description: { type: "string" },
          location: { type: "string" },
          visibility: { type: "string", enum: VISIBILITY },
          limitations: { type: "array", items: { type: "string" } },
          parts: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["part", "visibility", "items"],
              properties: {
                part: { type: "string" },
                visibility: { type: "string", enum: VISIBILITY },
                items: { type: "array", items: { type: "string" } },
              },
            },
          },
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
      /** Structures only. An EMPTY `items` list on a visible part means "visible, nothing there". */
      parts: z.array(z.object({ part: z.string().min(1), visibility: z.enum(VISIBILITY), items: z.array(z.string()) })),
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
    "  - parts: only for these structures: stairs or steps, a bathtub or shower, a toilet, a bed, and the floor. For anything else, use an empty list.",
    "    One entry per part of the structure: for example each side (left side, right side), the treads, the walls around it, the floor inside it, the space beside it, the open floor area.",
    "    - part: which part it is.",
    "    - visibility: full, partial or obscured, for that part alone.",
    "    - items: every object that is on, attached to, or directly beside that part, in a few words each. Use an EMPTY list when the part is clearly visible and has nothing on or beside it.",
    "- unknowns: parts of the room or scene the photo does not show.",
    "",
    "Rules:",
    "- Always include the floor as an observation when any floor is visible, with its parts and what lies on it.",
    "- A part that is out of frame or hidden is not listed as empty: give it visibility partial or obscured, or leave it out and mention it in unknowns.",
    "- Describe only what you can see. Do not guess about anything out of frame.",
    "- Do not judge whether anything is safe or unsafe, and do not suggest changes or products.",
    "- Do not state properties a photo cannot show, such as how firmly something is fixed, how much weight it holds, or how slippery a surface is. Put those in limitations.",
    "",
    `Room type stated by the user: ${room}.`,
    "Return only JSON that matches the schema.",
  ].join("\n");
}

/**
 * Gemma's reply broke the observation contract (no text, unparseable, wrong shape, duplicate ids).
 * `fatal`: the Workflow SDK won't retry it; the same photo usually gives the same broken output.
 */
export class ObservationContractError extends Error {
  readonly fatal = true;
  constructor(
    message: string,
    readonly raw?: string,
  ) {
    super(message);
    this.name = "ObservationContractError";
  }
}

export interface Described {
  output: ObservationOutput;
  /** Raw model text. */
  raw: string;
  model: string;
  /** Provider request id, when returned. */
  externalRef?: string;
}

/**
 * Describe the photo. Throws: transport/SDK errors as they are (retryable unless permanent), and
 * `ObservationContractError` (fatal) when the reply breaks the contract.
 */
export async function describeImage(input: { bytes: Uint8Array; mimeType: string; room: RoomType }): Promise<Described> {
  const model = envOr("sie-vision", "SIE_VISION_MODEL");
  const dataUrl = `data:${input.mimeType};base64,${Buffer.from(input.bytes).toString("base64")}`;
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
  const raw = reply.choices[0]?.message.content;
  if (typeof raw !== "string") throw new ObservationContractError("No text content in reply.");
  let output: ObservationOutput;
  try {
    output = ObservationOutput.parse(JSON.parse(raw));
  } catch (e) {
    throw new ObservationContractError(`Observation output invalid: ${e instanceof Error ? e.message : String(e)}`, raw);
  }
  const ids = output.observations.map((o) => o.id);
  if (new Set(ids).size !== ids.length) throw new ObservationContractError("Duplicate observation ids.", raw);
  return { output, raw, model, externalRef: (reply as { id?: string }).id };
}

/** Never throws; for the experiment runner. */
export interface ObserveResult {
  ok: boolean;
  output?: ObservationOutput;
  /** Raw model text, kept for the results file. */
  raw?: string;
  error?: string;
  model: string;
}

export async function observe(input: { bytes: Uint8Array; mimeType: string; room: RoomType }): Promise<ObserveResult> {
  try {
    const d = await describeImage(input);
    return { ok: true, output: d.output, raw: d.raw, model: d.model };
  } catch (e) {
    return { ok: false, raw: e instanceof ObservationContractError ? e.raw : undefined, error: e instanceof Error ? e.message : String(e), model: envOr("sie-vision", "SIE_VISION_MODEL") };
  }
}
