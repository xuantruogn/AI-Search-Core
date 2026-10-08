import assert from "node:assert/strict";
import {
  classifyFamilyProduct, classifyGenericFamilyProduct, classifySoldItemLeaf,
  queryFamilyFromSource, sourceCanonicalFamilyFromSource,
  shopifyCategoryLeaf, shopifyCategoryIsClothing, shopifyCategoryMatchesFamily,
} from "../app/services/search/product-family-taxonomy.server";
import {
  classifyPureFamilyLookup, classifyVerifiedFamilyMember,
  retrieveCompleteFamilyCandidates,
} from "../app/services/search/pure-family-lookup.server";

function plan(rawQuery: string, canonical = "dress", mode = "DIRECT") {
  return {
    rawQuery, retrievalMode: mode,
    identities: [{ value: canonical, mode: "MUST" }],
    resolvedSegments: [],
    unresolvedSegments: [],
    entities: { brands: [], models: [], identifiers: [] },
    attributes: [], measurements: [], audiences: [], contexts: [],
    compatibility: [], marketPreference: "ANY", relation: "SINGLE",
    sort: { field: "RELEVANCE" },
  } as any;
}
const rewrite = {
  analysis: {
    // LLM might mistakenly collapse Vietnamese broad "váy" to "dress".
    semanticMandatoryConcepts: [{ source: "váy", target: "dress" }],
    semanticDemand: {
      identity: ["dress"], desiredOutcomes: [], useCases: [], contexts: [],
      qualities: [], audience: [], styles: ["casual"],
      exactConstraints: [], negativeConstraints: [],
    },
  },
} as any;

assert.equal(queryFamilyFromSource("váy"), "dress_or_skirt");
assert.equal(queryFamilyFromSource("vay"), "dress_or_skirt");
assert.equal(queryFamilyFromSource("chân váy"), "skirt");
assert.equal(queryFamilyFromSource("đầm"), "dress");
assert.equal(queryFamilyFromSource("Áo"), "tops");
assert.equal(queryFamilyFromSource("Xe"), "vehicles");
assert.equal(queryFamilyFromSource("xe đạp"), "bicycle");
assert.equal(queryFamilyFromSource("váy đỏ"), null);
assert.equal(sourceCanonicalFamilyFromSource("giày"), "shoes");
assert.equal(sourceCanonicalFamilyFromSource("túi xách"), "handbags");
assert.equal(sourceCanonicalFamilyFromSource("trang sức"), "jewelry");
assert.equal(sourceCanonicalFamilyFromSource("đồng hồ"), "watches");
assert.equal(sourceCanonicalFamilyFromSource("điện thoại"), "phones");
assert.equal(sourceCanonicalFamilyFromSource("laptop"), "laptops");
assert.equal(sourceCanonicalFamilyFromSource("tai nghe"), "headphones");
assert.equal(sourceCanonicalFamilyFromSource("máy ảnh"), "cameras");
assert.equal(sourceCanonicalFamilyFromSource("nội thất"), "furniture");
assert.equal(sourceCanonicalFamilyFromSource("mỹ phẩm"), "cosmetics");
assert.equal(sourceCanonicalFamilyFromSource("đồ chơi"), "toys");
assert.equal(sourceCanonicalFamilyFromSource("giày đỏ"), null);
assert.equal(sourceCanonicalFamilyFromSource("đèn"), "lighting");
assert.equal(sourceCanonicalFamilyFromSource("đen"), null, "Color black must never become Lighting");
assert.equal(sourceCanonicalFamilyFromSource("bàn"), "tables");
assert.equal(sourceCanonicalFamilyFromSource("ban"), null, "Unaccented ambiguous short word is intentionally not forced");
assert.equal(queryFamilyFromSource("áo cho bé"), null);
assert.equal(classifyPureFamilyLookup(plan("váy"), rewrite)?.taxonomyGroup, "dress_or_skirt");
const tagMisreadPlan = plan("váy");
tagMisreadPlan.attributes.push({ name: "attribute", value: "váy", mode: "SHOULD" });
assert.equal(
  classifyPureFamilyLookup(tagMisreadPlan, rewrite, tagMisreadPlan)?.taxonomyGroup,
  "dress_or_skirt",
  "An unrelated catalog TAG misread as ATTRIBUTE must not suppress a standalone family",
);
assert.equal(classifyPureFamilyLookup(plan("áo", "shirt"), rewrite)?.taxonomyGroup, "tops");
assert.equal(classifyPureFamilyLookup(plan("xe", "car", "DISCOVERY"), rewrite)?.taxonomyGroup, "vehicles");
assert.equal(classifyPureFamilyLookup(plan("xe đạp", "bicycle"), rewrite)?.taxonomyGroup, "bicycle");
assert.equal(classifyPureFamilyLookup(plan("giày", "shoes"), rewrite)?.canonical, "shoes");
assert.equal(classifyPureFamilyLookup(plan("trang sức", "jewelry"), rewrite)?.canonical, "jewelry");
assert.equal(classifyPureFamilyLookup(plan("điện thoại", "phones"), rewrite)?.canonical, "phones");
assert.equal(classifyPureFamilyLookup(plan("laptop", "laptops"), rewrite)?.canonical, "laptops");
assert.equal(classifyPureFamilyLookup(plan("nội thất", "furniture"), rewrite)?.canonical, "furniture");
const exactCatalogPlan = plan("shoes", "shoes");
exactCatalogPlan.resolvedSegments = [{
  text: "shoes", canonicalValue: "Shoes", field: "PRODUCT_TYPE", confidence: 0.96,
}];
const noisyRewrite = {
  analysis: {
    ...rewrite.analysis,
    semanticDemand: {
      ...rewrite.analysis.semanticDemand,
      styles: ["casual"], // model-added soft prose, not shopper-owned
    },
  },
} as any;
assert.equal(classifyPureFamilyLookup(exactCatalogPlan, noisyRewrite)?.canonical, "shoes",
  "Exact catalog family must not be truncated because LLM invented a soft style");
