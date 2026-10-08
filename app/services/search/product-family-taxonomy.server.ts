import { normalizeQueryText } from "./deterministic-query-parser.server";

/**
 * Small, explicit taxonomy bridge for source-owned broad nouns. This is NOT
 * inferred from the LLM's list of suggested product categories.
 *
 * Shopify's own Standard Product Category is the preferred product evidence.
 * When it is absent, the exact sold-item canonical type (or merchant type)
 * may still establish membership. A tag, alias, context, vendor or embedding
 * must never establish product-family membership.
 *
 * Extend this hierarchy with verified category examples and regression tests,
 * rather than inserting LLM-generated siblings at query time.
 */
export type FamilyNode =
  | "dress" | "skirt" | "top" | "bicycle" | "car" | "motorcycle"
  | "scooter" | "truck" | "bus" | "van";

export type FamilyGroup =
  | "dress_or_skirt" | "tops" | "vehicles"
  | "dress" | "skirt" | "bicycle";

const GROUP_MEMBERS: Record<FamilyGroup, readonly FamilyNode[]> = {
  dress_or_skirt: ["dress", "skirt"],
  tops: ["top"],
  vehicles: ["bicycle", "car", "motorcycle", "scooter", "truck", "bus", "van"],
  dress: ["dress"],
  skirt: ["skirt"],
  bicycle: ["bicycle"],
};

/** Exact standalone source expressions. Phrases containing modifiers never match. */
const QUERY_FAMILIES: Record<string, FamilyGroup> = {
  "vay": "dress_or_skirt",       // Vietnamese broad "váy": dress OR skirt
  "dam": "dress",                // "đầm": dress, not skirt
  "chan vay": "skirt",           // "chân váy": skirt, not dress
  "ao": "tops",                  // "áo": upper-body clothing
  "xe": "vehicles",              // vehicles, not spare parts or toy cars
  "xe dap": "bicycle",
};

const ACCESSORY_OR_TOY =
  /\b(?:accessor(?:y|ies)|parts?|component|replacement|spare|helmet|basket|wheel|tire|tyre|brake|pad|case|cover|mount|holder|rack|lock|chain|toy|toys|model|miniature|replica|costume)\b/;

/** Only sold-item head words / type suffixes, never "contains" matching. */
const FAMILY_HEADS: Record<FamilyNode, readonly string[]> = {
  dress: ["dress", "dresses", "gown", "gowns", "sundress", "sundresses", "dam"],
  skirt: ["skirt", "skirts", "chan vay"],
  top: [
    "shirt", "shirts", "t shirt", "t shirts", "tee", "tees",
    "blouse", "blouses", "top", "tops", "jacket", "jackets",
    "coat", "coats", "sweater", "sweaters", "cardigan", "cardigans",
    "hoodie", "hoodies", "sweatshirt", "sweatshirts", "polo",
    "vest", "vests", "tank top", "tank tops", "tunic", "tunics",
    "ao", "ao khoac", "ao so mi", "ao thun", "ao len", "ao ni",
  ],
  bicycle: [
    "bicycle", "bicycles", "cycle", "cycles", "mountain bike",
    "road bike", "city bike", "electric bike", "e bike",
    "xe dap", "xe dap dien",
  ],
  car: ["car", "cars", "automobile", "automobiles", "sedan", "sedans", "suv", "suvs", "xe oto", "oto"],
  motorcycle: ["motorcycle", "motorcycles", "motorbike", "motorbikes", "dirt bike", "dirt bikes", "xe may"],
  scooter: ["scooter", "scooters", "moped", "mopeds", "xe tay ga"],
  truck: ["truck", "trucks", "pickup truck", "pickup trucks", "xe tai"],
  bus: ["bus", "buses", "coach", "coaches", "xe buyt"],
  van: ["van", "vans", "minivan", "minivans", "xe van"],
};

const APPAREL_CATEGORY_SEGMENTS = new Set(["clothing", "apparel", "quan ao"]);
const CATEGORY_SUBGROUP_DENIAL =
  /\b(?:accessor(?:y|ies)|costume|toy|toys|parts?|replacement|decorations?|equipment)\b/;

export function queryFamilyFromSource(query: string): FamilyGroup | null {
  return QUERY_FAMILIES[normalizeQueryText(query)] ?? null;
}

function suffixMatches(actual: string, suffix: string) {
  return actual === suffix || actual.endsWith(" " + suffix);
}

/**
 * A hierarchical Shopify taxonomy fullName is field-typed evidence.
 * It must not turn "Bicycle Accessories" into a bicycle, or "Toy Cars"
 * into actual vehicles merely because a parent/leaf mentions cars.
 */
