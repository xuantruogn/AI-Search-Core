import assert from "node:assert/strict";
import {
  classifyFamilyProduct, classifySoldItemLeaf, queryFamilyFromSource,
  shopifyCategoryLeaf, shopifyCategoryIsClothing,
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
assert.equal(queryFamilyFromSource("áo cho bé"), null);
assert.equal(classifyPureFamilyLookup(plan("váy"), rewrite)?.taxonomyGroup, "dress_or_skirt");
assert.equal(classifyPureFamilyLookup(plan("áo", "shirt"), rewrite)?.taxonomyGroup, "tops");
assert.equal(classifyPureFamilyLookup(plan("xe", "car", "DISCOVERY"), rewrite)?.taxonomyGroup, "vehicles");
assert.equal(classifyPureFamilyLookup(plan("xe đạp", "bicycle"), rewrite)?.taxonomyGroup, "bicycle");
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
assert.equal(classifyFamilyProduct(category(
  "Vehicles & Parts > Vehicle Parts & Accessories > Bicycle Helmets"), "bicycle").match, false);
assert.equal(classifyFamilyProduct(category(
  "Toys & Games > Toys > Toy Vehicles > Cars"), "vehicles").match, false);
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

console.log("PASS: source-owned family taxonomy, cross-language Dress/Skirt union, Shopify category and >500 coverage");
