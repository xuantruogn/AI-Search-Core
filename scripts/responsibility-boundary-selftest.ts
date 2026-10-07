import assert from "node:assert/strict";

import {
  sourceOwnedSemanticDemandIdentities,
  sourceOwnedSemanticExactConstraints,
  resolveCodeOwnedRetrievalMode,
  QUERY_EMBEDDING_PIPELINE_VERSION,
  QUERY_SEMANTIC_PROFILE_VERSION,
} from "../app/services/search/query-semantic-profile.server";
import {
  buildDirectEmbeddingPlan,
  buildDiscoveryEmbeddingBranches,
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
  sourceOwnedSemanticDemandIdentities({
    originalQuery: "bicycle accessories",
    identities: ["bicycle"],
    mandatoryConcepts: [
      { target: "bicycle accessories", source: "bicycle accessories" },
    ],
  }),
  [],
  "a broader compound target must not promote its contained parent family",
);

assert.deepEqual(
  sourceOwnedSemanticDemandIdentities({
    originalQuery: "quần áo mặc mùa đông",
    identities: ["winter apparel"],
    mandatoryConcepts: [
      { target: "winter apparel", source: "quần áo" },
      { target: "winter", source: "mùa đông" },
    ],
    modifiers: ["winter"],
  }),
  ["apparel"],
  "generic family must stay generic after stripping semantic context",
);

assert.deepEqual(
  sourceOwnedSemanticDemandIdentities({
    originalQuery: "áo trắng",
    identities: ["white shirt"],
    mandatoryConcepts: [
      { target: "shirt", source: "áo" },
      { target: "white", source: "trắng" },
    ],
    exactConstraints: ["white"],
  }),
  ["shirt"],
  "exact modifier may wrap, but must not replace, the source-owned target noun",
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
    originalQuery: "shirt to wear with blue skirt",
    exactConstraints: ["blue"],
    mandatoryConcepts: [
      { target: "blue", source: "blue" },
    ],
    rawPlan: {
      retrievalMode: "COMPLEMENT",
      referenceTerms: ["skirt"],
    } as any,
  }),
  [],
  "reference-item exact facets must not leak into complement target authority",
);

assert.equal(
  resolveCodeOwnedRetrievalMode({
    rawRetrievalMode: "DISCOVERY",
    hasDirectTargetIdentity: true,
  }),
  "DIRECT",
  "a shopper-named translated target must use DIRECT semantics",
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

assert.deepEqual(
  sourceOwnedSemanticExactConstraints({
    originalQuery: "áo xanh đậm",
    exactConstraints: ["blue"],
    mandatoryConcepts: [
      { target: "dark blue", source: "xanh đậm" },
    ],
  }),
  [],
  "a broader translated facet must not grant contained exact authority",
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

assert.equal(
  resolveSemanticRetrievalScope({
    retrievalMode: "DIRECT",
    exactIdentityScope: true,
    identityIds: ["SHOE-A"],
    directExpansionScopeIds: ["SHOE-B"],
  }),
  undefined,
  "literal target-family context must not pre-scope semantic retrieval",
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

const discoveryBranches = buildDiscoveryEmbeddingBranches({
  query: "Looking for outerwear. The goal is staying warm. To use in winter. With insulated and wind resistant. For women. With a style of classic.",
  planning: {
    retrievalMode: "DISCOVERY",
    semanticQuery: "Looking for outerwear. The goal is staying warm.",
    resolvedSegments: [],
  },
  context: { selectedTerms: [] },
  analysis: {
    semanticDemand: {
      identity: ["outerwear"],
      desiredOutcomes: ["staying warm"],
      useCases: ["cold-weather commuting"],
      contexts: ["winter"],
      qualities: ["insulated", "wind resistant"],
      audience: ["women"],
      styles: ["classic"],
      negativeConstraints: [],
      exactConstraints: [],
    },
    semanticMustTerms: ["outerwear"],
    requiredAttributes: [],
    useCases: [],
    compatibility: [],
    semanticExpansions: ["wool coat"],
    intent: "Looking for warm winter outerwear",
  },
} as any);
assert.equal(discoveryBranches.length, 1);
assert.match(discoveryBranches[0] ?? "", /wool coat/i);
assert.match(discoveryBranches[0] ?? "", /staying warm/i);
assert.match(discoveryBranches[0] ?? "", /winter/i);
assert.match(discoveryBranches[0] ?? "", /insulated/i);
assert.match(discoveryBranches[0] ?? "", /women/i);
assert.match(
  discoveryBranches[0] ?? "",
  /classic/i,
  "secondary recall branches must carry the full open-world Demand axes",
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
