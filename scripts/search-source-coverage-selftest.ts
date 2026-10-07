import assert from "node:assert/strict";
import db from "../app/db.server";
import { filterResultsByExplicitGender } from "../app/services/search/shop-context-index.server";

const originalFindMany = db.aiSearchProductSemanticProfile.findMany;
const profiles = [
  { productId: "partial", terms: [["USE_CASE", "commuting"]] },
  { productId: "complete", terms: [["USE_CASE", "commuting"], ["SOFT_CONTEXT", "cycling in wet weather"]] },
  { productId: "alternative", terms: [["USE_CASE", "commuting"]] },
  { productId: "source-jacket", terms: [["CANONICAL_PRODUCT_TYPE", "jacket"], ["ATTRIBUTE", "waterproof"]] },
  { productId: "generic-jacket", terms: [["CANONICAL_PRODUCT_TYPE", "jacket"]] },
];
(db.aiSearchProductSemanticProfile as any).findMany = async () => profiles.map(({ productId, terms }) => ({
  productId, updatedAt: new Date(), profile: {
    schemaVersion: 2, analysisMeta: null,
    terms: terms.map(([kind, value]) => ({ kind, value, normalizedValue: value })),
  },
}));
try {
  const rewrite: any = {
    query: "something for wet weather commuting", rewritten: true, catalogRelevant: true,
    analysis: {
      intent: "something for wet weather commuting", retrievalMode: "DISCOVERY",
      productType: "", productTypes: [], shopLanguageProductType: "", category: "",
      brands: [], models: [], identifiers: [], audience: [], requiredAttributes: [],
      optionalPreferences: [], attributes: [], useCases: [], compatibility: [],
      entities: [], shopLanguageTerms: [], englishTerms: [], negativeAttributes: [],
      negativeTerms: [], semanticMustTerms: [], semanticSourceMustTerms: [],
      semanticExpansions: ["cycling", "bags", "clothes"],
    },
    planning: {
      retrievalMode: "DISCOVERY", resolvedSegments: [
        { text: "wet weather", canonicalValue: "wet weather", field: "CONTEXT", confidence: 0.72 },
        { text: "commuting", canonicalValue: "commuting", field: "CONTEXT", confidence: 0.72 },
      ], unresolvedSegments: [],
    },
  };
  const candidates = [
    { productId: "partial", score: 0.52, vectorSimilarity: 0.52, primaryVectorSimilarity: 0.52, retrievalSources: ["SEMANTIC"], semanticBranchIndex: 1, semanticBranchRelativeScore: 1 },
    { productId: "complete", score: 0.48, vectorSimilarity: 0.48, primaryVectorSimilarity: 0.48, retrievalSources: ["SEMANTIC"], semanticBranchIndex: 2, semanticBranchRelativeScore: 1 },
    { productId: "alternative", score: 0.50, vectorSimilarity: 0.50, primaryVectorSimilarity: 0.50, retrievalSources: ["SEMANTIC"], semanticBranchIndex: 3, semanticBranchRelativeScore: 1 },
    { productId: "extra", score: 0.45, vectorSimilarity: 0.45, primaryVectorSimilarity: 0.45, retrievalSources: ["SEMANTIC"], semanticBranchIndex: 4, semanticBranchRelativeScore: 1 },
  ];
  const results = await filterResultsByExplicitGender({
    shop: "source-coverage-fixture", originalQuery: rewrite.query, rewrite, results: candidates,
  });
  assert.equal(results[0].productId, "complete", "both source needs outrank a slightly stronger partial vector match");
  assert.equal(results.length, candidates.length, "soft source coverage preserves partial alternatives");
  assert.deepEqual(new Set(results.map(r => r.productId)), new Set(candidates.map(r => r.productId)));

  const direct: any = {
    ...rewrite, query: "waterproof jacket",
    analysis: { ...rewrite.analysis, retrievalMode: "DIRECT", productType: "jacket",
      productTypes: ["jacket"], attributes: ["waterproof"], optionalPreferences: ["waterproof"],
      semanticExpansions: ["rain jacket"] },
    planning: { ...rewrite.planning, retrievalMode: "DIRECT", unresolvedSegments: [],
      resolvedSegments: [{ text: "waterproof", canonicalValue: "waterproof", field: "ATTRIBUTE", confidence: 1 }] },
    context: { directSourceFacetGroundedProductIds: ["source-jacket"],
      directSourceFacetConsensusProductIds: ["source-jacket"] },
  };
  const identityBranchResults = await filterResultsByExplicitGender({
    shop: "source-coverage-fixture", originalQuery: direct.query, rewrite: direct,
    results: [
      { productId: "source-jacket", score: 0.45, vectorSimilarity: 0.45, primaryVectorSimilarity: 0.45, retrievalSources: ["SEMANTIC"] },
      { productId: "generic-jacket", score: 0.65, vectorSimilarity: 0.65, primaryVectorSimilarity: 0.40,
        retrievalSources: ["SEMANTIC"], semanticBranchInput: "jacket", semanticBranchIndex: 1 },
    ],
  });
  assert.deepEqual(
    identityBranchResults.map(r => r.productId),
    ["source-jacket", "generic-jacket"],
    "open-world waterproof evidence must rerank within the jacket family without hard-filtering semantic alternatives",
  );
  const missingGroundedResults = await filterResultsByExplicitGender({
    shop: "source-coverage-fixture", originalQuery: direct.query, rewrite: direct,
    results: [{ productId: "generic-jacket", score: 0.65, vectorSimilarity: 0.65,
      primaryVectorSimilarity: 0.40, retrievalSources: ["SEMANTIC"], semanticBranchInput: "jacket", semanticBranchIndex: 1 }],
  });
  assert.deepEqual(
    missingGroundedResults.map(r => r.productId),
    ["generic-jacket"],
    "missing PSF evidence for an open-world quality must remain uncertainty, not an empty-result proof",
  );

  const expansionOnly = await filterResultsByExplicitGender({
    shop: "source-coverage-fixture", originalQuery: "jacket for evenings", rewrite: {
      ...direct,
      analysis: { ...direct.analysis, attributes: [], optionalPreferences: [] },
      planning: { ...direct.planning, resolvedSegments: [], unresolvedSegments: ["evenings"] },
      context: { directExpansionGroundedProductIds: ["generic-jacket"] },
    },
    results: [
      { productId: "source-jacket", score: 0.6, vectorSimilarity: 0.6, primaryVectorSimilarity: 0.6, retrievalSources: ["SEMANTIC"] },
      { productId: "generic-jacket", score: 0.55, vectorSimilarity: 0.55, primaryVectorSimilarity: 0.55, retrievalSources: ["SEMANTIC"] },
    ],
  });
  assert.equal(expansionOnly.length, 2,
    "LLM expansion evidence remains a ranking hint and cannot hard-exclude a valid source-family candidate");

  const jointDemandRewrite: any = {
    ...rewrite,
    query: "something warm and insulated for cold weather",
    analysis: {
      ...rewrite.analysis,
      semanticDemand: {
        identity: [],
        desiredOutcomes: ["stay warm"],
        useCases: [],
        contexts: ["cold weather"],
        qualities: ["insulated"],
        audience: [],
        styles: [],
        negativeConstraints: [],
        exactConstraints: [],
      },
      semanticMustTerms: [],
      semanticSourceMustTerms: [],
      semanticExpansions: ["winter jacket", "fleece"],
    },
    planning: {
      ...rewrite.planning,
      retrievalMode: "DISCOVERY",
      resolvedSegments: [],
      unresolvedSegments: [],
    },
  };
  const jointDemandRanked = await filterResultsByExplicitGender({
    shop: "source-coverage-fixture",
    originalQuery: jointDemandRewrite.query,
    rewrite: jointDemandRewrite,
    results: [
      {
        productId: "semantic-good",
        score: 0.46,
        vectorSimilarity: 0.62,
        primaryVectorSimilarity: 0.62,
        retrievalSources: ["SEMANTIC", "SPARSE"],
      },
      {
        productId: "semantic-weak",
        score: 0.61,
        vectorSimilarity: 0.61,
        primaryVectorSimilarity: 0.44,
        retrievalSources: ["SEMANTIC", "SPARSE"],
      },
    ],
  });
  assert.equal(
    jointDemandRanked[0]?.productId,
    "semantic-good",
    "complete Semantic Demand similarity must outrank a higher fused recall score when exact/family authority is equal",
  );
  assert.equal(
    jointDemandRanked.length,
    2,
    "joint semantic evidence reranks open-world demand but does not hard-filter alternatives",
  );
  console.log("PASS: source need coverage ranks joint facts without making soft needs hard filters");
} finally {
  (db.aiSearchProductSemanticProfile as any).findMany = originalFindMany;
  await db.$disconnect();
}
