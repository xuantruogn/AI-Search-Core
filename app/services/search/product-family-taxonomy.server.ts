import { normalizeQueryText } from "./deterministic-query-parser.server";

/**
 * Shared retail product-family taxonomy.
 *
 * Authority order:
 *  1) Shopify Standard Product Category (typed catalog evidence)
 *  2) exact sold-item canonical type
 *  3) merchant Product Type when canonical type is absent
 *
 * Embeddings, tags, aliases, vendor names and use-case text NEVER prove family
 * membership. This module only answers "what kind of item is actually sold?".
 */

const FAMILY_HEADS = {
  // Apparel
  dress: ["dress", "dresses", "gown", "gowns", "sundress", "sundresses", "dam"],
  skirt: ["skirt", "skirts", "chan vay"],
  shirt: ["shirt", "shirts", "t shirt", "t shirts", "tee", "tees", "blouse", "blouses", "polo", "polos", "ao so mi", "ao thun"],
  jacket: ["jacket", "jackets", "coat", "coats", "blazer", "blazers", "ao khoac"],
  sweater: ["sweater", "sweaters", "cardigan", "cardigans", "hoodie", "hoodies", "sweatshirt", "sweatshirts", "ao len", "ao ni"],
  top: ["top", "tops", "tank top", "tank tops", "tunic", "tunics", "ao"],
  pants: ["pants", "trousers", "trouser", "slacks", "quan dai", "quan"],
  jeans: ["jeans", "jean", "denim pants", "quan jean", "quan jeans"],
  shorts: ["shorts", "short pants", "quan short", "quan shorts", "quan dui"],
  leggings: ["leggings", "legging", "tights", "quan legging"],
  underwear: ["underwear", "briefs", "boxers", "panties", "bra", "bras", "quan lot", "ao nguc"],
  sleepwear: ["sleepwear", "pajama", "pajamas", "pyjama", "pyjamas", "do ngu"],
  swimwear: ["swimwear", "swimsuit", "swimsuits", "bikini", "bikinis", "do boi"],

  // Footwear
  shoe: ["shoe", "shoes", "dress shoe", "dress shoes", "giay"],
  sneaker: ["sneaker", "sneakers", "trainer", "trainers", "running shoe", "running shoes", "giay the thao"],
  boot: ["boot", "boots", "ankle boot", "ankle boots", "giay boot", "bot"],
  sandal: ["sandal", "sandals", "flip flop", "flip flops", "dep sandal", "dep"],
  slipper: ["slipper", "slippers", "house slipper", "house slippers", "dep di trong nha"],

  // Bags / fashion accessories
  handbag: ["handbag", "handbags", "purse", "purses", "tote bag", "tote bags", "tui xach", "tui"],
  backpack: ["backpack", "backpacks", "rucksack", "rucksacks", "balo"],
  wallet: ["wallet", "wallets", "card holder", "card holders", "vi", "vi tien"],
  belt: ["belt", "belts", "that lung"],
  hat: ["hat", "hats", "cap", "caps", "beanie", "beanies", "mu", "non"],
  sunglasses: ["sunglasses", "sun glasses", "kinh ram", "kinh mat"],
  watch: ["watch", "watches", "wristwatch", "wristwatches", "dong ho"],
  ring: ["ring", "rings", "nhan"],
  necklace: ["necklace", "necklaces", "chain necklace", "chain necklaces", "day chuyen"],
  bracelet: ["bracelet", "bracelets", "bangle", "bangles", "vong tay"],
  earring: ["earring", "earrings", "ear ring", "ear rings", "bong tai", "khuyen tai"],
  pendant: ["pendant", "pendants", "mat day chuyen"],

  // Vehicles
  bicycle: ["bicycle", "bicycles", "cycle", "cycles", "mountain bike", "road bike", "city bike", "electric bike", "e bike", "xe dap", "xe dap dien"],
  car: ["car", "cars", "automobile", "automobiles", "sedan", "sedans", "suv", "suvs", "xe oto", "oto"],
  motorcycle: ["motorcycle", "motorcycles", "motorbike", "motorbikes", "dirt bike", "dirt bikes", "xe may"],
  scooter: ["scooter", "scooters", "moped", "mopeds", "xe tay ga"],
  truck: ["truck", "trucks", "pickup truck", "pickup trucks", "xe tai"],
  bus: ["bus", "buses", "coach", "coaches", "xe buyt"],
  van: ["van", "vans", "minivan", "minivans", "xe van"],

  // Electronics
  phone: ["phone", "phones", "smartphone", "smartphones", "mobile phone", "mobile phones", "dien thoai"],
  phone_case: ["phone case", "phone cases", "mobile case", "mobile cases", "smartphone case", "smartphone cases", "op dien thoai"],
  tablet: ["tablet", "tablets", "tablet computer", "tablet computers", "may tinh bang"],
  laptop: ["laptop", "laptops", "notebook computer", "notebook computers", "may tinh xach tay"],
  desktop: ["desktop computer", "desktop computers", "desktop pc", "desktop pcs", "may tinh de ban"],
  monitor: ["monitor", "monitors", "computer monitor", "computer monitors", "man hinh may tinh"],
  keyboard: ["keyboard", "keyboards", "computer keyboard", "computer keyboards", "ban phim"],
  mouse: ["computer mouse", "computer mice", "wireless mouse", "gaming mouse", "chuot may tinh"],
  headphone: ["headphone", "headphones", "earphone", "earphones", "earbud", "earbuds", "tai nghe"],
  speaker: ["speaker", "speakers", "bluetooth speaker", "bluetooth speakers", "loa"],
  camera: ["camera", "cameras", "digital camera", "digital cameras", "may anh"],
  television: ["television", "televisions", "tv", "tvs", "smart tv", "smart tvs", "tivi"],

  // Home / furniture
  chair: ["chair", "chairs", "armchair", "armchairs", "ghe"],
  sofa: ["sofa", "sofas", "couch", "couches", "ghe sofa"],
  table: ["table", "tables", "dining table", "dining tables", "coffee table", "coffee tables", "ban"],
  desk: ["desk", "desks", "computer desk", "computer desks", "ban lam viec"],
  bed: ["bed", "beds", "giuong"],
  cabinet: ["cabinet", "cabinets", "cupboard", "cupboards", "tu"],
  shelf: ["shelf", "shelves", "shelving unit", "shelving units", "ke"],
  lamp: ["lamp", "lamps", "table lamp", "table lamps", "floor lamp", "floor lamps", "den"],
  rug: ["rug", "rugs", "carpet", "carpets", "tham"],

  // Beauty
  makeup: ["makeup", "cosmetic", "cosmetics", "trang diem", "my pham trang diem"],
  skincare: ["skin care", "skincare", "moisturizer", "moisturizers", "serum", "serums", "cham soc da"],
  cleanser: ["cleanser", "cleansers", "face wash", "face washes", "sua rua mat"],
  shampoo: ["shampoo", "shampoos", "dau goi"],
  conditioner: ["conditioner", "conditioners", "dau xa"],
  fragrance: ["fragrance", "fragrances", "perfume", "perfumes", "cologne", "colognes", "nuoc hoa"],

  // Food / beverages
  tea: ["tea", "teas", "loose leaf tea", "tra"],
  coffee: ["coffee", "coffees", "coffee beans", "ca phe"],
  snack: ["snack", "snacks", "chips", "cracker", "crackers", "do an vat"],

  // Sports
  snowboard: ["snowboard", "snowboards", "van truot tuyet"],
  skateboard: ["skateboard", "skateboards", "van truot"],
  ski: ["ski", "skis", "van truot ski"],
  ball: ["sports ball", "sports balls", "football", "soccer ball", "basketball", "volleyball", "bong the thao"],
} as const;

