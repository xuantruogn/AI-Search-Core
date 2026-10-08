import { normalizeQueryText } from "./deterministic-query-parser.server";

/**
 * Conservative family taxonomy used only to prove product-family membership.
 *
 * Authority order:
 *   1. Shopify Standard Product Category path (typed catalog evidence)
 *   2. canonicalProductType (LLM, but constrained to the sold item)
 *   3. merchant productType
 *
 * Tags, descriptions, vendor names, semantic contexts and embeddings NEVER
 * establish membership. They may rank within a proven family elsewhere.
 */
export type FamilyNode =
  | "dress" | "skirt" | "top" | "pants" | "shorts" | "underwear" | "swimwear"
  | "footwear" | "bag" | "jewelry" | "watch" | "eyewear"
  | "bicycle" | "car" | "motorcycle" | "scooter" | "truck" | "bus" | "van"
  | "phone" | "tablet" | "computer" | "camera" | "television"
  | "headphones" | "speaker"
  | "furniture" | "lighting" | "bedding" | "cookware" | "dinnerware"
  | "skincare" | "makeup" | "haircare" | "fragrance"
  | "toy" | "sports_equipment" | "book" | "pet_supply" | "grocery";

export type FamilyGroup =
  | "dress_or_skirt" | "tops" | "bottoms" | "clothing"
  | "footwear" | "bags" | "jewelry" | "watches" | "eyewear"
  | "vehicles" | "bicycle"
  | "electronics" | "phones" | "computers" | "cameras" | "audio"
  | "furniture" | "home_goods"
  | "beauty" | "skincare" | "makeup" | "haircare" | "fragrance"
  | "toys" | "sports" | "books" | "pet_supplies" | "grocery"
  | "dress" | "skirt";

const GROUP_MEMBERS: Record<FamilyGroup, readonly FamilyNode[]> = {
  dress_or_skirt: ["dress", "skirt"],
  tops: ["top"],
  bottoms: ["pants", "shorts", "skirt"],
  clothing: ["dress", "skirt", "top", "pants", "shorts", "underwear", "swimwear"],
  footwear: ["footwear"],
  bags: ["bag"],
  jewelry: ["jewelry"],
  watches: ["watch"],
  eyewear: ["eyewear"],
  vehicles: ["bicycle", "car", "motorcycle", "scooter", "truck", "bus", "van"],
  bicycle: ["bicycle"],
  electronics: ["phone", "tablet", "computer", "camera", "television", "headphones", "speaker"],
  phones: ["phone"],
  computers: ["computer", "tablet"],
  cameras: ["camera"],
  audio: ["headphones", "speaker"],
  furniture: ["furniture"],
  home_goods: ["furniture", "lighting", "bedding", "cookware", "dinnerware"],
  beauty: ["skincare", "makeup", "haircare", "fragrance"],
  skincare: ["skincare"],
  makeup: ["makeup"],
  haircare: ["haircare"],
  fragrance: ["fragrance"],
  toys: ["toy"],
  sports: ["sports_equipment", "bicycle"],
  books: ["book"],
  pet_supplies: ["pet_supply"],
  grocery: ["grocery"],
  dress: ["dress"],
  skirt: ["skirt"],
};

/**
 * Exact standalone source phrases only. Qualified requests ("giày đỏ",
 * "điện thoại Samsung") must stay in the normal constrained pipeline.
 *
 * These aliases bridge shopper language to a family group; they do NOT prove
 * that any product belongs to the group.
 */
