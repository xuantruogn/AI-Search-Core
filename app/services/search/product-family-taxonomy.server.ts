import { normalizeQueryText, normalizeUnicodeQueryText } from "./deterministic-query-parser.server";

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
  | "scooter" | "truck" | "bus" | "van"
  | "handbag" | "backpack" | "duffel_bag" | "tote_bag"
  | "messenger_bag" | "crossbody_bag" | "shoulder_bag"
  | "laptop_bag" | "briefcase" | "clutch" | "waist_bag";

export type FamilyGroup =
  | "dress_or_skirt" | "tops" | "vehicles" | "bags"
  | "dress" | "skirt" | "bicycle";

const GROUP_MEMBERS: Record<FamilyGroup, readonly FamilyNode[]> = {
  dress_or_skirt: ["dress", "skirt"],
  tops: ["top"],
  vehicles: ["bicycle", "car", "motorcycle", "scooter", "truck", "bus", "van"],
  bags: [
    "handbag", "backpack", "duffel_bag", "tote_bag", "messenger_bag",
    "crossbody_bag", "shoulder_bag", "laptop_bag", "briefcase", "clutch", "waist_bag",
  ],
  dress: ["dress"],
  skirt: ["skirt"],
  bicycle: ["bicycle"],
};

/** Exact standalone source expressions. Phrases containing modifiers never match. */
const QUERY_FAMILIES_UNICODE: Record<string, FamilyGroup> = {
  "váy": "dress_or_skirt",
  "áo": "tops",
  "túi": "bags",
};

const QUERY_FAMILIES: Record<string, FamilyGroup> = {
  "dam": "dress",                // "đầm": dress, not skirt
  "chan vay": "skirt",           // "chân váy": skirt, not dress
  "xe": "vehicles",              // vehicles, not spare parts or toy cars
  "xe dap": "bicycle",

  // Same controlled semantics for common English standalone family nouns.
  "dress": "dress",
  "dresses": "dress",
  "skirt": "skirt",
  "skirts": "skirt",
  "tops": "tops",
  "bicycle": "bicycle",
  "bicycles": "bicycle",
  "vehicle": "vehicles",
  "vehicles": "vehicles",
  "bag": "bags",
  "bags": "bags",
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
  handbag: ["handbag", "handbags", "purse", "purses", "tui xach"],
  backpack: ["backpack", "backpacks", "rucksack", "rucksacks", "ba lo", "balo"],
  duffel_bag: ["duffel bag", "duffel bags", "duffle bag", "duffle bags"],
  tote_bag: ["tote bag", "tote bags"],
  messenger_bag: ["messenger bag", "messenger bags"],
  crossbody_bag: ["crossbody bag", "crossbody bags"],
  shoulder_bag: ["shoulder bag", "shoulder bags"],
  laptop_bag: ["laptop bag", "laptop bags"],
  briefcase: ["briefcase", "briefcases"],
  clutch: ["clutch", "clutches", "clutch bag", "clutch bags"],
  waist_bag: ["waist bag", "waist bags", "belt bag", "belt bags", "fanny pack", "fanny packs"],
};

const APPAREL_CATEGORY_SEGMENTS = new Set(["clothing", "apparel", "quan ao"]);
const CATEGORY_SUBGROUP_DENIAL =
  /\b(?:accessor(?:y|ies)|costume|toy|toys|parts?|replacement)\b/;
const HARD_ALTERNATE_CATEGORY_BRANCH =
  /\b(?:costume|toy|toys)\b/;
const SUBORDINATE_CATEGORY_BRANCH =
  /\b(?:accessor(?:y|ies)|parts?|replacement)\b/;

export function queryFamilyFromSource(query: string): FamilyGroup | null {
  return QUERY_FAMILIES_UNICODE[normalizeUnicodeQueryText(query)] ??
    QUERY_FAMILIES[normalizeQueryText(query)] ??
    null;
}

/**
 * Canonical bridges only for common exact standalone Vietnamese family nouns.
 * These do not establish membership; they only name the target family.
 * Product membership still requires Shopify taxonomy/canonical product type.
 */
