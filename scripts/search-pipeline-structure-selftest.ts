import assert from "node:assert/strict";
import {
  composeContextualEmbeddingInput,
  normalizeIdentitySignalTokens,
  readComplementReferenceOnlyFacetTokens,
  readComplementTargetFacetTokens,
  readDiscoveryLeafTypeHints,
  readStrictTargetAttributes,
} from "../app/services/search/shop-context-index.server";
import type { QueryRewriteResult } from "../app/services/search/query-rewriter.server";
import type { QueryPlan } from "../app/services/search/query-plan.server";
import {
  resolveCodeOwnedRetrievalMode,
  shouldPromoteSourceNamedDirectTarget,
  stripComplementReferenceMustTerms,
  stripReferenceScopedFacetsFromEmbedding,
} from "../app/services/search/query-semantic-profile.server";
import {
  buildDiscoveryEmbeddingBranches,
  buildDirectEmbeddingPlan,
  computeDiscoveryRecallThreshold,
  fuseSemanticVectorBranches,
} from "../app/services/search/semantic-search.server";
import { hasStructuredAnchor } from "../app/services/search/structured-candidate-retrieval.server";

function rewrite(mode: "DIRECT" | "DISCOVERY" | "COMPLEMENT", semanticQuery: string, referenceTerms: string[] = []) {
  return {
    planning: { retrievalMode: mode, semanticQuery },
    analysis: { retrievalMode: mode, referenceTerms },
  } as unknown as QueryRewriteResult;
}

const winterDiscoveryRewrite = {
  ...rewrite("DISCOVERY", "winter clothing"),
  analysis: {
    ...rewrite("DISCOVERY", "winter clothing").analysis,
    intent: "winter clothing",
    semanticExpansions: [
      "winter clothing",
      "winter coat",
      "sweater",
      "fleece sweatshirt",
    ],
    semanticMustTerms: ["winter"],
    requiredAttributes: [],
    useCases: [],
    compatibility: [],
  },
} as QueryRewriteResult;
assert.deepEqual(
  buildDirectEmbeddingPlan({
    ...rewrite("DIRECT", "black cardigan"),
    query: "black cardigan ; cardigan ; black",
    analysis: {
      ...rewrite("DIRECT", "black cardigan").analysis,
      shopLanguageProductType: "cardigan",
      productType: "cardigan",
      productTypes: ["cardigan"],
      brands: [], models: [], requiredAttributes: [],
      optionalPreferences: ["black"], attributes: ["black"],
      audience: [], negativeTerms: [],
    },
  } as QueryRewriteResult),
  { primary: "cardigan", branches: ["cardigan ; black"] },
);
assert.deepEqual(
  buildDiscoveryEmbeddingBranches(winterDiscoveryRewrite),
  [
    "winter coat",
    "sweater ; winter",
    "fleece sweatshirt ; winter",
  ],
);

const fusedBranches = fuseSemanticVectorBranches(
  [
    [
      { productId: "a", handle: "a", title: "A", score: 0.61 },
      { productId: "b", handle: "b", title: "B", score: 0.58 },
    ],
    [
      { productId: "b", handle: "b", title: "B", score: 0.72 },
      { productId: "c", handle: "c", title: "C", score: 0.69 },
    ],
  ],
  10,
);
assert.deepEqual(
  fusedBranches.map((item) => item.productId),
  ["b", "c", "a"],
);

assert.deepEqual(normalizeIdentitySignalTokens("men's"), []);
assert.deepEqual(normalizeIdentitySignalTokens("women's top"), ["top"]);
assert.deepEqual(normalizeIdentitySignalTokens("Sneakers"), ["sneakers"]);
assert.deepEqual(normalizeIdentitySignalTokens("women's black leather wallet"), [
  "black", "leather", "wallet",
]);