export function classifySoldItemLeaf(raw: string): FamilyNode | null {
  const value = normalizeQueryText(raw);
  if (!value || ACCESSORY_OR_TOY.test(value)) return null;
  for (const [node, heads] of Object.entries(FAMILY_HEADS) as Array<[FamilyNode, readonly string[]]>) {
    if (heads.some((head) => suffixMatches(value, normalizeQueryText(head)))) {
      return node;
    }
  }
  return null;
}

function shopifyCategoryParts(path: string) {
  return path.split(/\s*(?:>|»)\s*/).map(normalizeQueryText).filter(Boolean);
}
function forbiddenCategoryBranch(parts: string[]) {
  return parts.some((part, index) =>
    // Shopify's standard roots "Apparel & Accessories" and "Vehicles & Parts"
    // are neutral roots, NOT evidence that a Dress/Car is an accessory/part.
    !(index === 0 && ["apparel accessories", "vehicles parts"].includes(part)) &&
    CATEGORY_SUBGROUP_DENIAL.test(part)
  );
}

export function shopifyCategoryLeaf(path: string): FamilyNode | null {
  const segments = shopifyCategoryParts(path);
  if (!segments.length || forbiddenCategoryBranch(segments)) {
    return null;
  }
  return classifySoldItemLeaf(segments.at(-1) ?? "");
}

export function shopifyCategoryIsClothing(path: string) {
  const segments = shopifyCategoryParts(path);
  if (forbiddenCategoryBranch(segments)) return false;
  // Require a typed Clothing/Apparel ancestor (or actual clothing leaf).
  return segments.some((segment) => APPAREL_CATEGORY_SEGMENTS.has(segment)) &&
    segments.length >= 2;
}

export type FamilyProductEvidence = {
  canonicalTypes: string[];
  merchantTypes: string[];
  shopifyCategoryPaths: string[];
};

export type FamilyEvidenceResult =
  | { match: true; reason: "SHOPIFY_CATEGORY" | "CANONICAL" | "MERCHANT_TYPE"; node: FamilyNode }
  | { match: false; reason: "CONTRADICTION" | "UNCLASSIFIED" };

export function classifyFamilyProduct(
  evidence: FamilyProductEvidence,
  group: FamilyGroup,
): FamilyEvidenceResult {
  const accepted = new Set(GROUP_MEMBERS[group]);

  // A known sold-item contradiction outranks an incorrectly assigned category.
  // This prevents a Bicycle Helmet / Toy Car from entering a family just
  // because its merchant set Product.category to Bicycles / Cars.
  const authoritativeNames = evidence.canonicalTypes.length
    ? evidence.canonicalTypes : evidence.merchantTypes;
  if (authoritativeNames.some((value) =>
    ACCESSORY_OR_TOY.test(normalizeQueryText(value))
  )) return { match: false, reason: "CONTRADICTION" };
  const knownTypeNodes = authoritativeNames
    .map(classifySoldItemLeaf).filter((node): node is FamilyNode => node !== null);

  // An assigned standard category whose leaf is classifiable owns the family.
  // Its full hierarchy protects us against toy/part/accessory false matches.
  if (evidence.shopifyCategoryPaths.length) {
    for (const path of evidence.shopifyCategoryPaths) {
      const leaf = shopifyCategoryLeaf(path);
      if (leaf) {
        // Disagreeing canonical sold-item identity is a classification issue,
        // not permission to declare the query family proven.
        if (knownTypeNodes.length > 0 && knownTypeNodes.every((node) => node !== leaf)) {
          return { match: false, reason: "CONTRADICTION" };
        }
        return accepted.has(leaf)
          ? { match: true, node: leaf, reason: "SHOPIFY_CATEGORY" }
          : { match: false, reason: "CONTRADICTION" };
      }
    }
    // Explicit accessory/toy taxonomy contradicts broad family labels, even
    // if a model wrote canonicalProductType="bicycle" by mistake.
    const deny = evidence.shopifyCategoryPaths.some((path) =>
      forbiddenCategoryBranch(shopifyCategoryParts(path)));
    if (deny) return { match: false, reason: "CONTRADICTION" };
  }

  const types = evidence.canonicalTypes.length
    ? evidence.canonicalTypes : evidence.merchantTypes;
  for (const type of types) {
    const leaf = classifySoldItemLeaf(type);
    if (leaf) {
      return accepted.has(leaf)
        ? {
          match: true, node: leaf,
          reason: evidence.canonicalTypes.length ? "CANONICAL" : "MERCHANT_TYPE",
        }
        : { match: false, reason: "CONTRADICTION" };
    }
  }
  return { match: false, reason: "UNCLASSIFIED" };
}