const size = plan("váy size M");
size.measurements.push({ value: "M", name: "size", mode: "MUST" });
assert.equal(classifyPureFamilyLookup(size, rewrite), null);
const red = plan("váy đỏ");
red.attributes.push({ value: "red", name: "color", mode: "SHOULD" });
assert.equal(classifyPureFamilyLookup(red, rewrite), null);

assert.equal(shopifyCategoryLeaf("Apparel & Accessories > Clothing > Dresses"), "dress");
assert.equal(shopifyCategoryLeaf("Apparel & Accessories > Clothing > Skirts"), "skirt");
assert.equal(shopifyCategoryLeaf("Apparel & Accessories > Clothing > Shirts & Tops"), "top");
assert.equal(shopifyCategoryLeaf("Vehicles & Parts > Vehicles > Bicycles"), "bicycle");
assert.equal(shopifyCategoryLeaf("Vehicles & Parts > Vehicle Parts & Accessories > Bicycle Accessories"), null);
assert.equal(shopifyCategoryLeaf("Toys & Games > Toys > Toy Vehicles > Cars"), null);
assert.equal(shopifyCategoryIsClothing("Apparel & Accessories > Clothing > Dresses"), true);
assert.equal(shopifyCategoryIsClothing("Apparel & Accessories > Clothing Accessories > Belts"), false);
assert.equal(classifySoldItemLeaf("Blue Dress"), "dress");
assert.equal(classifySoldItemLeaf("Pleated Skirt"), "skirt");
assert.equal(classifySoldItemLeaf("Women's Bicycle Helmet"), null);
assert.equal(classifySoldItemLeaf("Toy Car"), null);
assert.equal(classifySoldItemLeaf("Vintage Shirt"), "top");
assert.equal(classifySoldItemLeaf("Road Bicycle"), "bicycle");

assert.equal(shopifyCategoryMatchesFamily(
  "Apparel & Accessories > Shoes > Athletic Shoes", "shoes"), true);
assert.equal(shopifyCategoryMatchesFamily(
  "Apparel & Accessories > Jewelry > Necklaces", "jewelry"), true);
assert.equal(shopifyCategoryMatchesFamily(
  "Electronics > Communications > Telephony > Mobile Phones", "phones"), true);
assert.equal(shopifyCategoryMatchesFamily(
  "Electronics > Computers > Laptops", "laptops"), true);
assert.equal(shopifyCategoryMatchesFamily(
  "Furniture > Chairs > Office Chairs", "furniture"), true);
assert.equal(shopifyCategoryMatchesFamily(
  "Health & Beauty > Personal Care > Cosmetics > Makeup", "cosmetics"), true);
