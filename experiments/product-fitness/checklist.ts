/**
 * Fitness checklist for the three products the requirement rules shop for today
 * (src/lib/rules/requirements.ts: R-H09 grab bar, R-H10 non-slip bath mat, R-H11 night light).
 *
 * Every item cites where it comes from. Sources were found with Exa and read on 2026-11-20.
 *
 * How an item is answered (lessons from experiments/hazard-classification/REPORT.md):
 *   - GLiNER2.5 Decide answers ONE positive, single-concept yes/no question per item: "does the
 *     text state X". It can't read negation, so no question says "not", "no" or "without".
 *   - GLiNER never compares numbers. For a numeric item it only finds the passage that states the
 *     value; `extract.ts` parses the number and the rules compare it with the threshold.
 *
 * Item kinds:
 *   gate       must be met. Not stated → needs_verification (never assumed to pass).
 *   red_flag   stated → reject (e.g. a suction-cup "grab bar" that can't carry body weight).
 *   preferred  adds `weight` to the ranking score when met.
 */

export type ProductType = "grab_bar" | "non_slip_bath_mat" | "plug_in_night_light";
export type ItemKind = "gate" | "red_flag" | "preferred";
export type Quantity = "weight_lb" | "diameter_in" | "length_in" | "clearance_in";

export interface Source {
  title: string;
  url: string;
  /** The sentence the item rests on, quoted or closely paraphrased. */
  says: string;
}

export interface ChecklistItem {
  id: string;
  kind: ItemKind;
  /** Plain-language criterion, shown in reports. */
  label: string;
  /**
   * GLiNER noul question(s). Each positive and single-concept. Several questions mean "any of":
   * the item's P(yes) is the max over them. Use that instead of "X or Y" in one question, which
   * GLiNER reads poorly (Wirhao: "suction cups or adhesive?" scored 0.03 on a sheet whose name
   * says "with Suction Cups").
   */
  question: string | string[];
  /** Numeric check, applied to the value parsed from the passages GLiNER flagged. */
  numeric?: { quantity: Quantity; min?: number; max?: number };
  weight: number;
  sources: Source[];
}

export interface ProductChecklist {
  productType: ProductType;
  ruleId: string;
  /** Exa queries. The first is the production rule's own `searchQuery`. */
  queries: string[];
  items: ChecklistItem[];
}

const ADA_609 = "https://www.ada.gov/law-and-regs/design-standards/2010-stds/";
const ADA_609_TEXT = "http://www.ada-compliance.com/ada-compliance/609-grab-bars";
const ASTM_F446 = "https://store.astm.org/f0446-19r23.html";
const NIA = "https://www.nia.nih.gov/health/falls-and-falls-prevention/preventing-falls-home-room-room";
const MEDLINE = "https://medlineplus.gov/ency/patientinstructions/000021.htm";
const SIMPLE_AGING = "https://simpleaging.com/bathroom-safety/non-slip-tub-shower-mats-strips-coatings/";
const LRC_DEMENTIA = "https://pmc.ncbi.nlm.nih.gov/articles/PMC11486553/";
const LRC_BALANCE = "https://pmc.ncbi.nlm.nih.gov/articles/PMC3335369/";
const NIGHT_PATH = "https://www.youretire.com/resources/night-path-bedroom-to-bath-fall-prevention-family-checklist";