export type FamilyNode = keyof typeof FAMILY_HEADS;

const GROUP_MEMBERS = {
  dress_or_skirt: ["dress", "skirt"],
  dresses: ["dress"],
  skirts: ["skirt"],
  tops: ["shirt", "jacket", "sweater", "top"],
  bottoms: ["pants", "jeans", "shorts", "leggings"],
  pants: ["pants", "jeans", "leggings"],
  shorts: ["shorts"],
  clothing: ["dress", "skirt", "shirt", "jacket", "sweater", "top", "pants", "jeans", "shorts", "leggings", "underwear", "sleepwear", "swimwear"],
  footwear: ["shoe", "sneaker", "boot", "sandal", "slipper"],
  shoes: ["shoe", "sneaker", "boot"],
  sandals: ["sandal", "slipper"],
  bags: ["handbag", "backpack"],
  backpacks: ["backpack"],
  wallets: ["wallet"],
  fashion_accessories: ["handbag", "backpack", "wallet", "belt", "hat", "sunglasses", "watch", "ring", "necklace", "bracelet", "earring", "pendant"],
  jewelry: ["ring", "necklace", "bracelet", "earring", "pendant"],
  watches: ["watch"],
  vehicles: ["bicycle", "car", "motorcycle", "scooter", "truck", "bus", "van"],
  bicycles: ["bicycle"],
  cars: ["car"],
  motorcycles: ["motorcycle", "scooter"],
  phones: ["phone"],
  phone_cases: ["phone_case"],
  computers: ["laptop", "desktop"],
  laptops: ["laptop"],
  tablets: ["tablet"],
  computer_accessories: ["monitor", "keyboard", "mouse"],
  audio: ["headphone", "speaker"],
  headphones: ["headphone"],
  cameras: ["camera"],
  televisions: ["television"],
  furniture: ["chair", "sofa", "table", "desk", "bed", "cabinet", "shelf"],
  seating: ["chair", "sofa"],
  tables: ["table", "desk"],
  lighting: ["lamp"],
  floor_coverings: ["rug"],
  beauty: ["makeup", "skincare", "cleanser", "shampoo", "conditioner", "fragrance"],
  makeup: ["makeup"],
  skincare: ["skincare", "cleanser"],
  haircare: ["shampoo", "conditioner"],
  fragrance: ["fragrance"],
  beverages: ["tea", "coffee"],
  tea: ["tea"],
  coffee: ["coffee"],
  snacks: ["snack"],
  boardsports: ["snowboard", "skateboard", "ski"],
  snowboards: ["snowboard"],
  skateboards: ["skateboard"],
  sports_balls: ["ball"],
} as const satisfies Record<string, readonly FamilyNode[]>;