for (const referenceTerms of [[], ["skirt"], ["black skirt"], ["apparel"]]) {
  assert.deepEqual(
    readStrictTargetAttributes(
      "what should I wear with a black skirt",
      rewrite("COMPLEMENT", "tops to pair with a black skirt", referenceTerms),
    ),
    [],
    `reference color leaked into target for ${referenceTerms.join(",")}`,
  );
}
assert.deepEqual(
  readStrictTargetAttributes("blue dress", rewrite("DIRECT", "blue dress")),
  [],
);

const navyCoatComplementPlan = {
  retrievalMode: "COMPLEMENT",
  referenceTerms: ["coat"],
} as unknown as QueryPlan;
assert.deepEqual(
  stripComplementReferenceMustTerms({
    originalQuery: "what goes well with a navy coat",
    rawPlan: navyCoatComplementPlan,
    values: ["navy coat", "apparel"],
  }),
  ["apparel"],
);
assert.deepEqual(
  readStrictTargetAttributes(
    "navy coat for women",
    rewrite("DIRECT", "navy coat for women"),
  ),
  [],
);
assert.deepEqual(
  readStrictTargetAttributes(
    "black top to wear with blue skirt",
    rewrite("COMPLEMENT", "top to pair with blue skirt", ["skirt"]),
  ),
  [],
);

const coatReferencePlan = {
  retrievalMode: "COMPLEMENT",
  referenceTerms: ["coat"],
} as unknown as QueryPlan;
assert.deepEqual(
  stripComplementReferenceMustTerms({
    originalQuery: "what goes well with a navy coat",
    rawPlan: coatReferencePlan,
    values: ["navy coat", "apparel"],
  }),
  ["apparel"],
);
assert.deepEqual(
  [...readComplementReferenceOnlyFacetTokens(
    "what goes well with a navy coat",
    rewrite("COMPLEMENT", "clothing to wear with coat", ["coat"]),
  )],
  ["navy"],
);
assert.deepEqual(
  [...readComplementReferenceOnlyFacetTokens(
    "black top to wear with blue skirt",
    rewrite("COMPLEMENT", "black top to pair with skirt", ["skirt"]),
  )],
  ["blue"],
);
assert.deepEqual(
  [...readComplementTargetFacetTokens(
    "what should I wear with a black skirt",
    rewrite("COMPLEMENT", "clothing to pair with skirt", ["skirt"]),
  )],
  [],
);
assert.deepEqual(
  [...readComplementTargetFacetTokens(
    "black top to wear with blue skirt",
    rewrite("COMPLEMENT", "black top to pair with skirt", ["skirt"]),
  )].sort(),
  ["black", "top"],
);
assert.deepEqual(
  stripComplementReferenceMustTerms({
    originalQuery: "black top to wear with black skirt",
    rawPlan: {
      retrievalMode: "COMPLEMENT",
      referenceTerms: ["skirt"],
    } as unknown as QueryPlan,
    values: ["black"],
  }),
  ["black"],
);

const contextual = composeContextualEmbeddingInput(
  "I need something that keeps my feet comfortable all day",
  rewrite("DISCOVERY", "comfortable footwear ; walking shoes ; sneakers ; loafers"),
  [
    { kind: "USE_CASE", value: "leather footwear maintenance", score: 12, productCount: 3 },
    { kind: "SOFT_CONTEXT", value: "Protecting footwear from liquids and stains", score: 13, productCount: 2 },
    { kind: "PRODUCT_TYPE", value: "footwear", score: 30, productCount: 30 },
  ],
);
assert.ok(contextual.length <= 300);
assert.ok(!contextual.includes("maintenance"));
assert.ok(!contextual.includes("Protecting"));
assert.ok(contextual.includes("comfortable footwear"));

const optionalBlue = {
  identities: [],
  entities: { identifiers: [], models: [], brands: [] },
  attributes: [{ name: "color", value: "blue", mode: "SHOULD", confidence: 0.55, source: "DICTIONARY" }],
  measurements: [], audiences: [], contexts: [], compatibility: [],
} as unknown as QueryPlan;
assert.equal(hasStructuredAnchor(optionalBlue), false);
assert.equal(hasStructuredAnchor({
  ...optionalBlue,
  identities: [{ value: "dress", mode: "MUST", confidence: 1, source: "DICTIONARY" }],
}), true);