export const CHECKLISTS: Record<ProductType, ProductChecklist> = {
  grab_bar: {
    productType: "grab_bar",
    ruleId: "R-H09-grab-bar",
    queries: [
      "ADA compliant stainless steel bathroom grab bar",
      "wall mounted grab bar for bathtub and toilet with 250 lb or 500 lb weight capacity",
      "1.25 inch diameter knurled grab bar for seniors shower",
    ],
    items: [
      {
        id: "gb.is_grab_bar",
        kind: "gate",
        label: "The product is a grab bar",
        question: "Is this product a grab bar?",
        weight: 0,
        sources: [{ title: "ASTM F446-19(2023), scope", url: ASTM_F446, says: "Grab bars and accessories … to assist a person entering, leaving, or moving within the bathing area." }],
      },
      {
        id: "gb.weight_capacity",
        kind: "gate",
        label: "Rated to carry at least 250 lb",
        question: "Does the text state a weight capacity?",
        numeric: { quantity: "weight_lb", min: 250 },
        weight: 0,
        sources: [{ title: "2010 ADA Standards §609.8 Structural Strength", url: ADA_609_TEXT, says: "Allowable stresses shall not be exceeded … when a vertical or horizontal force of 250 pounds (1112 N) is applied at any point on the grab bar, fastener, mounting device, or supporting structure." }],
      },
      {
        id: "gb.screw_mounted",
        kind: "gate",
        label: "Fixed to the wall with screws or anchors",
        // "…with screws?" alone missed HealthCraft's "Easy Mount Anchors" (P 0.34).
        question: ["Does the bar install with screws?", "Does the bar install with wall anchors?"],
        weight: 0,
        sources: [{ title: "2010 ADA Standards §609.8", url: ADA_609_TEXT, says: "The 250 lb force applies to the fastener, mounting device and supporting structure, not only the bar." }],
      },
      {
        id: "gb.suction_mount",
        kind: "red_flag",
        label: "Attaches with suction cups",
        question: "Does the bar attach with suction cups?",
        weight: 0,
        sources: [{ title: "2010 ADA Standards §609.8", url: ADA_609_TEXT, says: "Strength is required of the mounting device as well as the bar; a suction mount can't be rated for that." }],
      },
      {
        id: "gb.diameter",
        kind: "preferred",
        label: "Outside diameter 1¼–2 in",
        question: "Does the text state the diameter of the bar?",
        numeric: { quantity: "diameter_in", min: 1.25, max: 2 },
        weight: 2,
        sources: [{ title: "2010 ADA Standards §609.2.1", url: ADA_609_TEXT, says: "Circular cross sections shall have an outside diameter of 1¼ inches (32 mm) minimum and 2 inches (51 mm) maximum." }],
      },
      {
        id: "gb.wall_clearance",
        kind: "preferred",
        label: "1½ in between the bar and the wall",
        question: "Does the text state the distance between the bar and the wall?",
        numeric: { quantity: "clearance_in", min: 1.5, max: 1.5 },
        weight: 1,
        sources: [{ title: "2010 ADA Standards §609.3", url: ADA_609_TEXT, says: "The space between the wall and the grab bar shall be 1½ inches (38 mm)." }],
      },
      {
        id: "gb.ada_compliant",
        kind: "preferred",
        label: "Claims ADA compliance",
        question: "Does the text say the grab bar is ADA compliant?",
        weight: 1,
        sources: [{ title: "2010 ADA Standards", url: ADA_609, says: "A compliance claim is the maker's, not verified; it only ranks, never gates." }],
      },
      {
        id: "gb.textured_grip",
        kind: "preferred",
        label: "Textured or knurled grip",
        question: "Does the bar have a textured or knurled grip?",
        weight: 1,
        sources: [{ title: "NIA, Preventing Falls at Home", url: NIA, says: "Mount grab bars near toilets and on both the inside and outside of your tub and shower (wet hands: grip matters)." }],
      },
      {
        id: "gb.stainless",
        kind: "preferred",
        label: "Stainless steel (corrosion resistant in a wet room)",
        question: "Is the bar made of stainless steel?",
        weight: 1,
        sources: [{ title: "2010 ADA Standards §609.5 Surface Hazards", url: ADA_609_TEXT, says: "Grab bars … shall be free of sharp or abrasive elements (corrosion creates them)." }],
      },
    ],
  },

  non_slip_bath_mat: {
    productType: "non_slip_bath_mat",
    ruleId: "R-H10-nonslip-mat",
    queries: [
      "non-slip bath mat with suction cups for bathtub",
      "non-slip bathtub mat with drainage holes machine washable",
      "anti-slip adhesive bathtub treads strips for elderly",
    ],
    items: [
      {
        id: "mat.in_tub",
        kind: "gate",
        label: "Made for use inside the tub or shower",
        question: "Is this a mat or strips for inside a bathtub or shower?",
        weight: 0,
        sources: [
          { title: "MedlinePlus, Bathroom safety for adults", url: MEDLINE, says: "Put non-slip suction mats or rubber silicone decals in the bottom of your tub to prevent falls." },
          { title: "NIA, Preventing Falls at Home", url: NIA, says: "Place nonskid mats, strips, or carpet on all surfaces that may get wet." },
        ],
      },
      {
        id: "mat.suction_or_adhesive",
        kind: "gate",
        label: "Holds with suction cups or adhesive",
        question: ["Does the mat have suction cups?", "Does the product stick to the tub with adhesive?"],
        weight: 0,
        sources: [{ title: "Simple Aging, Non-slip bathtub and shower options", url: SIMPLE_AGING, says: "Suction cups underneath … A textured surface with an adhesive back that sticks to the tub." }],
      },
      {
        id: "mat.surfaces_listed",
        kind: "preferred",
        label: "States which tub surfaces it works on",
        question: "Does the text say which tub surfaces the product works on?",
        weight: 3,
        sources: [{ title: "Simple Aging", url: SIMPLE_AGING, says: "Surfaces it's made for. The most important detail. Check smooth or textured, and the tub material, against the maker's list." }],
      },
      {
        id: "mat.drainage",
        kind: "preferred",
        label: "Drainage holes",
        question: "Does the mat have drainage holes?",
        weight: 2,
        sources: [{ title: "Simple Aging", url: SIMPLE_AGING, says: "Drainage. Holes that let water flow to the drain instead of sitting under the mat." }],
      },
      {
        id: "mat.size_stated",
        kind: "preferred",
        label: "States its size",
        question: "Does the text state the size of the mat?",
        weight: 1,
        sources: [{ title: "Simple Aging", url: SIMPLE_AGING, says: "Size and coverage. Measure the flat part of the tub or shower floor." }],
      },
      {
        id: "mat.washable",
        kind: "preferred",
        label: "Machine washable or care instructions given",
        question: "Is the mat machine washable?",
        weight: 1,
        sources: [{ title: "Simple Aging", url: SIMPLE_AGING, says: "Care. Whether a mat can go in the washing machine, and which cleaners a strip or coating can take." }],
      },
      {
        id: "mat.slip_test",
        kind: "preferred",
        label: "Publishes a slip-resistance test or certification",
        question: "Does the text mention a slip resistance test or certification?",
        weight: 2,
        sources: [{ title: "Simple Aging, citing CPSC", url: SIMPLE_AGING, says: "The ASTM slip-resistance standard for bathtubs and showers was withdrawn in 2016 … 'non-slip' on a package can mean different things. Look for … any test results they publish." }],
      },
    ],
  },

  plug_in_night_light: {
    productType: "plug_in_night_light",
    ruleId: "R-H11-night-light",
    queries: [
      "motion sensor plug-in LED night light",
      "dusk to dawn plug-in night light warm amber LED for hallway and bedroom",
      "plug-in night light for elderly bed to bathroom path",
    ],
    items: [
      {
        id: "nl.is_night_light",
        kind: "gate",
        label: "A plug-in night light",
        question: "Is this product a plug-in night light?",
        weight: 0,
        sources: [{ title: "NIA, Preventing Falls at Home", url: NIA, says: "Consider using motion-activated lights that plug into electrical outlets." }],
      },
      {
        id: "nl.automatic",
        kind: "gate",
        label: "Turns on by itself (motion or dusk-to-dawn sensor)",
        question: "Does the light turn on automatically with a motion or light sensor?",
        weight: 0,
        sources: [
          { title: "NIA, Preventing Falls at Home", url: NIA, says: "Use a night light that turns on automatically in the dark … motion-activated lights … automatically turn on when you walk by them." },
          { title: "Night Path checklist", url: NIGHT_PATH, says: "A light that has to be remembered, found, and switched on in the dark tends not to get used." },
        ],
      },
      {
        id: "nl.motion_sensor",
        kind: "preferred",
        label: "Motion sensor",
        question: "Does the light have a motion sensor?",
        weight: 2,
        sources: [{ title: "NIA, Preventing Falls at Home", url: NIA, says: "Motion-activated lights … help illuminate stairwells and pathways." }],
      },
      {
        id: "nl.warm_amber",
        kind: "preferred",
        label: "Warm white or amber light",
        question: "Does the light give warm white or amber light?",
        weight: 1,
        sources: [
          { title: "Zimmerman et al. 2024 (LRC amber doorframe lighting)", url: LRC_DEMENTIA, says: "Amber LEDs at nightlight brightness; 34% fewer night falls than standard 2700 K nightlights (not significant, p=0.18)." },
          { title: "Figueiro et al., Age and Ageing", url: LRC_BALANCE, says: "Amber LED cues improved sit-to-stand weight transfer vs. wall-plug nightlights." },
        ],
      },
      {
        id: "nl.low_glare",
        kind: "preferred",
        label: "Directs light down at the floor (low glare)",
        question: "Does the light shine downward onto the floor?",
        weight: 1,
        sources: [
          { title: "Night Path checklist", url: NIGHT_PATH, says: "Low, outlet-level night lights that light the floor are usually easier on eyes that have just opened." },
          { title: "Zimmerman et al. 2024", url: LRC_DEMENTIA, says: "A small lip removed direct view of the light to prevent glare." },
        ],
      },
      {
        id: "nl.adjustable",
        kind: "preferred",
        label: "Adjustable brightness",
        question: "Does the light have adjustable brightness?",
        weight: 1,
        sources: [{ title: "Night Path checklist", url: NIGHT_PATH, says: "Check the brightness and motion settings at night along the actual route." }],
      },
      {
        id: "nl.safety_listed",
        kind: "preferred",
        label: "UL or ETL safety listing",
        question: "Is the product UL or ETL listed?",
        weight: 1,
        // UL 1786 (Direct Plug-In Nightlights) is the product standard. Not fetched in this search.
        sources: [{ title: "UL 1786, Direct Plug-In Nightlights (standard named, page not fetched)", url: "https://www.shopulstandards.com/ProductDetail.aspx?productId=UL1786", says: "Electrical safety standard for plug-in nightlights." }],
      },
    ],
  },
};

export const PRODUCT_TYPES = Object.keys(CHECKLISTS) as ProductType[];

export const questionsOf = (it: ChecklistItem): string[] => (Array.isArray(it.question) ? it.question : [it.question]);
