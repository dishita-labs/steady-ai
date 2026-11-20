/**
 * Reference answers for (page, checklist item).
 *
 *   gold    labels.json in this folder, written by a person who read the page. Committed.
 *   silver  keyword patterns below, run over the whole page text. Cheap, transparent, and
 *           wrong in known ways (it can't tell "no suction cups needed" from "suction cups").
 *           Used to pre-fill the labelling template and as a clearly marked second reference,
 *           never mixed with gold in one number.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProductType } from "./checklist";

export type Label = "yes" | "no";

export interface GoldPage {
  productType: ProductType;
  title?: string;
  /** itemId → label. Missing items are unlabelled, not "no". */
  items: Record<string, Label>;
  labeledBy: string;
  at: string;
}

export interface GoldFile {
  /** url → labels */
  pages: Record<string, GoldPage>;
}

export const GOLD_PATH = join("experiments", "product-fitness", "labels.json");

export async function loadGold(path = GOLD_PATH): Promise<GoldFile> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as GoldFile;
  } catch {
    return { pages: {} };
  }
}

/** Silver patterns: "yes" when any pattern matches the page text. */
export const SILVER: Record<string, RegExp[]> = {
  "gb.is_grab_bar": [/grab ?bar/i],
  "gb.weight_capacity": [/\d{2,4}\s*(?:lbs?|pounds?|kg)\b[^.]{0,40}(?:capacity|support|load|rated)|(?:capacity|support|load|rated|holds?)[^.]{0,40}\d{2,4}\s*(?:lbs?|pounds?|kg)\b/i],
  "gb.screw_mounted": [/screws?|anchors?|wall mount|mounting hardware|concealed (?:flange|mount)/i],
  "gb.suction_mount": [/suction/i],
  "gb.diameter": [/diameter|\bdia\b|Ø/i],
  "gb.wall_clearance": [/clearance|from (?:the )?wall|wall clearance/i],
  "gb.ada_compliant": [/\bADA\b/],
  "gb.textured_grip": [/knurl|textured|anti-?slip grip|non-?slip grip|grip(?:ping)? surface/i],
  "gb.stainless": [/stainless/i],
  "mat.in_tub": [/(?:bath ?tub|tub|shower)[^.]{0,30}(?:mat|strip|tread|appliqu)/i, /(?:mat|strip|tread)s?[^.]{0,30}(?:bath ?tub|tub|shower)/i],
  "mat.suction_or_adhesive": [/suction|adhesive|self-?stick/i],
  "mat.surfaces_listed": [/smooth|textured|non-?textured|tiled?|fiberglass|acrylic|porcelain|enamel|refinished/i],
  "mat.drainage": [/drain(?:age)? holes?|drain(?:s)? water|holes? (?:for|to) drain/i],
  "mat.size_stated": [/\d+(?:\.\d+)?\s*(?:"|in|inch(?:es)?|cm)\s*(?:x|×|by)\s*\d+/i],
  "mat.washable": [/machine[- ]washable|washing machine/i],
  "mat.slip_test": [/NFSI|ASTM|DIN 51097|slip[- ]resistance test|certified slip|coefficient of friction|tested/i],
  "nl.is_night_light": [/night ?light/i],
  "nl.automatic": [/motion|dusk[- ]to[- ]dawn|light sensor|auto(?:matic(?:ally)?)? (?:on|off)|photocell/i],
  "nl.motion_sensor": [/motion/i],
  "nl.warm_amber": [/warm white|amber|\b2[0-9]00\s*K\b|soft white|warm light/i],
  "nl.low_glare": [/down(?:ward)?[- ]facing|shines? down|floor[- ]level|glare|downlight|lights? the floor/i],
  "nl.adjustable": [/adjustable|dimmable|brightness (?:levels?|settings?)|dimmer/i],
  "nl.safety_listed": [/\bUL\b|\bETL\b|\bcUL\b/],
};

export function silverLabel(itemId: string, text: string): { label: Label; snippet?: string } {
  for (const re of SILVER[itemId] ?? []) {
    const m = text.match(re);
    if (m) {
      const i = m.index ?? 0;
      return { label: "yes", snippet: text.slice(Math.max(0, i - 80), i + m[0].length + 80).replace(/\s+/g, " ").trim() };
    }
  }
  return { label: "no" };
}