assert.equal(shopifyCategoryMatchesFamily(
  "Toys & Games > Toys > Dolls", "toys"), true);
assert.equal(shopifyCategoryMatchesFamily(
  "Media > Books > Fiction Books", "books"), true);
assert.equal(shopifyCategoryMatchesFamily(
  "Electronics > Electronics Accessories > Mobile Phone Accessories", "phones"), false);
assert.equal(shopifyCategoryMatchesFamily(
  "Apparel & Accessories > Clothing Accessories > Shoe Accessories", "shoes"), false);

for (const [requested, path] of [
  ["shoes", "Apparel & Accessories > Shoes > Athletic Shoes"],
  ["jewelry", "Apparel & Accessories > Jewelry > Necklaces"],
  ["phones", "Electronics > Communications > Telephony > Mobile Phones"],
  ["laptops", "Electronics > Computers > Laptops"],
  ["furniture", "Furniture > Chairs > Office Chairs"],
  ["cosmetics", "Health & Beauty > Personal Care > Cosmetics > Makeup"],
  ["toys", "Toys & Games > Toys > Dolls"],
  ["books", "Media > Books > Fiction Books"],
] as const) {
  const verdict = classifyGenericFamilyProduct({
    canonicalTypes: [], merchantTypes: [], shopifyCategoryPaths: [path],
  }, requested);
  assert.equal(verdict.match, true, requested);
}

function category(path: string) {
  return { canonicalTypes: [], merchantTypes: [], shopifyCategoryPaths: [path] };
}
assert.deepEqual(classifyFamilyProduct(category(
  "Apparel & Accessories > Clothing > Skirts"), "dress_or_skirt"),
  { match: true, reason: "SHOPIFY_CATEGORY", node: "skirt" });
assert.deepEqual(classifyFamilyProduct(category(
  "Apparel & Accessories > Clothing > Dresses"), "dress_or_skirt"),
  { match: true, reason: "SHOPIFY_CATEGORY", node: "dress" });
assert.equal(classifyFamilyProduct(category(
  "Apparel & Accessories > Clothing > Dresses"), "tops").match, false);
assert.equal(classifyFamilyProduct({
  canonicalTypes: ["Skirt"], merchantTypes: [],
  shopifyCategoryPaths: ["Apparel & Accessories > Clothing > Dresses"],
}, "dress_or_skirt").match, true, "Both Dress and Skirt belong to the source-owned váy union");
assert.equal(classifyFamilyProduct(category(
  "Vehicles & Parts > Vehicle Parts & Accessories > Bicycle Helmets"), "bicycle").match, false);
assert.equal(classifyFamilyProduct(category(
  "Toys & Games > Toys > Toy Vehicles > Cars"), "vehicles").match, false);
assert.equal(classifyFamilyProduct({
  canonicalTypes: ["Bicycle Helmet"], merchantTypes: ["Bicycle"],
  shopifyCategoryPaths: ["Vehicles & Parts > Vehicles > Bicycles"],
}, "bicycle").match, false, "Wrong Shopify classification cannot turn a helmet into a bicycle");
assert.equal(classifyFamilyProduct({
  canonicalTypes: ["Dress Shirt"], merchantTypes: [],
  shopifyCategoryPaths: ["Apparel & Accessories > Clothing > Dresses"],
}, "dress_or_skirt").match, false, "Dress shirt does not inherit Dress from mistaken standard category");
assert.equal(classifyFamilyProduct({
  canonicalTypes: ["Helmet"], merchantTypes: ["Bicycle"], shopifyCategoryPaths: [],
}, "bicycle").match, false, "Merchant type must not override a helmet identity");

