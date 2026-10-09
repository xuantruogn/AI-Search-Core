import assert from "node:assert/strict";

import {
  sourceOwnedSemanticDemandIdentities,
  sourceOwnedSemanticExactConstraints,
  resolveCodeOwnedRetrievalMode,
  QUERY_EMBEDDING_PIPELINE_VERSION,
  QUERY_SEMANTIC_PROFILE_VERSION,
  applySemanticPolarity,
} from "../app/services/search/query-semantic-profile.server";
import {
  buildDirectEmbeddingPlan,
  buildDiscoveryEmbeddingBranches,
  fuseSemanticVectorBranches,
  resolveSemanticRetrievalScope,
} from "../app/services/search/semantic-search.server";
import { parseRewrittenQuery } from "../app/services/search/query-rewriter.server";
import { parseDeterministicQuery } from "../app/services/search/deterministic-query-parser.server";
import {
  currentSearchPipelineSignature,
} from "../app/services/search/search-result-cache.server";
import {
  SEMANTIC_CONTRACT_VERSION,
} from "../app/services/search/semantic-contract.server";
import {
  currentTargetColors,
  detectExplicitGender,
} from "../app/services/search/shop-context-index.server";

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
  ["upper body clothing"],
  "exact modifier must preserve the breadth of the source-owned áo noun, not narrow it to shirt",
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

assert.equal(
  detectExplicitGender(
    "grey sneakers",
    {
      analysis: {
        productType: "Women's",
        productTypes: ["Women's", "sneaker"],
        entities: [],
        attributes: [],
        audience: [],
        shopLanguageTerms: [],
        negativeTerms: [],
      },
      planning: { resolvedSegments: [] },
    } as any,
  ),
  null,
  "LLM/catalog product labels must not invent a shopper-owned gender filter",
);

assert.equal(
  detectExplicitGender(
    "women's grey sneakers",
    {
      analysis: {
        productType: "sneaker",
        productTypes: ["sneaker"],
        entities: [],
        attributes: [],
        audience: [],
        shopLanguageTerms: [],
        negativeTerms: [],
      },
      planning: { resolvedSegments: [] },
    } as any,
  ),
  "FEMALE",
  "explicit shopper gender remains code-owned source evidence",
);

const semanticPolarityPlan = {
  attributes: [
    { name: "feature", value: "waterproof", normalizedValue: "waterproof", mode: "SHOULD", confidence: 0.7, source: "FULL_LLM" },
    { name: "feature", value: "hood", normalizedValue: "hood", mode: "SHOULD", confidence: 0.7, source: "FULL_LLM" },
  ],
  audiences: [
    { value: "hikers", normalizedValue: "hikers", mode: "SHOULD", confidence: 0.8, source: "FULL_LLM" },
  ],
  contexts: [
    { value: "winter", normalizedValue: "winter", mode: "SHOULD", confidence: 0.8, source: "FULL_LLM" },
  ],
  compatibility: [
    { value: "PlayStation 5", normalizedValue: "playstation 5", mode: "SHOULD", confidence: 0.8, source: "FULL_LLM" },
    { value: "USB-C", normalizedValue: "usb c", mode: "MUST", confidence: 1, source: "CODE" },
  ],
} as any;
const semanticPolarityResult = applySemanticPolarity(
  semanticPolarityPlan,
  {
    analysis: {
      semanticMustTerms: ["waterproof", "hikers", "winter", "PlayStation 5"],
      semanticSourceMustTerms: ["hikers"],
      semanticMustNotTerms: ["hood"],
    },
  } as any,
);
assert.equal(semanticPolarityResult.attributes[0]?.mode, "SHOULD");
assert.equal(semanticPolarityResult.audiences[0]?.mode, "SHOULD");
assert.equal(semanticPolarityResult.contexts[0]?.mode, "SHOULD");
assert.equal(
  semanticPolarityResult.compatibility.find((item: any) => item.value === "PlayStation 5")?.mode,
  "SHOULD",
  "LLM semantic MUST must not manufacture closed-world compatibility",
);
assert.equal(
  semanticPolarityResult.compatibility.find((item: any) => item.value === "USB-C")?.mode,
  "MUST",
  "code-owned exact compatibility must remain hard",
);
assert.equal(
  semanticPolarityResult.attributes.find((item: any) => item.value === "hood")?.mode,
  "MUST_NOT",
  "explicit negative semantic polarity keeps exclusion authority",
);

assert.deepEqual(
  parseDeterministicQuery("Presta valve adapter for PlayStation 5").compatibility
    .map((item) => item.normalizedValue),
  ["playstation 5"],
  "versioned platform after generic for must remain deterministic compatibility",
);
assert.deepEqual(
  parseDeterministicQuery("case for iphone 15").compatibility
    .map((item) => item.normalizedValue),
  ["iphone 15"],
  "known lowercase versioned model family must keep compatibility provenance",
);
assert.deepEqual(
  parseDeterministicQuery("adapter compatible with device 5").compatibility
    .map((item) => item.normalizedValue),
  ["device 5"],
  "explicit compatibility verb may own an arbitrary versioned model family",
);
assert.equal(
  parseDeterministicQuery("shirt for toddler 5").compatibility.length,
  0,
  "generic recipient/age phrasing must not become compatibility",
);
assert.equal(
  parseDeterministicQuery("gift for runner 10").compatibility.length,
  0,
  "generic audience/use-case plus a number must remain semantic",
);

assert.deepEqual(
  currentTargetColors(
    "áo trắng",
    {
      analysis: {
        sourceOwnedExactConstraints: ["white"],
        negativeTerms: [],
        negativeAttributes: [],
      },
      planning: {
        retrievalMode: "DIRECT",
        resolvedSegments: [
          {
            text: "trắng",
            canonicalValue: "white",
            field: "ATTRIBUTE",
            confidence: 1,
          },
        ],
      },
    } as any,
    new Set(["white", "blue"]),
  ),
  ["white"],
  "typed target color must be source-owned and catalog-enumerated",
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
