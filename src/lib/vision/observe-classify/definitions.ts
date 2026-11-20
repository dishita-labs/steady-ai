/**
 * H01–H11 definitions for the experimental classifier.
 *
 * `visible` / `notVisible` are copied verbatim from the frozen taxonomy
 * (steady-prep/data/source/grok-v1-frozen/hazard_taxonomy.json, CDC STEADI "Check for Safety").
 *
 * GLiNER only labels short POSITIVE phrases (PART_ROLES, ITEM_TYPES). Probes on 2026-11-20 showed
 * Decide can't tell "stated absent" from "not mentioned", and sometimes inverts negation, so
 * absence comes from Gemma's explicit empty `items` lists and the rules in validate.ts.
 */

import { HAZARD_CATEGORIES, type HazardCategoryId, type Severity } from "../../../types/domain";

export interface CategorySpec {
  id: HazardCategoryId;
  name: (typeof HAZARD_CATEGORIES)[HazardCategoryId];
  /** Taxonomy: what a photo can show. */
  visible: string;
  /** Taxonomy: what a photo cannot establish. Copied into `notEstablishedFromPhoto`. */
  notVisible: string;
  /**
   * Whether a photo can ever establish absence. False when the taxonomy says the deciding fact is
   * not visible (H04: switches at top and bottom, working bulbs), so the best outcome is
   * cannot_determine.
   */
  absenceEstablishable: boolean;
  /** Bears weight or installs into a wall (mirrors the production vision prompt's rule). */
  professionalAssessment: boolean;
  /**
   * The finding contract needs a severity, but this pipeline does no risk scoring. This is a fixed
   * PLACEHOLDER per category, not a model output. See the report's integration notes.
   */
  placeholderSeverity: Severity;
}

export const CATEGORY_SPECS: Record<HazardCategoryId, CategorySpec> = {
  H01: {
    id: "H01",
    name: HAZARD_CATEGORIES.H01,
    visible: "Items resting on treads or landings (shoes, laundry, books, boxes, boards).",
    notVisible: "Whether items are habitually left there vs. momentarily; items outside the frame.",
    absenceEstablishable: true,
    professionalAssessment: false,
    placeholderSeverity: "moderate",
  },
  H02: {
    id: "H02",
    name: HAZARD_CATEGORIES.H02,
    visible: "Absence of a handrail; handrail on only one side; handrail visibly shorter than the stair run.",
    notVisible: "Whether a handrail is loose, anchored, or structurally sound; handrail height/graspability; sides out of frame.",
    absenceEstablishable: true,
    professionalAssessment: true,
    placeholderSeverity: "high",
  },
  H03: {
    id: "H03",
    name: HAZARD_CATEGORIES.H03,
    visible: "Visibly broken/missing treads, obvious unevenness, torn or lifted carpet, makeshift ramps laid over steps.",
    notVisible: "Small rise/run differences, looseness of treads or carpet, surface slipperiness, worn paint's effect on traction.",
    absenceEstablishable: true,
    professionalAssessment: true,
    placeholderSeverity: "high",
  },
  H04: {
    id: "H04",
    name: HAZARD_CATEGORIES.H04,
    visible: "Presence of fixtures near the stairs; obviously dark stairwell in the photo.",
    notVisible: "Whether switches exist at both top and bottom, whether bulbs work, real night-time light levels (camera exposure distorts brightness).",
    absenceEstablishable: false,
    professionalAssessment: true,
    placeholderSeverity: "moderate",
  },
  H05: {
    id: "H05",
    name: HAZARD_CATEGORIES.H05,
    visible: "Objects on the floor in or near the walking path.",
    notVisible: "Whether clutter is temporary; objects hidden by furniture or out of frame.",
    absenceEstablishable: true,
    professionalAssessment: false,
    placeholderSeverity: "moderate",
  },
  H06: {
    id: "H06",
    name: HAZARD_CATEGORIES.H06,
    visible: "Presence of loose/small rugs or mats; visibly curled or lifted edges.",
    notVisible: "Whether the rug has a non-slip backing or tape (label 'present' means a throw rug is visible; it does NOT confirm it is unsecured).",
    absenceEstablishable: true,
    professionalAssessment: false,
    placeholderSeverity: "moderate",
  },
  H07: {
    id: "H07",
    name: HAZARD_CATEGORIES.H07,
    visible: "Cords or power strips lying on the floor, especially crossing a walking path.",
    notVisible: "Cords hidden under rugs/furniture; whether cord is taped down (often not resolvable).",
    absenceEstablishable: true,
    professionalAssessment: false,
    placeholderSeverity: "moderate",
  },
  H08: {
    id: "H08",
    name: HAZARD_CATEGORIES.H08,
    visible: "Furniture obstructing an evident walking route.",
    notVisible: "Actual routes the resident uses; mobility aids; full room layout outside frame.",
    absenceEstablishable: true,
    professionalAssessment: false,
    placeholderSeverity: "low",
  },
  H09: {
    id: "H09",
    name: HAZARD_CATEGORIES.H09,
    visible: "Presence/absence of grab bars on visible walls next to/inside tub or shower and next to toilet.",
    notVisible: "Anchoring into studs/blocking, load rating, whether a bar is a grab bar or a towel bar when ambiguous, walls out of frame, the resident's actual need for support.",
    absenceEstablishable: true,
    professionalAssessment: true,
    placeholderSeverity: "high",
  },
  H10: {
    id: "H10",
    name: HAZARD_CATEGORIES.H10,
    visible: "Whether a non-slip mat or adhesive strips are visible on the tub/shower floor.",
    notVisible: "Actual slipperiness / coefficient of friction; factory-textured surfaces; whether a mat is suction-secured. 'present' = no mat/strips visible on a visible tub/shower floor, NOT 'confirmed slippery'.",
    absenceEstablishable: true,
    professionalAssessment: false,
    placeholderSeverity: "moderate",
  },
  H11: {
    id: "H11",
    name: HAZARD_CATEGORIES.H11,
    visible: "Whether a lamp is visible within arm's reach of the bed.",
    notVisible: "Whether the lamp works; nightlights out of frame; darkness of the path to the bathroom at night; switch locations.",
    absenceEstablishable: true,
    professionalAssessment: false,
    placeholderSeverity: "moderate",
  },
};

