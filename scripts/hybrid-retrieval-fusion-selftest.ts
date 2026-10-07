import assert from "node:assert/strict";
import { fuseHybridRetrieval } from "../app/services/search/hybrid-retrieval-fusion.server";
import type { QueryPlan } from "../app/services/search/query-plan.server";
import type { SearchResult } from "../app/services/search/semantic-search.server";

const directPlan: QueryPlan = {
  rawQuery: "smart watch",
  normalizedQuery: "smart watch",
  foldedQuery: "smart watch",
  route: "LIGHT_LLM",
  retrievalMode: "DIRECT",
  semanticQuery: "smart watch",
  identities: [{
    value: "watch",
    normalizedValue: "watch",
    mode: "MUST",
    confidence: 1,
    source: "DICTIONARY",
  }],
  entities: {
    brands: [],
    models: [],
    identifiers: [],
  },
  attributes: [],
  measurements: [],
  audiences: [],
  contexts: [],
  compatibility: [],
  marketPreference: "ANY",
  relation: "SINGLE",
  sort: { field: "RELEVANCE" },
  resolvedSegments: [],
  unresolvedSegments: ["smart"],
  routerReason: ["selftest"],
  versions: {
    dictionaryVersion: "test",
    queryParserVersion: "test",
    queryRouterVersion: "test",
  },
};

const compatibilityPlan: QueryPlan = {
  ...directPlan,
  semanticQuery: "presta valve pump",
  identities: [],
  compatibility: [{
    value: "Presta valves",
    normalizedValue: "presta valves",
    mode: "MUST",
    confidence: 1,
    source: "DICTIONARY",
  }],
  unresolvedSegments: ["pump"],
};

const semantic = (id: string, score: number): SearchResult => ({
  productId: id,
  handle: id.toLowerCase(),
  title: id,
  score,
  vectorSimilarity: score,
  primaryVectorSimilarity: score,
});

const identityOnly: SearchResult = {
  productId: "WATCH",
  handle: "watch",
  title: "Digital Watch",
  score: 0.92,
  structuredScore: 0.92,
  structuredMatchedKinds: ["PRODUCT_TYPE"],
  structuredAnchorKinds: ["PRODUCT_TYPE"],
  structuredExactCanonicalIdentity: true,
  retrievalSources: ["STRUCTURED"],
};

const compatibility: SearchResult = {
  productId: "PUMP",
  handle: "pump",
  title: "Mini Pump",
  score: 0.84,
  structuredScore: 0.84,
  structuredMatchedKinds: ["COMPATIBILITY"],
  structuredAnchorKinds: ["COMPATIBILITY"],
  structuredGuardRescue: true,
  retrievalSources: ["STRUCTURED"],
};

{
  const fused = fuseHybridRetrieval({
    plan: directPlan,
    semantic: [],
    structured: [identityOnly],
    lexical: [],
    semanticNoEvidence: true,
    semanticThreshold: 0.5,
    limit: 20,
  });
  assert.equal(fused.results.length, 0, "identity-only must not rescue unresolved smart watch");
  assert.equal(fused.diagnostics.structuredSuppressedByGuard, 1);
}

{
  const fused = fuseHybridRetrieval({
    plan: compatibilityPlan,
    semantic: [],
    structured: [compatibility],
    lexical: [],
    semanticNoEvidence: true,
    semanticThreshold: 0.5,
    limit: 20,
  });
  assert.equal(fused.results.length, 1, "closed-world compatibility may rescue semantic no-evidence");
  assert.equal(fused.results[0]?.productId, "PUMP");
}

{
  const lexical: SearchResult = {
    productId: "CASE",
    handle: "black-orca-world-iphone-18-pro-case",
    title: "Black Orca World iPhone 18 Pro Case",
    score: 0.995,
    lexicalScore: 0.995,
    lexicalMatchType: "EXACT_TITLE",
    retrievalSources: ["LEXICAL"],
  };
  const fused = fuseHybridRetrieval({
    plan: directPlan,
    semantic: [semantic("OTHER", 0.72)],
    structured: [],
    lexical: [lexical],
    semanticNoEvidence: false,
    semanticThreshold: 0.5,
    limit: 20,
  });
  assert.equal(fused.results[0]?.productId, "CASE", "exact lexical title must outrank pure semantic neighbor");
}