const target = classifyPureFamilyLookup(plan("váy"), rewrite)!;
const members = [
  { id: "d1", terms: [{ kind: "CANONICAL_PRODUCT_TYPE", value: "Evening Dress" }] },
  { id: "s1", terms: [{ kind: "CANONICAL_PRODUCT_TYPE", value: "Pleated Skirt" }] },
  { id: "d2", terms: [{ kind: "SHOPIFY_CATEGORY_PATH", value: "Apparel & Accessories > Clothing > Dresses" }] },
  { id: "s2", terms: [{ kind: "SHOPIFY_CATEGORY_PATH", value: "Apparel & Accessories > Clothing > Skirts" }] },
  { id: "a1", terms: [{ kind: "CANONICAL_PRODUCT_TYPE", value: "Dress Shirt" }] },
  { id: "a2", terms: [{ kind: "CANONICAL_PRODUCT_TYPE", value: "Skirt Hanger" }] },
  { id: "t1", terms: [{ kind: "SHOPIFY_CATEGORY_PATH", value: "Toys & Games > Toys > Doll Dresses" }] },
];
for (const m of members) {
  assert.equal(Boolean(classifyVerifiedFamilyMember(m.terms, target)), ["d1", "s1", "d2", "s2"].includes(m.id), m.id);
}

// A representative mixed shop has >500 Dresses/Skirts, beyond hybrid Top-K.
const rows = Array.from({ length: 1200 }, (_, i) => ({
  productId: String(i),
  terms: [{
    kind: "SHOPIFY_CATEGORY_PATH",
    value: i % 3 === 0
      ? "Apparel & Accessories > Clothing > Dresses"
      : i % 3 === 1
        ? "Apparel & Accessories > Clothing > Skirts"
        : "Apparel & Accessories > Clothing Accessories > Scarves",
  }],
}));
const expected = rows.filter((r) =>
  r.terms[0].value.includes("Dresses") || r.terms[0].value.includes("Skirts"));
const actual = await retrieveCompleteFamilyCandidates({
  shop: "fixture.myshopify.com", plan: plan("váy"), rewrite,
}, {
  scanProfiles: async (_shop, visit) => {
    for (const row of rows) {
      await visit({
        productId: row.productId,
        terms: row.terms.map((term) => ({ ...term, normalizedValue: term.value.toLowerCase() })),
        updatedAt: new Date(),
      });
    }
    return rows.length;
  },
  findRegistry: async (_shop, ids) => ids.map((productId) => ({
    productId, handle: "item-" + productId, title: "Catalog product " + productId,
  })),
});
assert.ok(actual);
assert.equal(expected.length, 800);
assert.equal(actual.searchableProducts, 800);
assert.equal(actual.matchedProfiles, 800);
assert.equal(actual.scannedProfiles, 1200);
assert.equal(actual.categoryMatches, 800);
assert.equal(new Set(actual.results.map((x) => x.productId)).size, 800);

// Generic catalog family must also bypass Top-K and reject accessory descendants.
const shoePlan = plan("shoes", "shoes");
shoePlan.resolvedSegments = [{
  text: "shoes", canonicalValue: "Shoes", field: "PRODUCT_TYPE", confidence: 0.97,
}];
const shoeRows = [
  ...Array.from({ length: 700 }, (_, i) => ({
    productId: "shoe-" + i,
    terms: [{
      kind: "SHOPIFY_CATEGORY_PATH",
      value: i % 2
        ? "Apparel & Accessories > Shoes > Athletic Shoes"
        : "Apparel & Accessories > Shoes > Boots",
    }],
  })),
  ...Array.from({ length: 160 }, (_, i) => ({
    productId: "shoe-accessory-" + i,
    terms: [{
      kind: "SHOPIFY_CATEGORY_PATH",
      value: "Apparel & Accessories > Clothing Accessories > Shoe Accessories",
    }],
  })),
];
const genericComplete = await retrieveCompleteFamilyCandidates({
  shop: "fixture.myshopify.com",
  plan: shoePlan,
  rewrite: noisyRewrite,
}, {
  scanProfiles: async (_shop, visit) => {
    for (const row of shoeRows) {
      await visit({
        productId: row.productId,
        terms: row.terms.map((term) => ({
          ...term, normalizedValue: term.value.toLowerCase(),
        })),
        updatedAt: new Date(),
      });
    }
    return shoeRows.length;
  },
  findRegistry: async (_shop, ids) => ids.map((productId) => ({
    productId, handle: productId, title: productId,
  })),
});
assert.ok(genericComplete);
assert.equal(genericComplete.scannedProfiles, 860);
assert.equal(genericComplete.matchedProfiles, 700);
assert.equal(genericComplete.searchableProducts, 700);
assert.equal(genericComplete.results.some((x) => x.productId.startsWith("shoe-accessory-")), false);

console.log("PASS: source-owned and catalog-wide family taxonomy, >500 coverage, accessory exclusion");
