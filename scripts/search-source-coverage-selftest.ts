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
  { productId: "hiker-jacket", terms: [["CANONICAL_PRODUCT_TYPE", "jacket"], ["AUDIENCE", "hikers"]] },
  { productId: "unknown-audience-jacket", terms: [["CANONICAL_PRODUCT_TYPE", "jacket"]] },
  { productId: "opposing-climate", terms: [["PRODUCT_TITLE", "Cold Weather Riding Gloves"]] },
  { productId: "unknown-climate", terms: [["PRODUCT_TITLE", "Lightweight Top"]] },
  { productId: "broad-sweater", terms: [["CANONICAL_PRODUCT_TYPE", "sweater"]] },
  { productId: "broad-shirt", terms: [["CANONICAL_PRODUCT_TYPE", "shirt"]] },
  { productId: "accessory-scarf", terms: [["CANONICAL_PRODUCT_TYPE", "scarf"]] },
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
  assert.equal(
    results[0].productId,
    "partial",
    "primary full-Demand dense evidence must outrank lexical source-coverage overlap",
  );
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
    "a soft source facet may rerank but must not hard-exclude a same-family alternative",
  );
  const missingGroundedResults = await filterResultsByExplicitGender({
    shop: "source-coverage-fixture", originalQuery: direct.query, rewrite: direct,
    results: [{ productId: "generic-jacket", score: 0.65, vectorSimilarity: 0.65,
      primaryVectorSimilarity: 0.40, retrievalSources: ["SEMANTIC"], semanticBranchInput: "jacket", semanticBranchIndex: 1 }],
  });
  assert.deepEqual(
    missingGroundedResults.map(r => r.productId),
    ["generic-jacket"],
    "missing open-world facet evidence must not become a hidden hard filter",
  );

  const audienceRewrite: any = {
    ...direct,
    query: "jacket for hikers",
    analysis: {
      ...direct.analysis,
      attributes: [],
      optionalPreferences: [],
      audience: ["hikers"],
      semanticExpansions: [],
    },
    planning: { ...direct.planning, resolvedSegments: [], unresolvedSegments: [] },
    context: {},
  };
  const audienceResults = await filterResultsByExplicitGender({
    shop: "source-coverage-fixture",
    originalQuery: audienceRewrite.query,
    rewrite: audienceRewrite,
    results: [
      { productId: "hiker-jacket", score: 0.48, vectorSimilarity: 0.48, primaryVectorSimilarity: 0.48, retrievalSources: ["SEMANTIC"] },
      { productId: "unknown-audience-jacket", score: 0.47, vectorSimilarity: 0.47, primaryVectorSimilarity: 0.47, retrievalSources: ["SEMANTIC"] },
    ],
  });
  assert.deepEqual(
    new Set(audienceResults.map(r => r.productId)),
    new Set(["hiker-jacket", "unknown-audience-jacket"]),
  );
  assert.equal(audienceResults[0]?.productId, "hiker-jacket");

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
  const climateResults = await filterResultsByExplicitGender({
    shop: "source-coverage-fixture", originalQuery: "something for hot weather",
    rewrite: { ...rewrite, planning: { ...rewrite.planning, resolvedSegments: [] },
      analysis: { ...rewrite.analysis, semanticExpansions: [] } },
    results: [
      { productId: "opposing-climate", score: 0.50, vectorSimilarity: 0.50,
        primaryVectorSimilarity: 0.50, retrievalSources: ["SEMANTIC"] },
      { productId: "unknown-climate", score: 0.45, vectorSimilarity: 0.45,
        primaryVectorSimilarity: 0.45, retrievalSources: ["SEMANTIC"] },
    ],
  });
  assert.deepEqual(climateResults.map(r => r.productId), ["unknown-climate", "opposing-climate"],
    "Explicit context contradiction must demote without becoming a hard eligibility filter");
  const climateDiversity = await filterResultsByExplicitGender({
    shop: "source-coverage-fixture", originalQuery: "something for hot weather",
    rewrite: { ...rewrite, planning: { ...rewrite.planning, resolvedSegments: [] } },
    results: [
      { productId: "opposing-climate", score: 0.50, vectorSimilarity: 0.50,
        primaryVectorSimilarity: 0.50, retrievalSources: ["SEMANTIC"], semanticBranchIndex: 2, semanticBranchRelativeScore: 1 },
      ...["unknown-climate", "partial", "alternative", "complete"].map((productId, i) => ({
        productId, score: 0.49 - i * 0.01, vectorSimilarity: 0.49 - i * 0.01,
        primaryVectorSimilarity: 0.49 - i * 0.01, retrievalSources: ["SEMANTIC"],
        semanticBranchIndex: i + 3, semanticBranchRelativeScore: 1,
      })),
    ],
  });
  assert.equal(climateDiversity.at(-1)?.productId, "opposing-climate",
    "Diversity must not promote a contradictory branch champion back to the top");
  console.log("PASS: source coverage reranks without stealing hard-filter authority");
  for (const [family, mode, expected] of [
    ['upper body clothing','DISCOVERY',['broad-sweater','broad-shirt']],
    ['shirt','DIRECT',['broad-shirt']],
  ] as const) {
    const familyResults = await filterResultsByExplicitGender({
      shop:'source-coverage-fixture', originalQuery:'áo cho thời tiết lạnh',
      rewrite:{...rewrite,planning:{...rewrite.planning,retrievalMode:mode,resolvedSegments:[]},
        analysis:{...rewrite.analysis,retrievalMode:mode,sourceOwnedTargetIdentities:[family],productType:family,productTypes:[family],semanticExpansions:[]}},
      results:[
        {productId:'accessory-scarf',score:0.6,vectorSimilarity:0.6,primaryVectorSimilarity:0.6,retrievalSources:['SEMANTIC']},
        {productId:'broad-sweater',score:0.46,vectorSimilarity:0.46,primaryVectorSimilarity:0.46,retrievalSources:['SEMANTIC']},
        {productId:'broad-shirt',score:0.43,vectorSimilarity:0.43,primaryVectorSimilarity:0.43,retrievalSources:['SEMANTIC']},
      ],
    });
    assert.deepEqual(familyResults.map(r=>r.productId),expected,'Source-family breadth must survive discovery while named subtype stays narrow');
  }
} finally {
  (db.aiSearchProductSemanticProfile as any).findMany = originalFindMany;
  await db.$disconnect();
}