export type FamilyGroup = keyof typeof GROUP_MEMBERS;

/**
 * Exact standalone shopper expressions. These are source-language ownership
 * rules, not LLM-generated expansions. Modifiers ("áo đỏ", "giày size 42")
 * intentionally do not match this table and continue through normal filters.
 */
const QUERY_FAMILIES: Record<string, FamilyGroup> = {
  // Apparel
  "vay": "dress_or_skirt", "dress": "dresses", "dresses": "dresses",
  "dam": "dresses", "chan vay": "skirts", "skirt": "skirts", "skirts": "skirts",
  "ao": "tops", "shirt": "tops", "shirts": "tops", "top": "tops", "tops": "tops",
  "quan": "bottoms", "pants": "pants", "trousers": "pants",
  "quan short": "shorts", "shorts": "shorts",
  "quan ao": "clothing", "clothing": "clothing", "clothes": "clothing", "apparel": "clothing",
  "giay": "footwear", "shoes": "shoes", "shoe": "shoes",
  "dep": "sandals", "sandals": "sandals", "sandal": "sandals",

  // Bags / accessories
  "tui": "bags", "tui xach": "bags", "bag": "bags", "bags": "bags",
  "balo": "backpacks", "backpack": "backpacks", "backpacks": "backpacks",
  "vi": "wallets", "vi tien": "wallets", "wallet": "wallets", "wallets": "wallets",
  "phu kien thoi trang": "fashion_accessories",
  "trang suc": "jewelry", "jewelry": "jewelry", "jewellery": "jewelry",
  "dong ho": "watches", "watch": "watches", "watches": "watches",

  // Vehicles
  "xe": "vehicles", "vehicle": "vehicles", "vehicles": "vehicles",
  "xe dap": "bicycles", "bicycle": "bicycles", "bicycles": "bicycles", "bike": "bicycles",
  "oto": "cars", "o to": "cars", "xe oto": "cars", "car": "cars", "cars": "cars",
  "xe may": "motorcycles", "motorcycle": "motorcycles", "motorcycles": "motorcycles",

  // Electronics
  "dien thoai": "phones", "phone": "phones", "phones": "phones", "smartphone": "phones",
  "op dien thoai": "phone_cases", "phone case": "phone_cases", "phone cases": "phone_cases",
  "may tinh": "computers", "computer": "computers", "computers": "computers",
  "laptop": "laptops", "laptops": "laptops",
  "may tinh bang": "tablets", "tablet": "tablets", "tablets": "tablets",
  "phu kien may tinh": "computer_accessories",
  "tai nghe": "headphones", "headphone": "headphones", "headphones": "headphones",
  "am thanh": "audio", "audio": "audio",
  "may anh": "cameras", "camera": "cameras", "cameras": "cameras",
  "tivi": "televisions", "tv": "televisions", "television": "televisions",

  // Home
  "noi that": "furniture", "furniture": "furniture",
  "ghe": "seating", "chair": "seating", "chairs": "seating",
  "ban": "tables", "table": "tables", "tables": "tables",
  "den": "lighting", "lamp": "lighting", "lamps": "lighting",
  "tham": "floor_coverings", "rug": "floor_coverings", "rugs": "floor_coverings",

  // Beauty
  "my pham": "beauty", "beauty": "beauty", "cosmetics": "beauty",
  "trang diem": "makeup", "makeup": "makeup",
  "cham soc da": "skincare", "skincare": "skincare", "skin care": "skincare",
  "cham soc toc": "haircare", "hair care": "haircare", "haircare": "haircare",
  "nuoc hoa": "fragrance", "perfume": "fragrance", "fragrance": "fragrance",

  // Food / sports
  "do uong": "beverages", "beverage": "beverages", "beverages": "beverages",
  "tra": "tea", "tea": "tea", "ca phe": "coffee", "coffee": "coffee",
  "do an vat": "snacks", "snack": "snacks", "snacks": "snacks",
  "van truot tuyet": "snowboards", "snowboard": "snowboards", "snowboards": "snowboards",
  "van truot": "skateboards", "skateboard": "skateboards", "skateboards": "skateboards",
  "bong the thao": "sports_balls", "sports ball": "sports_balls",
};