const QUERY_FAMILIES: Record<string, FamilyGroup> = {
  // Apparel
  "vay": "dress_or_skirt",
  "dam": "dress",
  "chan vay": "skirt",
  "ao": "tops",
  "quan": "bottoms",
  "quan ao": "clothing",
  "thoi trang": "clothing",
  "clothes": "clothing",
  "clothing": "clothing",
  "apparel": "clothing",
  "dress": "dress",
  "dresses": "dress",
  "skirt": "skirt",
  "skirts": "skirt",
  "shirt": "tops",
  "shirts": "tops",
  "tops": "tops",
  "pants": "bottoms",
  "trousers": "bottoms",
  "shorts": "bottoms",

  // Wearable accessories
  "giay": "footwear",
  "dep": "footwear",
  "giay dep": "footwear",
  "shoes": "footwear",
  "footwear": "footwear",
  "tui": "bags",
  "tui xach": "bags",
  "bags": "bags",
  "handbags": "bags",
  "trang suc": "jewelry",
  "jewelry": "jewelry",
  "jewellery": "jewelry",
  "dong ho": "watches",
  "watches": "watches",
  "kinh": "eyewear",
  "kinh mat": "eyewear",
  "eyewear": "eyewear",
  "glasses": "eyewear",

  // Vehicles
  "xe": "vehicles",
  "xe dap": "bicycle",
  "bicycle": "bicycle",
  "bicycles": "bicycle",
  "vehicles": "vehicles",

  // Electronics
  "dien tu": "electronics",
  "do dien tu": "electronics",
  "electronics": "electronics",
  "dien thoai": "phones",
  "smartphone": "phones",
  "smartphones": "phones",
  "phones": "phones",
  "may tinh": "computers",
  "may tinh bang": "computers",
  "laptop": "computers",
  "laptops": "computers",
  "computers": "computers",
  "tablet": "computers",
  "tablets": "computers",
  "may anh": "cameras",
  "camera": "cameras",
  "cameras": "cameras",
  "am thanh": "audio",
  "tai nghe": "audio",
  "loa": "audio",
  "audio": "audio",

  // Home
  "noi that": "furniture",
  "furniture": "furniture",
  "do gia dung": "home_goods",
  "do dung gia dinh": "home_goods",
  "home goods": "home_goods",
  "homewares": "home_goods",

  // Beauty
  "lam dep": "beauty",
  "my pham": "beauty",
  "beauty": "beauty",
  "cham soc da": "skincare",
  "skincare": "skincare",
  "trang diem": "makeup",
  "makeup": "makeup",
  "cham soc toc": "haircare",
  "haircare": "haircare",
  "nuoc hoa": "fragrance",
  "perfume": "fragrance",
  "fragrance": "fragrance",

  // Other common retail families
  "do choi": "toys",
  "toys": "toys",
  "the thao": "sports",
  "do the thao": "sports",
  "sports": "sports",
  "sach": "books",
  "books": "books",
  "thu cung": "pet_supplies",
  "do cho thu cung": "pet_supplies",
  "pet supplies": "pet_supplies",
  "thuc pham": "grocery",
  "do an": "grocery",
  "grocery": "grocery",
};

const ACCESSORY_OR_COMPONENT =
  /\b(?:accessor(?:y|ies)|parts?|component|replacement|spare|case|cover|mount|holder|rack|lock|charger|cable|adapter|screen protector|strap|stand|remote|filter|refill)\b/;
const TOY_OR_REPLICA =
  /\b(?:toy|toys|miniature|replica|costume|doll)\b/;

/**
 * Sold-item heads. Matching is exact or suffix-based ("road bicycle"),
 * never arbitrary substring matching ("bicycle helmet").
 */