assert.equal(
  resolveCodeOwnedRetrievalMode({
    rawRetrievalMode: "DISCOVERY",
    hasDirectTargetIdentity: false,
  }),
  "DISCOVERY",
);
assert.equal(
  resolveCodeOwnedRetrievalMode({
    rawRetrievalMode: "COMPLEMENT",
    hasDirectTargetIdentity: false,
  }),
  "COMPLEMENT",
);
assert.equal(
  resolveCodeOwnedRetrievalMode({
    rawRetrievalMode: "DISCOVERY",
    hasDirectTargetIdentity: true,
  }),
  "DIRECT",
);

assert.equal(shouldPromoteSourceNamedDirectTarget({
  originalQuery: "kính mắt",
  sourceMustTerms: ["kính mắt"],
  rawRoute: "FULL_LLM",
  groundedIdentityOrCategory: true,
}), true);
assert.equal(shouldPromoteSourceNamedDirectTarget({
  originalQuery: "I need something that keeps my feet comfortable all day",
  sourceMustTerms: ["comfortable footwear", "all-day wear"],
  rawRoute: "LIGHT_LLM",
  groundedIdentityOrCategory: true,
}), false);
assert.equal(shouldPromoteSourceNamedDirectTarget({
  originalQuery: "đồ gia dụng",
  sourceMustTerms: ["đồ gia dụng"],
  rawRoute: "FULL_LLM",
  groundedIdentityOrCategory: false,
}), false);

const complementRawPlan = {
  retrievalMode: "COMPLEMENT",
  resolvedSegments: [
    {
      text: "black",
      start: 6,
      end: 7,
      field: "ATTRIBUTE",
      canonicalValue: "Black",
      confidence: 0.55,
      source: "DICTIONARY",
    },
    {
      text: "skirt",
      start: 7,
      end: 8,
      field: "CONTEXT",
      canonicalValue: "skirt",
      confidence: 1,
      source: "DICTIONARY",
    },
  ],
} as unknown as QueryPlan;
assert.equal(
  stripReferenceScopedFacetsFromEmbedding({
    originalQuery: "what should I wear with a black skirt",
    rawPlan: complementRawPlan,
    value: "apparel to wear with a black skirt | blouse | cardigan",
  }),
  "apparel to wear with a skirt | blouse | cardigan",
);

assert.deepEqual(
  [...readDiscoveryLeafTypeHints([
    "camping backpack",
    "blue light glasses",
    "weekend camping gear and essentials",
    "minimalist fashion",
    "portable camping stove",
  ])].sort(),
  ["backpack", "glasses", "stove"],
);

assert.equal(
  computeDiscoveryRecallThreshold({
    retrievalMode: "DISCOVERY",
    baseThreshold: 0.42,
    retrievalMinimumScore: 0.24,
    candidateScores: [0.48, 0.41, 0.4, 0.39, 0.38, 0.37, 0.36, 0.35, 0.34],
    hasStrongCatalogEvidence: true,
    minRecallResults: 8,
  }),
  0.35,
);
assert.equal(
  computeDiscoveryRecallThreshold({
    retrievalMode: "DISCOVERY",
    baseThreshold: 0.42,
    retrievalMinimumScore: 0.24,
    candidateScores: [0.48, 0.47, 0.46, 0.45, 0.44, 0.43, 0.425, 0.42, 0.4],
    hasStrongCatalogEvidence: true,
    minRecallResults: 8,
  }),
  0.42,
);
assert.equal(
  computeDiscoveryRecallThreshold({
    retrievalMode: "DISCOVERY",
    baseThreshold: 0.42,
    retrievalMinimumScore: 0.24,
    candidateScores: [0.48, 0.41, 0.4, 0.39, 0.38, 0.37, 0.36, 0.35],
    hasStrongCatalogEvidence: false,
    minRecallResults: 8,
  }),
  0.42,
);

console.log("Search pipeline structure self-test: PASS");
