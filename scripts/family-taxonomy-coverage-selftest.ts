import assert from "node:assert/strict";
import {
  classifyFamilyProduct,
  classifySoldItemLeaf,
  familyGroupForCanonicalTarget,
  queryFamilyFromSource,
  shopifyCategoryIsClothing,
  shopifyCategoryLeaf,
  supportedFamilyGroups,
  type FamilyGroup,
} from "../app/services/search/product-family-taxonomy.server";
import {
  classifyPureFamilyLookup,
  retrieveCompleteFamilyCandidates,
} from "../app/services/search/pure-family-lookup.server";

function plan(rawQuery: string, canonical = rawQuery, mode: "DIRECT" | "DISCOVERY" = "DIRECT") {
  return {
    rawQuery,
    retrievalMode: mode,
    identities: [{ value: canonical, mode: "MUST" }],
    resolvedSegments: [],
    unresolvedSegments: [],
    entities: { brands: [], models: [], identifiers: [] },
    attributes: [],
    measurements: [],
    audiences: [],
    contexts: [],
    compatibility: [],
    marketPreference: "ANY",
    relation: "SINGLE",
    sort: { field: "RELEVANCE" },
  } as any;
}
function rewrite(source: string, canonical = source) {
  return {
    analysis: {
      semanticMandatoryConcepts: [{ source, target: canonical }],
      semanticDemand: {
        identity: [canonical],
        desiredOutcomes: [],
        useCases: [],
        contexts: [],
        qualities: [],
        audience: [],
        styles: [],
        exactConstraints: [],
        negativeConstraints: [],
      },
    },
  } as any;
}

const sourceFamilies: Array<[string, FamilyGroup]> = [
  ["váy", "dress_or_skirt"], ["đầm", "dresses"], ["chân váy", "skirts"],
  ["áo", "tops"], ["áo sơ mi", "shirts"], ["áo khoác", "jackets"], ["áo len", "sweaters"],
  ["quần", "bottoms"], ["quần jean", "jeans"], ["quần short", "shorts"],
  ["quần lót", "underwear"], ["đồ ngủ", "sleepwear"], ["đồ bơi", "swimwear"],
  ["quần áo", "clothing"], ["giày", "footwear"], ["giày thể thao", "sneakers"],
  ["giày boot", "boots"], ["dép", "sandals"], ["túi", "bags"], ["túi xách", "handbags"],
  ["balo", "backpacks"], ["ví", "wallets"], ["thắt lưng", "belts"], ["mũ", "hats"],
  ["kính râm", "sunglasses"], ["trang sức", "jewelry"], ["nhẫn", "rings"],
  ["dây chuyền", "necklaces"], ["vòng tay", "bracelets"], ["bông tai", "earrings"],
  ["đồng hồ", "watches"], ["xe", "vehicles"], ["xe đạp", "bicycles"], ["ô tô", "cars"],
  ["xe máy", "motorcycles"], ["điện thoại", "phones"], ["ốp điện thoại", "phone_cases"],
  ["máy tính", "computers"], ["laptop", "laptops"], ["máy tính bảng", "tablets"],
  ["phụ kiện máy tính", "computer_accessories"], ["màn hình máy tính", "monitors"],
  ["bàn phím", "keyboards"], ["chuột máy tính", "mice"], ["tai nghe", "headphones"],
  ["loa", "speakers"], ["máy ảnh", "cameras"], ["tivi", "televisions"],
  ["nội thất", "furniture"], ["ghế", "seating"], ["ghế sofa", "sofas"], ["bàn", "tables"],
  ["bàn làm việc", "desks"], ["giường", "beds"], ["tủ", "cabinets"], ["kệ", "shelves"],
  ["đèn", "lighting"], ["thảm", "floor_coverings"], ["mỹ phẩm", "beauty"],
  ["trang điểm", "makeup"], ["chăm sóc da", "skincare"], ["sữa rửa mặt", "cleansers"],
  ["chăm sóc tóc", "haircare"], ["dầu gội", "shampoos"], ["dầu xả", "conditioners"],
  ["nước hoa", "fragrance"], ["đồ uống", "beverages"], ["trà", "tea"], ["cà phê", "coffee"],
  ["đồ ăn vặt", "snacks"], ["ván trượt tuyết", "snowboards"],
  ["ván trượt", "skateboards"], ["bóng thể thao", "sports_balls"],
];
for (const [query, group] of sourceFamilies) {
  assert.equal(queryFamilyFromSource(query), group, query);
  assert.equal(
    classifyPureFamilyLookup(plan(query), rewrite(query))?.taxonomyGroup,
    group,
    "pure-family route: " + query,
  );
}
assert.equal(queryFamilyFromSource("áo đỏ"), null);
assert.equal(queryFamilyFromSource("giày size 42"), null);
assert.equal(queryFamilyFromSource("xe đạp dưới 10 triệu"), null);
assert.equal(queryFamilyFromSource("váy cho mùa đông"), null);