const SOURCE_CANONICAL_FAMILIES: Record<string, string> = {
  "ao khoac": "jacket",
  "ao so mi": "shirt",
  "ao thun": "t shirt",
  "ao len": "sweater",
  "ao ni": "sweatshirt",
  "quan": "pants",
  "quan dai": "pants",
  "quan short": "shorts",
  "quan dui": "shorts",
  "tui xach": "handbags",
  "ba lo": "backpacks",
  "trang suc": "jewelry",
  "day chuyen": "necklaces",
  "vong tay": "bracelets",
  "khuyen tai": "earrings",
  "dong ho": "watches",
  "kinh mat": "eyewear",
  "dien thoai": "phones",
  "dien thoai di dong": "mobile phones",
  "may tinh": "computers",
  "laptop": "laptops",
  "may tinh bang": "tablets",
  "tai nghe": "headphones",
  "loa": "speakers",
  "may anh": "cameras",
  "tivi": "televisions",
  "tv": "televisions",
  "noi that": "furniture",
  "giuong": "beds",
  "my pham": "cosmetics",
  "cham soc da": "skin care",
  "nuoc hoa": "fragrances",
  "do choi": "toys",
  "balo": "backpacks",

  // Common retail families: deterministic fast path only. Unknown family
  // nouns still work through full-source translation + catalog taxonomy.
  "thuc an cho": "dog food",
  "thuc an meo": "cat food",
  "do an cho": "dog food",
  "do an meo": "cat food",
  "xe day em be": "baby strollers",
  "ta em be": "diapers",
  "binh sua": "baby bottles",
  "binh nuoc": "water bottles",
  "may pha ca phe": "coffee makers",
  "am dun nuoc": "kettles",
  "may in": "printers",
  "man hinh may tinh": "computer monitors",
  "ban phim": "keyboards",
  "chuot may tinh": "computer mice",
  "sac dien thoai": "phone chargers",
  "cap sac": "charging cables",
  "mu bao hiem": "helmets",
  "vo xe": "tires",
  "lop xe": "tires",
  "dung cu cam tay": "hand tools",
  "dung cu dien": "power tools",
  "ly uong nuoc": "drinkware",
  "sua rua mat": "facial cleansers",
  "kem chong nang": "sunscreen",
  "bup be": "dolls",
  "xep hinh": "building toys",
  "vot tennis": "tennis rackets",
};

/** Accent-preserving aliases for short Vietnamese words that collide when folded. */
const SOURCE_CANONICAL_FAMILIES_UNICODE: Record<string, string> = {
  "ví": "wallets",
  "nhẫn": "rings",
  "mũ": "hats",
  "kính": "eyewear",
  "bàn": "tables",
  "ghế": "chairs",
  "đèn": "lighting",
  "nồi": "pots",
  "chảo": "pans",
  "cốc": "mugs",
  "kem dưỡng": "moisturizers",
  "giày": "shoes",
  "dép": "sandals",
  "nệm": "mattresses",
  "đệm": "mattresses",
  "dầu gội": "shampoo",
  "sách": "books",
  "son môi": "lipstick",
};

