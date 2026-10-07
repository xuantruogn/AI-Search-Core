import assert from "node:assert/strict";

import {
  sourceOwnedSemanticDemandIdentities,
  sourceOwnedSemanticExactConstraints,
  QUERY_EMBEDDING_PIPELINE_VERSION,
  QUERY_SEMANTIC_PROFILE_VERSION,
} from "../app/services/search/query-semantic-profile.server";
import {
  buildDirectEmbeddingPlan,
  fuseSemanticVectorBranches,
  resolveSemanticRetrievalScope,
} from "../app/services/search/semantic-search.server";
import { parseRewrittenQuery } from "../app/services/search/query-rewriter.server";
import {
  currentSearchPipelineSignature,
} from "../app/services/search/search-result-cache.server";
import {
  SEMANTIC_CONTRACT_VERSION,
} from "../app/services/search/semantic-contract.server";

assert.deepEqual(
  sourceOwnedSemanticDemandIdentities({
    originalQuery: "tôi muốn xe đạp để đi cuối tuần",
    identities: ["bicycle"],
    mandatoryConcepts: [{ target: "bicycle", source: "xe đạp" }],
  }),
  ["bicycle"],
  "translated shopper-owned identity must survive the legacy adapter",
);

assert.deepEqual(
  sourceOwnedSemanticDemandIdentities({
    originalQuery: "quà tặng giáng sinh",
    identities: ["gift box"],
    mandatoryConcepts: [{ target: "Christmas celebration", source: "giáng sinh" }],
  }),
  [],
  "LLM-expanded product identity must not become shopper-owned identity",
);

assert.deepEqual(
  sourceOwnedSemanticDemandIdentities({
    originalQuery: "bicycle accessories",
    identities: ["bicycle"],
    mandatoryConcepts: [{ target: "accessories", source: "bicycle accessories" }],
  }),
  [],
  "reference/family words must not be promoted when canonical MUST meaning disagrees",
);

assert.deepEqual(
  sourceOwnedSemanticExactConstraints({
    originalQuery: "áo xanh",
    exactConstraints: ["blue"],
    mandatoryConcepts: [
      { target: "shirt", source: "áo" },
      { target: "blue", source: "xanh" },
    ],
  }),
  ["blue"],
  "validated multilingual exact values must preserve source ownership",
);

assert.deepEqual(
  sourceOwnedSemanticExactConstraints({
    originalQuery: "áo xanh",
    exactConstraints: ["green"],
    mandatoryConcepts: [
      { target: "shirt", source: "áo" },
      { target: "blue", source: "xanh" },
    ],
  }),
  [],
  "unpaired LLM exact values must not gain source ownership",
);

assert.equal(
  resolveSemanticRetrievalScope({
    retrievalMode: "DISCOVERY",
    exactIdentityScope: false,
    identityIds: ["SUPERFLASH"],
    directExpansionScopeIds: [],
  }),
  undefined,
  "DISCOVERY context grounding must never hard-scope Qdrant before recall",
);

assert.deepEqual(
  resolveSemanticRetrievalScope({
    retrievalMode: "DIRECT",
    exactIdentityScope: true,
    identityIds: ["SHOE-A"],
    directExpansionScopeIds: ["SHOE-B"],
  }),
  ["SHOE-A", "SHOE-B"],
  "only exact source-grounded DIRECT identity may pre-scope retrieval",
);

const directIdentityRewrite = {
  query: "Looking for shoes with size 32",
  planning: {
    retrievalMode: "DIRECT",
    semanticQuery: "Looking for shoes with size 32",
    resolvedSegments: [],
  },
  analysis: {
    shopLanguageProductType: "shoes",
    productType: "shoes",
    productTypes: ["shoes"],
    brands: [],
    models: [],
    requiredAttributes: [],
    optionalPreferences: [],
    attributes: [],
    audience: [],
    compatibility: [],
    useCases: [],
    semanticExpansions: [],
    negativeTerms: [],
    intent: "Looking for shoes with size 32",
  },
} as any;
const directIdentityPlan = buildDirectEmbeddingPlan(directIdentityRewrite);
assert.ok(
  directIdentityPlan.targetIdentityUsesPrimary ||
    (directIdentityPlan.targetIdentityBranchIndex ?? 0) > 0,
  "DIRECT shopper-owned target identity must have an independent dense evidence lane",
);
const identityFusion = fuseSemanticVectorBranches(
  [
    [{
      productId: "PANTS32",
      handle: "pants-32",
      title: "Trousers Size 32",
      score: 0.6,
      vectorSimilarity: 0.6,
    }],
    [{
      productId: "SHOE32",
      handle: "shoe-32",
      title: "Shoe Size 32",
      score: 0.55,
      vectorSimilarity: 0.55,
    }],
  ],
  20,
  {
    targetIdentityBranchIndex: 1,
    targetIdentityUsesPrimary: false,
  },
);
assert.equal(
  identityFusion.find((item) => item.productId === "PANTS32")
    ?.targetIdentityVectorSimilarity,
  undefined,
);
assert.equal(
  identityFusion.find((item) => item.productId === "SHOE32")
    ?.targetIdentityVectorSimilarity,
  0.55,
  "target-family semantic evidence must stay distinct from generic query similarity",
);

const parsedRewrite = parseRewrittenQuery(
  JSON.stringify({
    semanticDemand: {
      identity: ["bicycle"],
      desiredOutcomes: ["weekend riding"],
      useCases: [],
      contexts: [],
      qualities: [],
      audience: [],
      styles: [],
      negativeConstraints: [],
      exactConstraints: [],
    },
    detectedLanguage: "vi",
    retrievalMode: "DIRECT",
    referenceTerms: [],
    semanticQuery: "Looking for bicycle. The goal is weekend riding.",
    expansions: ["bike"],
    mandatoryConcepts: [
      { target: "bicycle", source: "xe đạp" },
      { target: "weekend riding", source: "đi cuối tuần" },
    ],
    mustNotTerms: [],
  }),
  "tôi muốn xe đạp để đi cuối tuần",
  "en",
  "COMPLEX",
);
assert.ok(parsedRewrite, "aligned mandatory-concept rewrite must parse");
assert.deepEqual(
  parsedRewrite?.analysis.semanticMandatoryConcepts,
  [
    { target: "bicycle", source: "xe đạp" },
    { target: "weekend riding", source: "đi cuối tuần" },
  ],
);
assert.deepEqual(parsedRewrite?.analysis.semanticMustTerms, [
  "bicycle",
  "weekend riding",
]);
assert.deepEqual(parsedRewrite?.analysis.semanticSourceMustTerms, [
  "xe đạp",
  "đi cuối tuần",
]);

const signature = currentSearchPipelineSignature();
assert.ok(signature.includes("qdrant:"), "cache signature must include resolved collection");
assert.ok(signature.includes("dense:1536"), "cache signature must include embedding dimension");
assert.ok(signature.includes("qdrant/bm25"), "cache signature must include BM25 contract");
assert.ok(signature.includes(QUERY_SEMANTIC_PROFILE_VERSION));
assert.ok(signature.includes(QUERY_EMBEDDING_PIPELINE_VERSION));
assert.ok(signature.includes(SEMANTIC_CONTRACT_VERSION));
assert.ok(signature.includes("semantic-product-v9-supply-demand-dense-bm25"));

console.log("PASS: source-owned identity and cache schema responsibility boundaries");