const canonicalTargets: Array<[string, FamilyGroup]> = [
  ["running shoes", "sneakers"], ["vintage shirt", "shirts"],
  ["winter jacket", "jackets"], ["pleated skirt", "skirts"],
  ["road bicycle", "bicycles"], ["smartphone", "phones"],
  ["phone case", "phone_cases"], ["notebook computer", "laptops"],
  ["computer monitor", "monitors"], ["wireless headphones", "headphones"],
  ["dining table", "tables"], ["face wash", "cleansers"],
  ["perfume", "fragrance"], ["loose leaf tea", "tea"], ["snowboard", "snowboards"],
];
for (const [target, group] of canonicalTargets) {
  assert.equal(familyGroupForCanonicalTarget(target), group, target);
}

const leafCases: Array<[string, string | null]> = [
  ["Evening Dress", "dress"], ["Pleated Skirt", "skirt"], ["Dress Shirt", "shirt"],
  ["Denim Jacket", "jacket"], ["Running Shoes", "sneaker"], ["Chelsea Boots", "boot"],
  ["Leather Handbag", "handbag"], ["Travel Backpack", "backpack"], ["Gold Ring", "ring"],
  ["Road Bicycle", "bicycle"], ["Bicycle Helmet", null], ["Toy Car", null],
  ["Smartphone Case", "phone_case"], ["Laptop Sleeve", null],
  ["Gaming Keyboard", "keyboard"], ["Bluetooth Speaker", "speaker"],
  ["Dining Table", "table"], ["Coffee Table", "table"], ["Face Wash", "cleanser"],
  ["Anti-dandruff Shampoo", "shampoo"], ["Loose Leaf Tea", "tea"], ["Toy Snowboard", null],
];
for (const [value, leaf] of leafCases) {
  assert.equal(classifySoldItemLeaf(value), leaf, value);
}

const category = (pathValue: string) => ({
  canonicalTypes: [] as string[],
  merchantTypes: [] as string[],
  shopifyCategoryPaths: [pathValue],
});
const categoryCases: Array<[string, FamilyGroup, boolean]> = [
  ["Apparel & Accessories > Clothing > Dresses", "dress_or_skirt", true],
  ["Apparel & Accessories > Clothing > Skirts", "dress_or_skirt", true],
  ["Apparel & Accessories > Clothing > Shirts & Tops", "tops", true],
  ["Apparel & Accessories > Clothing > Shirts & Tops", "shirts", false],
  ["Apparel & Accessories > Clothing > Shirts & Tops", "jackets", false],
  ["Apparel & Accessories > Clothing > Coats & Jackets", "jackets", true],
  ["Apparel & Accessories > Clothing > Pants", "bottoms", true],
  ["Apparel & Accessories > Shoes", "footwear", true],
  ["Apparel & Accessories > Shoes", "sneakers", false],
  ["Apparel & Accessories > Jewelry > Rings", "rings", true],
  ["Vehicles & Parts > Vehicles > Bicycles", "bicycles", true],
  ["Vehicles & Parts > Vehicle Parts & Accessories > Bicycle Accessories", "bicycles", false],
  ["Toys & Games > Toys > Toy Vehicles > Cars", "vehicles", false],
  ["Electronics > Communications > Telephony > Mobile Phones", "phones", true],
  ["Electronics > Computers > Laptops", "laptops", true],
  ["Electronics > Audio > Headphones", "headphones", true],
  ["Home & Garden > Furniture > Chairs", "seating", true],
  ["Home & Garden > Furniture > Chairs", "sofas", false],
  ["Home & Garden > Furniture > Tables", "tables", true],
  ["Health & Beauty > Personal Care > Cosmetics > Skin Care", "skincare", true],
  ["Food, Beverages & Tobacco > Beverages > Tea", "tea", true],
  ["Sporting Goods > Outdoor Recreation > Winter Sports > Snowboards", "snowboards", true],
];
for (const [pathValue, group, expected] of categoryCases) {
  assert.equal(classifyFamilyProduct(category(pathValue), group).match, expected, group + ": " + pathValue);
}
assert.equal(shopifyCategoryIsClothing("Apparel & Accessories > Clothing > Dresses"), true);
assert.equal(shopifyCategoryIsClothing("Apparel & Accessories > Clothing Accessories > Belts"), false);
assert.equal(shopifyCategoryLeaf("Vehicles & Parts > Vehicles > Bicycles"), "bicycle");
assert.equal(shopifyCategoryLeaf("Toys & Games > Toys > Toy Vehicles > Cars"), null);