{
  const structured: SearchResult = {
    ...identityOnly,
    productId: "A",
    handle: "a",
    title: "A",
  };
  const fused = fuseHybridRetrieval({
    plan: { ...directPlan, unresolvedSegments: [] },
    semantic: [semantic("A", 0.44)],
    structured: [structured],
    lexical: [],
    semanticNoEvidence: false,
    semanticThreshold: 0.5,
    limit: 20,
  });
  assert.deepEqual(
    fused.results[0]?.retrievalSources?.sort(),
    ["SEMANTIC", "STRUCTURED"],
    "fusion must preserve provenance from both lanes",
  );
  assert.ok((fused.results[0]?.score ?? 0) > 0.44);
}

{
  const fused = fuseHybridRetrieval({
    plan: compatibilityPlan, semantic: [], structured: [compatibility], lexical: [],
    semanticNoEvidence: true, sourceProductClassAbsent: true,
    semanticThreshold: 0.5, limit: 20,
  });
  assert.equal(fused.results.length, 0, "reference compatibility cannot rescue an absent target family");
}

{
  const warmPlan: QueryPlan = {
    ...directPlan, unresolvedSegments: [],
    attributes: [{ value: "warm", normalizedValue: "warm", mode: "SHOULD", confidence: 1, source: "DICTIONARY", name: "attribute" }],
  };
  const fused = fuseHybridRetrieval({
    plan: warmPlan, semantic: [semantic("WARM", 0.52)],
    structured: [{ ...identityOnly, productId: "GENERIC_JACKET" }], lexical: [],
    semanticNoEvidence: false, semanticThreshold: 0.35, limit: 20,
  });
  assert.deepEqual(fused.results.map(r => r.productId), ["WARM"],
    "identity-only standalone results cannot outrank warm evidence just because every query token was resolved");
  const grounded = fuseHybridRetrieval({
    plan: warmPlan, semantic: [],
    structured: [{ ...identityOnly, structuredMatchedKinds: ["PRODUCT_TYPE", "ATTRIBUTE"],
      structuredMatchedTerms: [{ kind: "ATTRIBUTE", value: "warm" }] }], lexical: [],
    semanticNoEvidence: true, semanticThreshold: 0.35, limit: 20,
  });
  assert.equal(grounded.results.length, 1, "actual matched warm fact retains structured rescue");
}

{
  const size32Pants: SearchResult = {
    productId: "PANTS32",
    handle: "pants-32",
    title: "Trousers Size 32",
    score: 0.92,
    structuredScore: 0.92,
    structuredMatchedKinds: ["MEASUREMENT"],
    structuredAnchorKinds: ["MEASUREMENT"],
    structuredGuardRescue: true,
    retrievalSources: ["STRUCTURED"],
  };
  const size32Shoe: SearchResult = {
    ...size32Pants,
    productId: "SHOE32",
    handle: "shoe-32",
    title: "Shoe Size 32",
  };
  const fused = fuseHybridRetrieval({
    plan: { ...directPlan, unresolvedSegments: [] },
    semantic: [],
    structured: [size32Pants, size32Shoe],
    lexical: [],
    semanticNoEvidence: true,
    hasSourceOwnedTargetIdentity: true,
    sourceOwnedTargetProductIds: ["SHOE32"],
    semanticThreshold: 0.35,
    limit: 20,
  });
  assert.deepEqual(
    fused.results.map((result) => result.productId),
    ["SHOE32"],
    "measurement authority must be scoped to the shopper-owned target family",
  );
}

{
  const wrongFamilyExactCanonical: SearchResult = {
    productId: "PANTS32",
    handle: "pants-32",
    title: "Trousers Size 32",
    score: 0.94,
    structuredScore: 0.94,
    structuredMatchedKinds: ["PRODUCT_TYPE", "MEASUREMENT"],
    structuredAnchorKinds: ["MEASUREMENT"],
    structuredGuardRescue: true,
    structuredExactCanonicalIdentity: true,
    retrievalSources: ["STRUCTURED"],
  };
  const fused = fuseHybridRetrieval({
    plan: { ...directPlan, unresolvedSegments: [] },
    semantic: [],
    structured: [wrongFamilyExactCanonical],
    lexical: [],
    semanticNoEvidence: false,
    hasSourceOwnedTargetIdentity: true,
    sourceOwnedTargetProductIds: ["SHOE32"],
    semanticThreshold: 0.35,
    limit: 20,
  });
  assert.equal(
    fused.results.length,
    0,
    "wrong-family exact canonical metadata must not restore stripped measurement authority",
  );
}

console.log("PASS: hybrid retrieval fusion preserves lane authority and no-evidence safety");
