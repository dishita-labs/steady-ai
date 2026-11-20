/**
 * H01–H11 definitions for the experimental classifier.
 *
 * `visible` / `notVisible` are copied verbatim from the frozen taxonomy
 * (steady-prep/data/source/grok-v1-frozen/hazard_taxonomy.json, CDC STEADI "Check for Safety").
 * `area`, `hazard` and `clear` are the narrow GLiNER criteria derived from them: they describe what
 * an OBSERVATION says, so the classifier maps text to a category without judging risk itself.
 */

import { HAZARD_CATEGORIES, type HazardCategoryId, type Severity } from "../../src/types/domain";

export interface CategorySpec {
  id: HazardCategoryId;
  name: (typeof HAZARD_CATEGORIES)[HazardCategoryId];
  /** Taxonomy: what a photo can show. */
  visible: string;
  /** Taxonomy: what a photo cannot establish. Copied into `notEstablishedFromPhoto`. */
  notVisible: string;
  /** The part of the scene the category is about. */
  area: string;
  /** GLiNER criterion: the observation describes the hazard condition. */
  hazard: string;
  /** GLiNER criterion: the observation describes the area and the condition is not there. */
  clear: string;
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
    area: "stairs or steps",
    hazard: "Objects such as shoes, papers, boxes or laundry rest on the stair treads or landing.",
    clear: "The stair treads are described and nothing rests on them.",
    absenceEstablishable: true,
    professionalAssessment: false,
    placeholderSeverity: "moderate",
  },
  H02: {
    id: "H02",
    name: HAZARD_CATEGORIES.H02,
    visible: "Absence of a handrail; handrail on only one side; handrail visibly shorter than the stair run.",
    notVisible: "Whether a handrail is loose, anchored, or structurally sound; handrail height/graspability; sides out of frame.",
    area: "the sides of stairs or steps",
    hazard: "A side of the stairs or steps has no handrail, or there is a handrail on only one side.",
    clear: "Both sides of the stairs or steps are described and each has a handrail.",
    absenceEstablishable: true,
    professionalAssessment: true,
    placeholderSeverity: "high",
  },
  H03: {
    id: "H03",
    name: HAZARD_CATEGORIES.H03,
    visible: "Visibly broken/missing treads, obvious unevenness, torn or lifted carpet, makeshift ramps laid over steps.",
    notVisible: "Small rise/run differences, looseness of treads or carpet, surface slipperiness, worn paint's effect on traction.",
    area: "the stair treads",
    hazard: "A step is broken, missing or obviously uneven, or the stair carpet is torn or lifted.",
    clear: "The steps are described as intact and even.",
    absenceEstablishable: true,
    professionalAssessment: true,
    placeholderSeverity: "high",
  },
  H04: {
    id: "H04",
    name: HAZARD_CATEGORIES.H04,
    visible: "Presence of fixtures near the stairs; obviously dark stairwell in the photo.",
    notVisible: "Whether switches exist at both top and bottom, whether bulbs work, real night-time light levels (camera exposure distorts brightness).",
    area: "lighting at the stairs",
    hazard: "The stairway is dark or no light fixture is near the stairs.",
    clear: "A light fixture is near the stairs and the stairs are lit.",
    absenceEstablishable: false,
    professionalAssessment: true,
    placeholderSeverity: "moderate",
  },
  H05: {
    id: "H05",
    name: HAZARD_CATEGORIES.H05,
    visible: "Objects on the floor in or near the walking path.",
    notVisible: "Whether clutter is temporary; objects hidden by furniture or out of frame.",
    area: "the floor or a walking path",
    hazard: "Loose objects lie on the floor in or near an open walking area.",
    clear: "The floor is described and nothing loose lies on it.",
    absenceEstablishable: true,
    professionalAssessment: false,
    placeholderSeverity: "moderate",
  },
  H06: {
    id: "H06",
    name: HAZARD_CATEGORIES.H06,
    visible: "Presence of loose/small rugs or mats; visibly curled or lifted edges.",
    notVisible: "Whether the rug has a non-slip backing or tape (label 'present' means a throw rug is visible; it does NOT confirm it is unsecured).",
    area: "rugs or mats on the floor",
    hazard: "A small or loose rug or mat lies on the floor.",
    clear: "The floor is described and has no rug or mat.",
    absenceEstablishable: true,
    professionalAssessment: false,
    placeholderSeverity: "moderate",
  },
  H07: {
    id: "H07",
    name: HAZARD_CATEGORIES.H07,
    visible: "Cords or power strips lying on the floor, especially crossing a walking path.",
    notVisible: "Cords hidden under rugs/furniture; whether cord is taped down (often not resolvable).",
    area: "cords or wires on the floor",
    hazard: "Cords, wires or a power strip lie on the floor.",
    clear: "The floor is described and no cords or wires lie on it.",
    absenceEstablishable: true,
    professionalAssessment: false,
    placeholderSeverity: "moderate",
  },
  H08: {
    id: "H08",
    name: HAZARD_CATEGORIES.H08,
    visible: "Furniture obstructing an evident walking route.",
    notVisible: "Actual routes the resident uses; mobility aids; full room layout outside frame.",
    area: "a walking route through the room",
    hazard: "Furniture blocks or narrows an evident walking route.",
    clear: "A walking route is described and it is open.",
    absenceEstablishable: true,
    professionalAssessment: false,
    placeholderSeverity: "low",
  },
  H09: {
    id: "H09",
    name: HAZARD_CATEGORIES.H09,
    visible: "Presence/absence of grab bars on visible walls next to/inside tub or shower and next to toilet.",
    notVisible: "Anchoring into studs/blocking, load rating, whether a bar is a grab bar or a towel bar when ambiguous, walls out of frame, the resident's actual need for support.",
    area: "walls next to a bathtub, shower or toilet",
    hazard: "The wall next to or inside a tub, shower or toilet is visible and has no grab bar.",
    clear: "A grab bar is mounted next to the tub, shower or toilet.",
    absenceEstablishable: true,
    professionalAssessment: true,
    placeholderSeverity: "high",
  },
  H10: {
    id: "H10",
    name: HAZARD_CATEGORIES.H10,
    visible: "Whether a non-slip mat or adhesive strips are visible on the tub/shower floor.",
    notVisible: "Actual slipperiness / coefficient of friction; factory-textured surfaces; whether a mat is suction-secured. 'present' = no mat/strips visible on a visible tub/shower floor, NOT 'confirmed slippery'.",
    area: "the floor of a bathtub or shower",
    hazard: "The tub or shower floor is visible and has no mat or strips on it.",
    clear: "A mat or adhesive strips are on the tub or shower floor.",
    absenceEstablishable: true,
    professionalAssessment: false,
    placeholderSeverity: "moderate",
  },
  H11: {
    id: "H11",
    name: HAZARD_CATEGORIES.H11,
    visible: "Whether a lamp is visible within arm's reach of the bed.",
    notVisible: "Whether the lamp works; nightlights out of frame; darkness of the path to the bathroom at night; switch locations.",
    area: "a bed and what is beside it",
    hazard: "A bed is visible and no lamp is within reach of it.",
    clear: "A lamp is within reach of the bed.",
    absenceEstablishable: true,
    professionalAssessment: false,
    placeholderSeverity: "moderate",
  },
};

export const CATEGORY_IDS = Object.keys(CATEGORY_SPECS) as HazardCategoryId[];

/**
 * Categories asked together in one GLiNER call. Answers in one call influence each other, and
 * text + questions must fit Decide's 512-token window, so groups stay small and topical.
 */
export const QUESTION_GROUPS: HazardCategoryId[][] = [
  ["H01", "H02"],
  ["H03", "H04"],
  ["H05", "H06"],
  ["H07", "H08"],
  ["H09", "H10"],
  ["H11"],
];