const FAMILY_HEADS: Record<FamilyNode, readonly string[]> = {
  dress: ["dress", "dresses", "gown", "gowns", "sundress", "sundresses", "dam"],
  skirt: ["skirt", "skirts", "chan vay"],
  top: [
    "shirt", "shirts", "t shirt", "t shirts", "tee", "tees",
    "blouse", "blouses", "top", "tops", "jacket", "jackets", "coat", "coats",
    "sweater", "sweaters", "cardigan", "cardigans", "hoodie", "hoodies",
    "sweatshirt", "sweatshirts", "polo", "vest", "vests", "tank top",
    "tank tops", "tunic", "tunics", "ao", "ao khoac", "ao so mi",
    "ao thun", "ao len", "ao ni",
  ],
  pants: ["pants", "trousers", "jeans", "leggings", "joggers", "slacks", "quan", "quan dai"],
  shorts: ["shorts", "short pants", "quan short", "quan dui"],
  underwear: ["underwear", "briefs", "boxers", "bra", "bras", "lingerie"],
  swimwear: ["swimwear", "swimsuit", "swimsuits", "bikini", "bikinis"],

  footwear: [
    "shoe", "shoes", "sneaker", "sneakers", "boot", "boots", "sandal", "sandals",
    "slipper", "slippers", "loafer", "loafers", "heel", "heels", "giay", "dep",
  ],
  bag: [
    "bag", "bags", "handbag", "handbags", "backpack", "backpacks",
    "tote", "totes", "purse", "purses", "wallet", "wallets", "briefcase",
    "briefcases", "tui", "tui xach", "ba lo",
  ],
  jewelry: [
    "jewelry", "jewellery", "ring", "rings", "necklace", "necklaces",
    "bracelet", "bracelets", "earring", "earrings", "pendant", "pendants",
    "brooch", "brooches", "trang suc", "nhan", "vong co", "vong tay", "bong tai",
  ],
  watch: ["watch", "watches", "wristwatch", "wristwatches", "dong ho"],
  eyewear: ["glasses", "eyeglasses", "sunglasses", "spectacles", "eyewear", "kinh", "kinh mat"],

  bicycle: [
    "bicycle", "bicycles", "cycle", "cycles", "mountain bike", "road bike",
    "city bike", "electric bike", "e bike", "xe dap", "xe dap dien",
  ],
  car: ["car", "cars", "automobile", "automobiles", "sedan", "sedans", "suv", "suvs", "xe oto", "oto"],
  motorcycle: ["motorcycle", "motorcycles", "motorbike", "motorbikes", "dirt bike", "dirt bikes", "xe may"],
  scooter: ["scooter", "scooters", "moped", "mopeds", "xe tay ga"],
  truck: ["truck", "trucks", "pickup truck", "pickup trucks", "xe tai"],
  bus: ["bus", "buses", "coach", "coaches", "xe buyt"],
  van: ["van", "vans", "minivan", "minivans", "xe van"],

  phone: ["phone", "phones", "smartphone", "smartphones", "mobile phone", "mobile phones", "dien thoai"],
  tablet: ["tablet", "tablets", "tablet computer", "tablet computers", "may tinh bang"],
  computer: [
    "computer", "computers", "laptop", "laptops", "notebook computer",
    "notebook computers", "desktop computer", "desktop computers", "may tinh",
  ],
  camera: ["camera", "cameras", "digital camera", "digital cameras", "camcorder", "camcorders", "may anh"],
  television: ["television", "televisions", "tv", "tvs", "smart tv", "smart tvs"],
  headphones: ["headphone", "headphones", "earphone", "earphones", "earbuds", "headset", "headsets", "tai nghe"],
  speaker: ["speaker", "speakers", "soundbar", "soundbars", "loa"],

  furniture: [
    "furniture", "chair", "chairs", "table", "tables", "desk", "desks", "sofa",
    "sofas", "couch", "couches", "bed", "beds", "cabinet", "cabinets",
    "shelf", "shelves", "stool", "stools", "bench", "benches", "noi that",
  ],
  lighting: ["lighting", "lamp", "lamps", "light fixture", "light fixtures", "den"],
  bedding: ["bedding", "bedsheet", "bedsheets", "sheet set", "sheet sets", "duvet", "duvets", "blanket", "blankets", "chan ga"],
  cookware: ["cookware", "pan", "pans", "pot", "pots", "skillet", "skillets", "noi", "chao"],
  dinnerware: ["dinnerware", "plate", "plates", "bowl", "bowls", "cup", "cups", "mug", "mugs", "chen", "dia"],

  skincare: ["skincare", "skin care", "moisturizer", "moisturizers", "serum", "serums", "cleanser", "cleansers", "toner", "toners", "kem duong", "sua rua mat"],
  makeup: ["makeup", "lipstick", "lipsticks", "foundation", "mascara", "eyeshadow", "phan trang diem", "son moi"],
  haircare: ["haircare", "shampoo", "shampoos", "conditioner", "conditioners", "hair mask", "hair masks", "dau goi"],
  fragrance: ["fragrance", "fragrances", "perfume", "perfumes", "eau de parfum", "eau de toilette", "nuoc hoa"],

  toy: ["toy", "toys", "doll", "dolls", "puzzle", "puzzles", "board game", "board games", "do choi"],
  sports_equipment: [
    "sports equipment", "sporting goods", "snowboard", "snowboards", "ski", "skis",
    "racket", "rackets", "ball", "balls", "dumbbell", "dumbbells", "fitness equipment",
  ],
  book: ["book", "books", "novel", "novels", "textbook", "textbooks", "sach"],
  pet_supply: ["pet supply", "pet supplies", "pet food", "dog food", "cat food", "pet bed", "pet beds", "do cho thu cung"],
  grocery: ["grocery", "food", "foods", "snack", "snacks", "beverage", "beverages", "drink", "drinks", "thuc pham"],
};