assert.equal(classifyFamilyProduct({
  canonicalTypes: ["Shirt"], merchantTypes: [],
  shopifyCategoryPaths: ["Apparel & Accessories > Clothing > Shirts & Tops"],
}, "shirts").match, true);
assert.equal(classifyFamilyProduct({
  canonicalTypes: ["Running Shoes"], merchantTypes: [],
  shopifyCategoryPaths: ["Apparel & Accessories > Shoes"],
}, "sneakers").match, true);
assert.equal(classifyFamilyProduct({
  canonicalTypes: ["Bicycle Helmet"], merchantTypes: ["Bicycle"],
  shopifyCategoryPaths: ["Vehicles & Parts > Vehicles > Bicycles"],
}, "bicycles").match, false);
assert.equal(classifyFamilyProduct({
  canonicalTypes: ["Dress Shirt"], merchantTypes: [],
  shopifyCategoryPaths: ["Apparel & Accessories > Clothing > Dresses"],
}, "dress_or_skirt").match, false);
assert.equal(classifyFamilyProduct({
  canonicalTypes: ["Phone Charger"], merchantTypes: [],
  shopifyCategoryPaths: ["Electronics > Communications > Telephony > Mobile Phones"],
}, "phones").match, false);
assert.equal(classifyFamilyProduct({
  canonicalTypes: ["Skirt"], merchantTypes: [],
  shopifyCategoryPaths: ["Apparel & Accessories > Clothing > Dresses"],
}, "dress_or_skirt").match, true);

const fixtureTypes = [
  ["Apparel & Accessories > Clothing > Dresses", "dress"],
  ["Apparel & Accessories > Clothing > Skirts", "skirt"],
  ["Apparel & Accessories > Clothing > Shirts & Tops", "shirt"],
  ["Apparel & Accessories > Clothing > Coats & Jackets", "jacket"],
  ["Apparel & Accessories > Shoes", "shoe"],
  ["Apparel & Accessories > Jewelry > Rings", "ring"],
  ["Vehicles & Parts > Vehicles > Bicycles", "bicycle"],
  ["Vehicles & Parts > Vehicle Parts & Accessories > Bicycle Helmets", "helmet"],
  ["Electronics > Communications > Telephony > Mobile Phones", "phone"],
  ["Electronics > Communications > Telephony > Mobile Phone Accessories > Cases", "phone_case"],
  ["Electronics > Computers > Laptops", "laptop"],
  ["Home & Garden > Furniture > Chairs", "chair"],
  ["Health & Beauty > Personal Care > Cosmetics > Skin Care", "skincare"],
  ["Food, Beverages & Tobacco > Beverages > Tea", "tea"],
  ["Sporting Goods > Outdoor Recreation > Winter Sports > Snowboards", "snowboard"],
  ["Toys & Games > Toys > Toy Vehicles > Cars", "toy_car"],
] as const;

const rows = Array.from({ length: 1600 }, (_, i) => {
  const [pathValue, label] = fixtureTypes[i % fixtureTypes.length];
  return {
    productId: String(i),
    label,
    terms: [{
      kind: "SHOPIFY_CATEGORY_PATH",
      value: pathValue,
      normalizedValue: pathValue.toLowerCase(),
    }],
  };
});

async function completeCount(query: string, expectedGroup: FamilyGroup) {
  const result = await retrieveCompleteFamilyCandidates({
    shop: "fixture.myshopify.com",
    plan: plan(query),
    rewrite: rewrite(query),
  }, {
    scanProfiles: async (_shop, visit) => {
      for (const row of rows) {
        await visit({ productId: row.productId, terms: row.terms, updatedAt: new Date() });
      }
      return rows.length;
    },
    findRegistry: async (_shop, ids) => ids.map((productId) => ({
      productId,
      handle: "item-" + productId,
      title: "Catalog item " + productId,
    })),
  });
  assert.ok(result, query);
  assert.equal(result.target.taxonomyGroup, expectedGroup, query);
  assert.equal(new Set(result.results.map((item) => item.productId)).size, result.results.length);
  return result;
}

assert.equal((await completeCount("váy", "dress_or_skirt")).searchableProducts, 200);
assert.equal((await completeCount("áo", "tops")).searchableProducts, 200);
assert.equal((await completeCount("giày", "footwear")).searchableProducts, 100);
assert.equal((await completeCount("trang sức", "jewelry")).searchableProducts, 100);
assert.equal((await completeCount("xe đạp", "bicycles")).searchableProducts, 100);
assert.equal((await completeCount("điện thoại", "phones")).searchableProducts, 100);
assert.equal((await completeCount("laptop", "laptops")).searchableProducts, 100);
assert.equal((await completeCount("ghế", "seating")).searchableProducts, 100);
assert.equal((await completeCount("chăm sóc da", "skincare")).searchableProducts, 100);
assert.equal((await completeCount("trà", "tea")).searchableProducts, 100);
assert.equal((await completeCount("ván trượt tuyết", "snowboards")).searchableProducts, 100);

assert.ok(supportedFamilyGroups().length >= 50, "expected broad retail family coverage");

console.log("PASS: generalized product-family taxonomy across major retail categories and complete-profile coverage");