/**
 * A category leaf can use a plural/aggregate Shopify name such as
 * "Shirts & Tops". These are typed category labels, not free-text synonyms.
 */
const CATEGORY_LEAF_GROUPS: Record<string, FamilyGroup> = {
  "shirts tops": "tops",
  "pants": "pants",
  "shorts": "shorts",
  "shoes": "footwear",
  "handbags wallets cases": "fashion_accessories",
  "jewelry": "jewelry",
  "watches": "watches",
  "bicycles": "bicycles",
  "motorcycles scooters": "motorcycles",
  "mobile phones": "phones",
  "tablet computers": "tablets",
  "laptop computers": "laptops",
  "desktop computers": "computers",
  "computer monitors": "computer_accessories",
  "headphones": "headphones",
  "cameras": "cameras",
  "televisions": "televisions",
  "chairs": "seating",
  "sofas": "seating",
  "tables": "tables",
  "beds": "furniture",
  "cabinets storage": "furniture",
  "lamps": "lighting",
  "rugs": "floor_coverings",
  "makeup": "makeup",
  "skin care": "skincare",
  "hair care": "haircare",
  "fragrances": "fragrance",
  "tea": "tea",
  "coffee": "coffee",
  "snowboards": "snowboards",
  "skateboards": "skateboards",
};

/** Only these modifiers make an otherwise valid sold-item head non-literal. */
const NON_REAL_ITEM_MODIFIER =
  /\b(?:toy|toys|miniature|replica|costume|doll|ornament|ornaments|decoration|decorations)\b/;

const CATEGORY_DENIAL =
  /\b(?:toy|toys|doll|dolls|costume|costumes|miniature|replica|ornament|ornaments)\b/;

export function queryFamilyFromSource(query: string): FamilyGroup | null {
  return QUERY_FAMILIES[normalizeQueryText(query)] ?? null;
}

/**
 * Canonical/translated exact product noun can also use the same family graph.
 * This lets "chaussures" -> "shoes" or "xe đạp" -> "bicycle" take complete
 * family retrieval after the trusted rewrite, instead of reverting to Top-K.
 */
export function familyGroupForCanonicalTarget(value: string): FamilyGroup | null {
  const normalized = normalizeQueryText(value);
  const direct = QUERY_FAMILIES[normalized];
  if (direct) return direct;
  const leaf = classifySoldItemLeaf(normalized);
  if (!leaf) return null;
  for (const [group, members] of Object.entries(GROUP_MEMBERS) as Array<[FamilyGroup, readonly FamilyNode[]]>) {
    if (members.length === 1 && members[0] === leaf) return group;
  }
  return null;
}

function suffixMatches(actual: string, suffix: string) {
  return actual === suffix || actual.endsWith(" " + suffix);
}

