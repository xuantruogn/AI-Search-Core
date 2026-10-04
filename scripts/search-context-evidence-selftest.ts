import assert from "node:assert/strict";
import {
  discoveryExpansionTypeMatch,
  discoverySourceIdentityCatalogMatch,
  identityLookupTokenVariants,
  matchesExplicitNegativeFacet,
  preferTypedContextEvidence,
  semanticMustSignalMatch,
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
console.log("PASS: typed identity provenance and explicit negative facet morphology");
