import assert from "node:assert/strict";
import { classifyPureFamilyLookup, classifyVerifiedFamilyMember, retrieveCompleteFamilyCandidates } from "../app/services/search/pure-family-lookup.server";
import { typedProductFamilyMatches } from "../app/services/search/structured-candidate-retrieval.server";

const makePlan = (query: string, canonical: string, mode: "DIRECT"|"DISCOVERY" = "DIRECT") => ({
  rawQuery: query, normalizedQuery: query, foldedQuery: query,
  route: "STRUCTURED_ONLY", retrievalMode: mode,
  identities: [{ value: canonical, mode: "MUST", confidence: 1, source: "DICTIONARY" }],
  resolvedSegments: [{ text: query, canonicalValue: canonical, field: "PRODUCT_TYPE", confidence: 1, start: 0, end: query.split(" ").length }],
  unresolvedSegments: [],
  entities: { brands: [], models: [], identifiers: [] },
  attributes: [], measurements: [], audiences: [], contexts: [], compatibility: [],
  marketPreference: "ANY", sort: { field: "RELEVANCE" }, relation: "SINGLE",
}) as any;

const makeRewrite = (canonical: string, source: string, extra: Record<string, string[]> = {}) => ({
  fallbackReason: null,
  analysis: {
    semanticMandatoryConcepts: [{ source, target: canonical }],
    semanticDemand: {
      identity: [canonical], desiredOutcomes: [], useCases: [], contexts: [],
      qualities: [], audience: [], styles: [], negativeConstraints: [],
      exactConstraints: [], ...extra,
    },
  },
}) as any;

assert.deepEqual(classifyPureFamilyLookup(makePlan("bicycle", "bicycle"), makeRewrite("bicycle", "bicycle")),
  { canonical: "bicycle", broadCategory: false, taxonomyGroup: "bicycle" });

assert.deepEqual(classifyPureFamilyLookup(
  makePlan("clothes", "clothes", "DISCOVERY"),
  makeRewrite("clothes", "clothes"),
), { canonical: "clothing", broadCategory: true });

const translatedPlan = makePlan("Xe đạp", "bicycle");
translatedPlan.identities = [];
translatedPlan.resolvedSegments = [];
translatedPlan.unresolvedSegments = ["xe dap"];
translatedPlan.route = "FULL_LLM";
assert.deepEqual(classifyPureFamilyLookup(translatedPlan, makeRewrite("bicycle", "Xe đạp")),
  { canonical: "bicycle", broadCategory: false, taxonomyGroup: "bicycle" });

const winter = makePlan("winter clothing", "clothing", "DISCOVERY");
winter.resolvedSegments = [];
winter.unresolvedSegments = ["winter"];
assert.equal(classifyPureFamilyLookup(winter, makeRewrite("clothing", "winter clothing",
  { contexts: ["winter"] })), null);
const black = makePlan("black bicycle", "bicycle");
black.resolvedSegments = [{ text: "bicycle", canonicalValue: "bicycle", field: "PRODUCT_TYPE" }];
black.attributes = [{ value: "black", mode: "SHOULD" }];
assert.equal(classifyPureFamilyLookup(black, makeRewrite("bicycle", "black bicycle")), null);
const price = makePlan("bicycle under $500", "bicycle");
assert.equal(classifyPureFamilyLookup(price, makeRewrite("bicycle", "bicycle under $500")), null);

assert.equal(typedProductFamilyMatches("Fixed Gear Bicycle", "bicycle"), true);
assert.equal(typedProductFamilyMatches("bicycles", "bicycle"), true);
assert.equal(typedProductFamilyMatches("dresses", "dress"), true);
assert.equal(typedProductFamilyMatches("bicycle helmet", "bicycle"), false);
assert.equal(typedProductFamilyMatches("bicycle basket", "bicycle"), false);
assert.equal(typedProductFamilyMatches("ski goggles", "ski"), false);

const bicycle = { canonical: "bicycle", broadCategory: false };
assert.equal(classifyVerifiedFamilyMember([{ kind: "CANONICAL_PRODUCT_TYPE", value: "Bicycle" }], bicycle), "EXACT");
assert.equal(classifyVerifiedFamilyMember([{ kind: "CANONICAL_PRODUCT_TYPE", value: "Fixed Gear Bicycle" }], bicycle), "SUBTYPE");
assert.equal(classifyVerifiedFamilyMember([
  { kind: "CANONICAL_PRODUCT_TYPE", value: "Helmet" },
  { kind: "PRODUCT_TYPE", value: "Helmet" },
  { kind: "CATEGORY", value: "Bicycles" },
  { kind: "ALIAS", value: "Bicycle" },
], bicycle), null);
assert.equal(classifyVerifiedFamilyMember([{ kind: "ALIAS", value: "Bicycle" }], bicycle), null);
assert.equal(classifyVerifiedFamilyMember([
  { kind: "CANONICAL_PRODUCT_TYPE", value: "Helmet" },
  { kind: "PRODUCT_TYPE", value: "Bicycle" },
], bicycle), null);

const broad = { canonical: "clothing", broadCategory: true };
assert.equal(classifyVerifiedFamilyMember([
  { kind: "CANONICAL_PRODUCT_TYPE", value: "Sweater" },
  { kind: "CATEGORY", value: "Apparel > Clothing > Sweaters" },
], broad), "CATEGORY");
assert.equal(classifyVerifiedFamilyMember([
  { kind: "CANONICAL_PRODUCT_TYPE", value: "Bicycle Helmet" },
  { kind: "CATEGORY", value: "Sporting Goods > Bicycle Accessories" },
], broad), null);

// >500 catalog products must be validated independently of cosine/candidate
// window. This is the same membership predicate used by the streamed loader.
const fixtures = Array.from({length: 825}, (_, n) => ({
  productId: String(n),
  terms: [{ kind: "CANONICAL_PRODUCT_TYPE", value: n % 2 === 0 ? "Bicycle" : "Road Bicycle" }],
}));
const full = fixtures.filter((item) => classifyVerifiedFamilyMember(item.terms, bicycle) !== null);
assert.equal(full.length, 825);
assert.equal(full.slice(0, 500).length, 500);
assert.equal(full.at(-1)?.productId, "824");

const complete = await retrieveCompleteFamilyCandidates({
  shop: "test-shop",
  plan: makePlan("bicycle", "bicycle"),
  rewrite: makeRewrite("bicycle", "bicycle"),
}, {
  scanProfiles: async (_shop, visit) => {
    for (const entry of fixtures) {
      await visit({ ...entry, terms: entry.terms.map((term) => ({
        ...term, normalizedValue: term.value.toLowerCase(),
      })), updatedAt: new Date() });
    }
    await visit({
      productId: "helmet", updatedAt: new Date(),
      terms: [{ kind: "CANONICAL_PRODUCT_TYPE", value: "Bicycle Helmet", normalizedValue: "bicycle helmet" }],
    });
    return fixtures.length + 1;
  },
  findRegistry: async (_shop, ids) =>
    ids.map((productId) => ({
      productId,
      handle: `bike-${productId}`,
      title: `Bicycle ${productId}`,
    })),
});
assert.ok(complete);
assert.equal(complete.searchableProducts, 825);
assert.equal(complete.matchedProfiles, 825);
assert.equal(complete.scannedProfiles, 826);
assert.equal(new Set(complete.results.map((x) => x.productId)).size, 825);
console.log("PASS: complete family source stream and registry batches >500, no accessory leakage");