const CATEGORY_SUBGROUP_DENIAL =
  /\b(?:accessor(?:y|ies)|parts?|replacement|components?|attachments?|refills?)\b/;

export function queryFamilyFromSource(query: string): FamilyGroup | null {
  return QUERY_FAMILIES[normalizeQueryText(query)] ?? null;
}

export function familyGroupMembers(group: FamilyGroup) {
  return GROUP_MEMBERS[group];
}

function suffixMatches(actual: string, suffix: string) {
  return actual === suffix || actual.endsWith(" " + suffix);
}

export function classifySoldItemLeaf(raw: string): FamilyNode | null {
  const value = normalizeQueryText(raw);
  if (!value || ACCESSORY_OR_COMPONENT.test(value)) return null;
  // Toy is a legitimate family itself, but "toy car" must not establish Car.
  const toyContext = TOY_OR_REPLICA.test(value);
  for (const [node, heads] of Object.entries(FAMILY_HEADS) as Array<[FamilyNode, readonly string[]]>) {
    if (node !== "toy" && toyContext) continue;
    if (heads.some((head) => suffixMatches(value, normalizeQueryText(head)))) {
      return node;
    }
  }
  return null;
}

export function shopifyCategoryParts(path: string) {
  return path.split(/\s*(?:>|»)\s*/).map(normalizeQueryText).filter(Boolean);
}

function forbiddenCategoryBranch(parts: string[]) {
  return parts.some((part, index) =>
    // These Shopify taxonomy roots are neutral names.
    !(index === 0 && [
      "apparel accessories", "vehicles parts", "electronics",
      "home garden", "health beauty", "toys games",
    ].includes(part)) &&
    CATEGORY_SUBGROUP_DENIAL.test(part)
  );
}

/** Return the deepest known sold-item family node from a typed Shopify path. */
export function shopifyCategoryLeaf(path: string): FamilyNode | null {
  const segments = shopifyCategoryParts(path);
  if (!segments.length || forbiddenCategoryBranch(segments)) return null;
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    const leaf = classifySoldItemLeaf(segments[i]);
    if (leaf) return leaf;
  }
  return null;
}

export function shopifyCategoryMatchesGroup(path: string, group: FamilyGroup) {
  const segments = shopifyCategoryParts(path);
  if (!segments.length || forbiddenCategoryBranch(segments)) return false;
  const accepted = new Set(GROUP_MEMBERS[group]);
  return segments.some((segment) => {
    const node = classifySoldItemLeaf(segment);
    return node ? accepted.has(node) : false;
  });
}

export function shopifyCategoryIsClothing(path: string) {
  return shopifyCategoryMatchesGroup(path, "clothing");
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
  const authoritativeNames = evidence.canonicalTypes.length
    ? evidence.canonicalTypes : evidence.merchantTypes;

  // Strong explicit accessory/component identity cannot inherit the parent item.
  if (group !== "toys" && authoritativeNames.some((value) =>
    ACCESSORY_OR_COMPONENT.test(normalizeQueryText(value))
  )) return { match: false, reason: "CONTRADICTION" };

  const knownTypeNodes = authoritativeNames
    .map(classifySoldItemLeaf).filter((node): node is FamilyNode => node !== null);

  if (evidence.shopifyCategoryPaths.length) {
    for (const path of evidence.shopifyCategoryPaths) {
      const leaf = shopifyCategoryLeaf(path);
      if (!leaf) continue;
      if (knownTypeNodes.length > 0 &&
          knownTypeNodes.every((node) => node !== leaf && !accepted.has(node))) {
        return { match: false, reason: "CONTRADICTION" };
      }
      return accepted.has(leaf)
        ? { match: true, node: leaf, reason: "SHOPIFY_CATEGORY" }
        : { match: false, reason: "CONTRADICTION" };
    }
    const deny = evidence.shopifyCategoryPaths.some((path) =>
      forbiddenCategoryBranch(shopifyCategoryParts(path)));
    if (deny) return { match: false, reason: "CONTRADICTION" };
  }

  for (const type of authoritativeNames) {
    const leaf = classifySoldItemLeaf(type);
    if (!leaf) continue;
    return accepted.has(leaf)
      ? {
        match: true,
        node: leaf,
        reason: evidence.canonicalTypes.length ? "CANONICAL" : "MERCHANT_TYPE",
      }
      : { match: false, reason: "CONTRADICTION" };
  }
  return { match: false, reason: "UNCLASSIFIED" };
}
