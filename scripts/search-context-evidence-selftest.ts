import assert from "node:assert/strict";
import {
  buildShopContextLookupIndex,
  selectContextScoreCandidates,
  discoveryExpansionTypeMatch,
  discoverySourceIdentityCatalogMatch,
  identityLookupTokenVariants,
  matchesExplicitNegativeFacet,
  preferTypedContextEvidence,
  semanticMustSignalMatch,
  sourceContextCatalogValueMatch,
  shouldEnforceDirectIdentity,
} from "../app/services/search/shop-context-index.server";
const selected = preferTypedContextEvidence([
  { kind: "TAG", normalizedValue: "sunglasses", score: 49 },
  { kind: "CANONICAL_PRODUCT_TYPE", normalizedValue: "sunglasses", score: 48 },
  { kind: "ALIAS", normalizedValue: "sun glasses", score: 30 },
  { kind: "TAG", normalizedValue: "summer", score: 20 },
]);
assert.equal(selected.find(t => t.normalizedValue === "sunglasses")?.kind, "CANONICAL_PRODUCT_TYPE");
assert.ok(selected.some(t => t.normalizedValue === "summer"));
assert.ok(discoveryExpansionTypeMatch(["headlamp"], ["headlamp"]));
assert.ok(discoveryExpansionTypeMatch(["boots"], ["hiking boots"]));
assert.ok(!discoveryExpansionTypeMatch(
  ["all", "in", "one", "track", "tool"],
  ["all-in-one printer"],
));
assert.equal(discoverySourceIdentityCatalogMatch({
  kind: "PRODUCT_TYPE",
  catalogValue: "Home",
  semanticTarget: "home",
  expansionValues: [
    "printer for paper documents at home",
    "inkjet printer",
    "home printer",
  ],
}), false);
assert.equal(discoverySourceIdentityCatalogMatch({
  kind: "CANONICAL_PRODUCT_TYPE",
  catalogValue: "headlamp",
  semanticTarget: "headlamp",
  expansionValues: ["gift for hiker", "headlamp"],
}), true);
assert.equal(discoverySourceIdentityCatalogMatch({
  kind: "CATEGORY",
  catalogValue: "jewelry",
  semanticTarget: "jewelry",
  expansionValues: ["jewelry box", "jewelry organizer"],
}), true);
assert.ok(identityLookupTokenVariants("sneakers").has("sneaker"));
assert.ok(identityLookupTokenVariants("dress").has("dresses"));
assert.ok(matchesExplicitNegativeFacet(["hooded", "warm"], "hood"));
assert.ok(matchesExplicitNegativeFacet(["attached hood"], "hood"));
assert.ok(!matchesExplicitNegativeFacet(["without hood"], "hood"));
assert.ok(!matchesExplicitNegativeFacet(["neighborhood print"], "hood"));
assert.ok(matchesExplicitNegativeFacet(["genuine leather"], "leather"));
assert.ok(!matchesExplicitNegativeFacet(["red lining", "blue shell"], "red shell"));
assert.equal(shouldEnforceDirectIdentity({ retrievalMode: "DIRECT", signals: [{ fallback: true }], hasIdentityMatch: true }), false);
assert.equal(shouldEnforceDirectIdentity({ retrievalMode: "DIRECT", signals: [{ fallback: false }], hasIdentityMatch: true }), true);
// Indexed hot-path shortlist must keep every kind of positive-score term
// while skipping unrelated terms and preserving shop-wide typed colors.
const contextFixture = [
  { kind: "CANONICAL_PRODUCT_TYPE", value: "hiking boots", normalizedValue: "hiking boots", tokens: ["hiking", "boots"], productCount: 1, productIds: new Set(["p1"]) },
  { kind: "ATTRIBUTE", value: "Color: Navy", normalizedValue: "color navy", tokens: ["color", "navy"], productCount: 1, productIds: new Set(["p1"]) },
  { kind: "USE_CASE", value: "wet weather commuting", normalizedValue: "wet weather commuting", tokens: ["wet", "weather", "commuting"], productCount: 1, productIds: new Set(["p2"]) },
  { kind: "CANONICAL_PRODUCT_TYPE", value: "headlamp", normalizedValue: "headlamp", tokens: ["headlamp"], productCount: 1, productIds: new Set(["p3"]) },
  { kind: "VENDOR", value: "unrelated supplier", normalizedValue: "unrelated supplier", tokens: ["unrelated", "supplier"], productCount: 1, productIds: new Set(["p4"]) },
];
const contextIndex = buildShopContextLookupIndex(contextFixture as any);
const shortlisted = selectContextScoreCandidates(
  contextIndex,
  ["something for wet weather commuting", "hiking"],
  ["navy"],
  ["headlamps"],
);
const selectedValues = new Set(shortlisted.map((term) => term.normalizedValue));
assert.ok(selectedValues.has("hiking boots"));
assert.ok(selectedValues.has("wet weather commuting"));
assert.ok(selectedValues.has("headlamp"), "plural expansion still recalls canonical leaf");
assert.ok(selectedValues.has("color navy"), "explicit facet with token match remains");
assert.ok(!selectedValues.has("unrelated supplier"), "unrelated catalog terms are no longer scored");
assert.deepEqual([...contextIndex.typedColorVocabulary], ["navy"]);
assert.equal(sourceContextCatalogValueMatch("ATTRIBUTE", "Color: S", "s"), true);
assert.equal(sourceContextCatalogValueMatch("ATTRIBUTE", "Color: M", "s"), false,
  "empty meaningful token arrays must not create false typed-facet matches");
const largeVocabulary = [
  ...contextFixture,
  ...Array.from({ length: 2000 }, (_, index) => ({
    kind: "PRODUCT_TITLE", value: `unrelated product ${index}`,
    normalizedValue: `unrelated product ${index}`,
    tokens: ["unrelated", "product", String(index)],
    productCount: 1, productIds: new Set([`z${index}`]),
  })),
];
const largeIndex = buildShopContextLookupIndex(largeVocabulary as any);
const sparseContextHits = selectContextScoreCandidates(
  largeIndex, ["wet weather commuting"], [], [],
);
assert.ok(sparseContextHits.length < 20,
  "each query must score indexed relevant terms rather than the entire vocabulary");

console.log("PASS: typed identity provenance and explicit negative facet morphology");

// Generic activity prose must not change source-owned context grounding.
assert.equal(sourceContextCatalogValueMatch("USE_CASE", "weekend wear", "weekend"), true);
assert.equal(sourceContextCatalogValueMatch("SOFT_CONTEXT", "weekend use", "weekend"), true);
assert.equal(sourceContextCatalogValueMatch("USE_CASE", "running errands", "running"), false);
assert.equal(sourceContextCatalogValueMatch("USE_CASE", "home printing", "home"), false);
assert.equal(sourceContextCatalogValueMatch("ATTRIBUTE", "weekend wear", "weekend"), true);
assert.equal(sourceContextCatalogValueMatch("USE_CASE", "office use", "office"), true);