export function classifySoldItemLeaf(raw: string): FamilyNode | null {
  const value = normalizeQueryText(raw);
  if (!value || NON_REAL_ITEM_MODIFIER.test(value)) return null;
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
  return parts.some((part) => CATEGORY_DENIAL.test(part));
}

export function shopifyCategoryLeaf(path: string): FamilyNode | null {
  const segments = shopifyCategoryParts(path);
  if (!segments.length || forbiddenCategoryBranch(segments)) return null;
  return classifySoldItemLeaf(segments.at(-1) ?? "");
}

function categoryProvesGroup(path: string, group: FamilyGroup) {
  const segments = shopifyCategoryParts(path);
  if (!segments.length || forbiddenCategoryBranch(segments)) return false;
  const leaf = segments.at(-1) ?? "";
  const aggregate = CATEGORY_LEAF_GROUPS[leaf];
  if (aggregate) {
    const aggregateMembers = new Set(GROUP_MEMBERS[aggregate]);
    return GROUP_MEMBERS[group].some((node) => aggregateMembers.has(node));
  }
  // Broad catalog roots may prove only broad shopper groups and only when the
  // product is below that root. Never use an ancestor Vehicles/Clothing to
  // prove a narrow leaf such as bicycle/dress.
  if (group === "clothing") {
    return segments.slice(0, -1).some((segment) => segment === "clothing") &&
      !segments.some((segment) => /\baccessor(?:y|ies)\b/.test(segment));
  }
  if (group === "furniture") {
    return segments.slice(0, -1).some((segment) => segment === "furniture");
  }
  return false;
}

export function shopifyCategoryIsClothing(path: string) {
  return categoryProvesGroup(path, "clothing");
}

export type FamilyProductEvidence = {
  canonicalTypes: string[];
  merchantTypes: string[];
  shopifyCategoryPaths: string[];
};

export type FamilyEvidenceResult =
  | { match: true; reason: "SHOPIFY_CATEGORY" | "CANONICAL" | "MERCHANT_TYPE"; node: FamilyNode | null }
  | { match: false; reason: "CONTRADICTION" | "UNCLASSIFIED" };

export function classifyFamilyProduct(
  evidence: FamilyProductEvidence,
  group: FamilyGroup,
): FamilyEvidenceResult {
  const accepted = new Set<FamilyNode>(GROUP_MEMBERS[group]);

  const authoritativeNames = evidence.canonicalTypes.length
    ? evidence.canonicalTypes : evidence.merchantTypes;
  const knownTypeNodes = authoritativeNames
    .map(classifySoldItemLeaf)
    .filter((node): node is FamilyNode => node !== null);

  // A concrete canonical sold-item identity outside the requested family is a
  // contradiction. It also protects against a mistakenly assigned Shopify
  // category (e.g. Bicycle Helmet categorized as Bicycles).
  if (knownTypeNodes.length > 0 && knownTypeNodes.every((node) => !accepted.has(node))) {
    return { match: false, reason: "CONTRADICTION" };
  }

  for (const path of evidence.shopifyCategoryPaths) {
    const leaf = shopifyCategoryLeaf(path);
    if (leaf) {
      if (knownTypeNodes.length > 0 &&
          knownTypeNodes.every((node) => node !== leaf && !accepted.has(node))) {
        return { match: false, reason: "CONTRADICTION" };
      }
      return accepted.has(leaf)
        ? { match: true, node: leaf, reason: "SHOPIFY_CATEGORY" }
        : { match: false, reason: "CONTRADICTION" };
    }
    if (categoryProvesGroup(path, group)) {
      return {
        match: true,
        node: knownTypeNodes.find((node) => accepted.has(node)) ?? null,
        reason: "SHOPIFY_CATEGORY",
      };
    }
  }

  const types = evidence.canonicalTypes.length
    ? evidence.canonicalTypes : evidence.merchantTypes;
  for (const type of types) {
    const leaf = classifySoldItemLeaf(type);
    if (leaf) {
      return accepted.has(leaf)
        ? {
          match: true,
          node: leaf,
          reason: evidence.canonicalTypes.length ? "CANONICAL" : "MERCHANT_TYPE",
        }
        : { match: false, reason: "CONTRADICTION" };
    }
  }
  return { match: false, reason: "UNCLASSIFIED" };
}

export function supportedFamilyGroups() {
  return Object.keys(GROUP_MEMBERS) as FamilyGroup[];
}