export const CATEGORY_IDS = Object.keys(CATEGORY_SPECS) as HazardCategoryId[];

/**
 * Plain-language finding text shown to the family (src/ui/view.ts renders `summary`, prefixed with
 * "I can't tell from the photo: " for cannot_determine). Wording follows the taxonomy's `visible`.
 */
export const FINDING_TEXT: Record<HazardCategoryId, string> = {
  H01: "Objects resting on the stairs",
  H02: "Stairs with no handrail on at least one side",
  H03: "Broken, uneven or damaged steps",
  H04: "Whether the stairs have a light and switch at the top and bottom",
  H05: "Loose objects on the floor",
  H06: "A throw rug or mat on the floor",
  H07: "Cords or wires on the floor",
  H08: "Furniture in a walking path",
  H09: "No grab bar by the tub, shower or toilet",
  H10: "No non-slip mat or strips in the tub or shower",
  H11: "No lamp within reach of the bed",
};


/** What a structure part is. GLiNER `choice` over `<feature>: <part>`. */
export const PART_ROLES = {
  stair_side: "the left or right side of a staircase or steps",
  stair_treads: "the treads or surface of stairs or steps",
  bath_wall: "a wall next to or inside a bathtub, shower or toilet",
  bath_floor: "the floor inside a bathtub or shower",
  bedside: "the space beside a bed",
  open_floor: "an open floor area or walkway",
  other: "something else",
} as const;
export type PartRole = keyof typeof PART_ROLES;

/** What an item listed on a part is. GLiNER `choice` over the item's few words. */
export const ITEM_TYPES = {
  handrail: "a handrail, railing or banister",
  grab_bar: "a grab bar",
  towel_bar: "a towel bar or towel rack",
  bath_mat: "a bath mat or non-slip strips",
  lamp: "a lamp or light",
  cord: "an electrical cord, cable, wire or power strip",
  rug: "a rug, runner, mat or doormat",
  /** Fitted floor covering: neither clutter nor a throw rug (D05 "red carpet" read 0.45 as a rug). */
  carpet: "wall-to-wall carpet or stair carpet",
  loose_object: "shoes, papers, books, boxes, bags, laundry, toys or other loose objects",
  furniture: "furniture or a large appliance",
  plant_decor: "a plant, flower pot or decoration",
  fixture: "a fixture or fitting such as a faucet, outlet, switch, vent or soap dish",
  other: "something else",
} as const;
export type ItemType = keyof typeof ITEM_TYPES;