export function sourceCanonicalFamilyFromSource(query: string): string | null {
  const unicode = normalizeUnicodeQueryText(query);
  return SOURCE_CANONICAL_FAMILIES_UNICODE[unicode] ??
    SOURCE_CANONICAL_FAMILIES[normalizeQueryText(query)] ??
    null;
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


/**
 * Generic taxonomy matching for every Shopify category family.
 *
 * A query family is canonicalized separately (dictionary/LLM/source bridge).
 * Membership then comes from the product's typed Shopify category path or
 * exact sold-item type. Dense/BM25 text is never used as membership proof.
 */
const IRREGULAR_FAMILY_SINGULAR: Record<string, string> = {
  mice: "mouse",
  children: "child",
  people: "person",
  men: "man",
  women: "woman",
  feet: "foot",
  teeth: "tooth",
  knives: "knife",
  shelves: "shelf",
  scarves: "scarf",
  loaves: "loaf",
};

function singularFamilyToken(token: string) {
  const irregular = IRREGULAR_FAMILY_SINGULAR[token];
  if (irregular) return irregular;
  if (token.length > 4 && token.endsWith("ies")) return token.slice(0, -3) + "y";
  if (token.length > 5 && token.endsWith("sses")) return token.slice(0, -2);
  if (token.length > 4 && /(?:ches|shes|xes|zes|ses)$/.test(token)) {
    return token.slice(0, -2);
  }
  if (token.length > 3 && token.endsWith("s") &&
      !token.endsWith("ss") && !token.endsWith("us") && !token.endsWith("is")) {
    return token.slice(0, -1);
  }
  return token;
}
function normalizeFamilyPhrase(value: string) {
  return normalizeQueryText(value)
    .split(" ")
    .filter(Boolean)
    .map(singularFamilyToken)
    .join(" ");
}
function genericFamilyPhraseMatches(actual: string, requested: string) {
  const source = normalizeFamilyPhrase(actual);
  const target = normalizeFamilyPhrase(requested);
  if (!source || !target) return false;
  return source === target || source.endsWith(" " + target);
}

/**
 * Returns true when a trustworthy Shopify taxonomy path proves that a product
 * is inside a requested family. The full path is inspected so broad parents
 * (Jewelry, Shoes, Furniture, Computers...) automatically include descendants.
 */
export function shopifyCategoryMatchesFamily(path: string, requested: string) {
  const rawParts = path
    .split(/\s*(?:>|»)\s*/)
    .map((part) => part.trim())
    .filter(Boolean);
  const parts = rawParts.map(normalizeQueryText).filter(Boolean);
  const target = normalizeFamilyPhrase(requested);
  if (!parts.length || !target) return false;
  const matches = rawParts.flatMap((rawPart, index) => {
    const normalizedPart = normalizeFamilyPhrase(rawPart);
    if (!normalizedPart) return [];
    // Shopify has combined structural parents such as "Luggage & Bags",
    // "Health & Beauty" and "Food, Beverages & Tobacco". Matching only one
    // conjunct must NOT claim every sibling below that parent.
    const matched = /[&,]/.test(rawPart)
      ? normalizedPart === target
      : genericFamilyPhraseMatches(normalizedPart, target);
    return matched ? [index] : [];
  });
  if (!matches.length) return false;

  const targetNamesAlternateClass =
    HARD_ALTERNATE_CATEGORY_BRANCH.test(target) ||
    ACCESSORY_OR_TOY.test(target);

  // Toys/costumes change the sold-item class. "Cars" under Toy Cars are not
  // cars; "Dresses" under Costumes are not normal dresses. Only an explicitly
  // toy/costume target may cross this boundary.
  if (
    !targetNamesAlternateClass &&
    parts.some((part, index) =>
      !(index === 0 && ["apparel accessories", "vehicles parts"].includes(part)) &&
      HARD_ALTERNATE_CATEGORY_BRANCH.test(part))
  ) return false;

  // Accessories/parts are hierarchical rather than a universal class change.
  // A parent search (Computers) must not inherit Computer Accessories, while a
  // specific descendant search (Computer Mice) is legitimate even though its
  // ancestor is an accessory branch.
  const subordinateIndex = parts.findIndex((part, index) =>
    !(index === 0 && ["apparel accessories", "vehicles parts"].includes(part)) &&
    SUBORDINATE_CATEGORY_BRANCH.test(part));
  if (
    subordinateIndex >= 0 &&
    !targetNamesAlternateClass &&
    !matches.some((index) => index > subordinateIndex)
  ) return false;

  return true;
}

/**
 * Generic exact/subtype membership for families not present in the small
 * language-ambiguity bridge. This is what makes pure-family retrieval work for
 * the rest of the catalog without a hand-authored list per product class.
 */
export function classifyGenericFamilyProduct(
  evidence: FamilyProductEvidence,
  requested: string,
): FamilyEvidenceResult | { match: true; reason: "SHOPIFY_CATEGORY" | "CANONICAL" | "MERCHANT_TYPE"; node: "generic" } {
  const target = normalizeFamilyPhrase(requested);
  if (!target) return { match: false, reason: "UNCLASSIFIED" };

  const authoritativeNames = evidence.canonicalTypes.length
    ? evidence.canonicalTypes : evidence.merchantTypes;
  if (authoritativeNames.some((value) =>
    ACCESSORY_OR_TOY.test(normalizeQueryText(value))
  )) {
    // Do not reject if the shopper explicitly asked for that accessory class.
    const requestedAccessory = ACCESSORY_OR_TOY.test(normalizeQueryText(requested));
    if (!requestedAccessory) return { match: false, reason: "CONTRADICTION" };
  }

  for (const path of evidence.shopifyCategoryPaths) {
    if (shopifyCategoryMatchesFamily(path, target)) {
      return { match: true, reason: "SHOPIFY_CATEGORY", node: "generic" };
    }
  }

  const types = evidence.canonicalTypes.length
    ? evidence.canonicalTypes : evidence.merchantTypes;
  for (const type of types) {
    if (genericFamilyPhraseMatches(type, target)) {
      return {
        match: true,
        reason: evidence.canonicalTypes.length ? "CANONICAL" : "MERCHANT_TYPE",
        node: "generic",
      };
    }
  }
  return { match: false, reason: "UNCLASSIFIED" };
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
        if (knownTypeNodes.length > 0 &&
          knownTypeNodes.every((node) => node !== leaf && !accepted.has(node))) {
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
