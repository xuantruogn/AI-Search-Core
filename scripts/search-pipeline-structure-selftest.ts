import assert from "node:assert/strict";
import {
  composeContextualEmbeddingInput,
  discoveryContextProvesSemanticNeed,
  normalizeIdentitySignalTokens,
  referenceIdentityContainmentMatch,
  readComplementReferenceOnlyFacetTokens,
  readComplementTargetFacetTokens,
  readDiscoveryLeafTypeHints,
  readStrictTargetAttributes,
} from "../app/services/search/shop-context-index.server";
import type { QueryRewriteResult } from "../app/services/search/query-rewriter.server";
import type { QueryPlan } from "../app/services/search/query-plan.server";
import { shouldAnalyzeUnresolvedIdentityRemainder } from "../app/services/search/query-router.server";
import {
  shouldForceCrossLanguageRewrite,
  sourceProductTypeOwnsTarget,
} from "../app/services/search/query-planner.server";
import {
  resolveCodeOwnedRetrievalMode,
  semanticTermsCoverConstraint,
  semanticTermsExplainedByIdentityOrFacets,
  shouldPromoteSourceNamedDirectTarget,
  stripComplementReferenceMustTerms,
  stripReferenceScopedFacetsFromEmbedding,
} from "../app/services/search/query-semantic-profile.server";
import {
  buildDiscoveryEmbeddingBranches,
  buildDirectEmbeddingPlan,
  catalogEvidenceCoversSemanticMustTerms,
  catalogEvidenceNeedMatches,
  computeDiscoveryNoEvidenceThreshold,
  computeDiscoveryRecallThreshold,
  fuseSemanticVectorBranches,
  singleTokenSourceIdentityEvidence,
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
  buildDirectEmbeddingPlan({
    ...rewrite("DIRECT", "men's grey sneakers"),
    query: "men's grey sneakers",
    analysis: {
      ...rewrite("DIRECT", "men's grey sneakers").analysis,
      shopLanguageProductType: "men's",
      productType: "men's",
      productTypes: ["men's", "Sneakers"],
      brands: [], models: [], requiredAttributes: [],
      optionalPreferences: ["Grey"], attributes: ["Grey"],
      audience: [], negativeTerms: [],
    },
  } as QueryRewriteResult),
  { primary: "sneakers", branches: ["sneakers ; Grey", "sneakers ; men"] },
);
assert.deepEqual(
  buildDirectEmbeddingPlan({
    ...rewrite("DIRECT", "white women's top"),
    query: "white women's top",
    analysis: {
      ...rewrite("DIRECT", "white women's top").analysis,
      shopLanguageProductType: "women's top",
      productType: "women's top",
      productTypes: ["women's top"],
      brands: [], models: [], requiredAttributes: [],
      optionalPreferences: ["White"], attributes: ["White"],
      audience: ["women"], negativeTerms: [],
    },
  } as QueryRewriteResult),
  { primary: "top", branches: ["top ; White ; women"] },
);
assert.deepEqual(
  buildDirectEmbeddingPlan({
    ...rewrite("DIRECT", "leather jacket"),
    query: "leather jacket",
    analysis: {
      ...rewrite("DIRECT", "leather jacket").analysis,
      shopLanguageProductType: "leather jacket",
      productType: "leather jacket",
      productTypes: ["leather jacket"],
      brands: [], models: [], requiredAttributes: [],
      optionalPreferences: ["leather"], attributes: ["leather"],
      audience: [], negativeTerms: [],
    },
  } as QueryRewriteResult),
  { primary: "jacket", branches: ["jacket ; leather"] },
);
const commutingBag = {
  ...rewrite("DIRECT", "a bag suitable for daily commuting"),
  query: "a bag suitable for daily commuting",
  planning: {
    route: "VECTOR_SEMANTIC",
    retrievalMode: "DIRECT",
    semanticQuery: "a bag suitable for daily commuting",
    semanticResolution: "VECTOR",
    semanticResolutionConfidence: 1,
    resolvedSegments: [
      { field: "PRODUCT_TYPE", text: "bag", canonicalValue: "bag", confidence: 1 },
      { field: "CONTEXT", text: "daily commuting", canonicalValue: "daily commuting", confidence: 0.72 },
    ],
    unresolvedSegments: ["suitable"],
  },
  analysis: {
    ...rewrite("DIRECT", "a bag suitable for daily commuting").analysis,
    shopLanguageProductType: "bag",
    productType: "bag",
    productTypes: ["bag"],
    brands: [], models: [], requiredAttributes: [],
    optionalPreferences: [], attributes: [], audience: [],
    useCases: [], negativeTerms: [],
  },
} as QueryRewriteResult;
assert.deepEqual(
  buildDirectEmbeddingPlan(commutingBag),
  { primary: "bag", branches: ["bag ; daily commuting"] },
);

const allDayShoes = {
  ...rewrite("DIRECT", "Do you have shoes that are comfortable enough to walk in all day?"),
  query: "Do you have shoes that are comfortable enough to walk in all day?",
  planning: {
    route: "VECTOR_SEMANTIC",
    retrievalMode: "DIRECT",
    semanticQuery: "Do you have shoes that are comfortable enough to walk in all day?",
    semanticResolution: "VECTOR",
    semanticResolutionConfidence: 1,
    resolvedSegments: [
      { field: "PRODUCT_TYPE", text: "shoes", canonicalValue: "Shoes", confidence: 0.86 },
      { field: "ATTRIBUTE", text: "comfortable", canonicalValue: "Comfortable", confidence: 1 },
    ],
    unresolvedSegments: ["walk in all day"],
  },
  analysis: {
    ...rewrite("DIRECT", "shoes").analysis,
    shopLanguageProductType: "Shoes",
    productType: "Shoes",
    productTypes: ["Shoes"],
    brands: [], models: [], requiredAttributes: [],
    optionalPreferences: ["Comfortable"], attributes: ["Comfortable"],
    audience: [], useCases: [], negativeTerms: [],
  },
} as QueryRewriteResult;
assert.deepEqual(
  buildDirectEmbeddingPlan(allDayShoes),
  {
    primary: "shoes",
    branches: ["shoes ; Comfortable", "shoes ; walk all day"],
  },
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
assert.equal(
  referenceIdentityContainmentMatch(["pleated skirt"], ["a black skirt"]),
  0.95,
);
assert.equal(
  referenceIdentityContainmentMatch(["trench coat"], ["navy coat"]),
  0.95,
);
assert.equal(
  referenceIdentityContainmentMatch(["cardigan"], ["navy coat"]),
  0,
);

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
  llmRetrievalMode: "DISCOVERY",
}), true);
assert.equal(shouldPromoteSourceNamedDirectTarget({
  originalQuery: "I need something that keeps my feet comfortable all day",
  sourceMustTerms: ["comfortable footwear", "all-day wear"],
  rawRoute: "LIGHT_LLM",
  groundedIdentityOrCategory: true,
  llmRetrievalMode: "DISCOVERY",
}), false);
assert.equal(shouldPromoteSourceNamedDirectTarget({
  originalQuery: "đồ gia dụng",
  sourceMustTerms: ["đồ gia dụng"],
  rawRoute: "FULL_LLM",
  groundedIdentityOrCategory: false,
  llmRetrievalMode: "DISCOVERY",
}), false);
assert.equal(shouldPromoteSourceNamedDirectTarget({
  originalQuery: "quần đen",
  sourceMustTerms: ["đen", "quần"],
  rawRoute: "FULL_LLM",
  groundedIdentityOrCategory: true,
  llmRetrievalMode: "DIRECT",
}), true);
assert.equal(shouldPromoteSourceNamedDirectTarget({
  originalQuery: "áo khoác nữ màu navy",
  sourceMustTerms: ["nữ", "màu navy", "áo khoác"],
  rawRoute: "LIGHT_LLM",
  groundedIdentityOrCategory: true,
  llmRetrievalMode: "DIRECT",
}), true);
assert.equal(shouldPromoteSourceNamedDirectTarget({
  originalQuery: "ví da đen nữ",
  sourceMustTerms: ["ví", "đen", "da"],
  rawRoute: "FULL_LLM",
  groundedIdentityOrCategory: true,
  llmRetrievalMode: "DISCOVERY",
}), true);
assert.equal(
  semanticTermsCoverConstraint(
    {
      value: "waterproof jacket",
      mode: "MUST",
      confidence: 1,
      source: "DICTIONARY",
    },
    ["waterproof", "jacket"],
  ),
  true,
);
assert.equal(
  semanticTermsCoverConstraint(
    {
      value: "camping tent",
      mode: "MUST",
      confidence: 1,
      source: "DICTIONARY",
    },
    ["camping"],
  ),
  false,
);
assert.equal(
  semanticTermsExplainedByIdentityOrFacets(
    {
      value: "waterproof jacket",
      mode: "MUST",
      confidence: 1,
      source: "DICTIONARY",
    },
    ["waterproof", "jacket"],
    [],
  ),
  true,
);
assert.equal(
  semanticTermsExplainedByIdentityOrFacets(
    {
      value: "wallet",
      mode: "MUST",
      confidence: 1,
      source: "DICTIONARY",
    },
    ["wallet", "black", "leather"],
    [
      { value: "Black", mode: "SHOULD", confidence: 1, source: "DICTIONARY" },
      { value: "Leather", mode: "SHOULD", confidence: 1, source: "DICTIONARY" },
    ],
  ),
  true,
);
assert.equal(
  semanticTermsExplainedByIdentityOrFacets(
    {
      value: "speaker",
      mode: "MUST",
      confidence: 1,
      source: "DICTIONARY",
    },
    ["smart", "speaker"],
    [],
  ),
  false,
);
assert.equal(
  semanticTermsExplainedByIdentityOrFacets(
    {
      value: "computer",
      mode: "MUST",
      confidence: 1,
      source: "DICTIONARY",
    },
    ["computer", "monitor"],
    [],
  ),
  false,
);
assert.equal(
  singleTokenSourceIdentityEvidence({
    sourceQuery: "mug",
    sourceMustTerms: ["mug"],
    catalogTerms: [
      { kind: "CANONICAL_PRODUCT_TYPE", value: "Double Wall Mug", score: 18.35 },
      { kind: "ALIAS", value: "insulated mug", score: 30.35 },
    ],
  }),
  true,
);
assert.equal(
  singleTokenSourceIdentityEvidence({
    sourceQuery: "smart speaker",
    sourceMustTerms: ["smart", "speaker"],
    catalogTerms: [
      { kind: "CANONICAL_PRODUCT_TYPE", value: "Bluetooth speaker", score: 30 },
    ],
  }),
  false,
);
assert.equal(
  singleTokenSourceIdentityEvidence({
    sourceQuery: "computer monitor",
    sourceMustTerms: ["computer", "monitor"],
    catalogTerms: [
      { kind: "CANONICAL_PRODUCT_TYPE", value: "wireless cycling computer", score: 30 },
    ],
  }),
  false,
);
assert.equal(shouldPromoteSourceNamedDirectTarget({
  originalQuery: "điện thoại iPhone 15 Pro Max",
  sourceMustTerms: ["iPhone 15 Pro Max"],
  rawRoute: "LIGHT_LLM",
  groundedIdentityOrCategory: true,
  llmRetrievalMode: "DIRECT",
}), false);

assert.deepEqual(normalizeIdentitySignalTokens("T-shirt"), ["t", "shirt"]);
assert.deepEqual(normalizeIdentitySignalTokens("shirt"), ["shirt"]);
assert.deepEqual(normalizeIdentitySignalTokens("V-neck T-shirt"), ["v", "neck", "t", "shirt"]);

assert.equal(
  discoveryContextProvesSemanticNeed(["mechanical", "repair"], ["mechanical keyboard"]),
  false,
);
assert.equal(
  discoveryContextProvesSemanticNeed(["camping"], ["camping"]),
  true,
);
assert.equal(
  discoveryContextProvesSemanticNeed(["warm", "weather"], ["warm weather"]),
  true,
);
assert.equal(
  discoveryContextProvesSemanticNeed(["indoor", "ambience"], ["indoor", "cat", "toilet tray"]),
  false,
);
assert.equal(
  discoveryContextProvesSemanticNeed(["home", "use"], ["espresso", "home"]),
  false,
);
assert.equal(
  discoveryContextProvesSemanticNeed(["orange", "wheels"], ["wheels", "baby"]),
  false,
);
assert.equal(
  discoveryContextProvesSemanticNeed(["rainy", "day", "outerwear"], ["rainy day"]),
  true,
);

assert.equal(catalogEvidenceNeedMatches("mechanical keyboard", "mechanic"), false);
assert.equal(catalogEvidenceNeedMatches("mechanical keyboard", "mechanical"), false);
assert.equal(catalogEvidenceNeedMatches("eyewear", "Eyewear"), true);
assert.equal(catalogEvidenceNeedMatches("portable phone charger", "phone charger"), true);
assert.equal(
  catalogEvidenceCoversSemanticMustTerms(
    ["waterproof", "jacket"],
    ["waterproof jacket"],
  ),
  true,
);
assert.equal(
  catalogEvidenceCoversSemanticMustTerms(
    ["powerful", "portable", "gaming"],
    ["Computer", "Portable"],
  ),
  false,
);

assert.equal(computeDiscoveryNoEvidenceThreshold({
  retrievalMode: "DIRECT",
  baseThreshold: 0.5,
  hasStrongCatalogEvidence: false,
  expansionGroundedCount: 0,
}), 0.60);
assert.equal(computeDiscoveryNoEvidenceThreshold({
  retrievalMode: "DISCOVERY",
  baseThreshold: 0.5,
  hasStrongCatalogEvidence: false,
  expansionGroundedCount: 0,
}), 0.55);
assert.equal(shouldForceCrossLanguageRewrite({
  query: "T-shirt màu đen",
  route: "VECTOR_SEMANTIC",
  unresolvedSegments: ["mau den"],
}), true);
assert.equal(
  shouldAnalyzeUnresolvedIdentityRemainder(["smart"]),
  true,
);
assert.equal(
  shouldAnalyzeUnresolvedIdentityRemainder(["monitor"]),
  true,
);
assert.equal(
  shouldAnalyzeUnresolvedIdentityRemainder(["only"]),
  false,
);
assert.equal(shouldForceCrossLanguageRewrite({
  query: "black t shirt",
  route: "VECTOR_SEMANTIC",
  unresolvedSegments: ["black"],
}), false);
assert.equal(shouldForceCrossLanguageRewrite({
  query: "áo khoác",
  route: "FULL_LLM",
  unresolvedSegments: ["ao khoac"],
}), false);

assert.equal(sourceProductTypeOwnsTarget({
  query: "I need to print invoices and shipping labels from my home office",
  start: 10,
  end: 11,
}), false);
assert.equal(sourceProductTypeOwnsTarget({
  query: "I need a camera for clearer video calls on my computer",
  start: 10,
  end: 11,
}), false);
assert.equal(sourceProductTypeOwnsTarget({
  query: "I want to make cafe style espresso at home",
  start: 8,
  end: 9,
}), false);
assert.equal(sourceProductTypeOwnsTarget({
  query: "I need to boil water quickly for tea without using a stove",
  start: 7,
  end: 8,
}), false);
assert.equal(sourceProductTypeOwnsTarget({
  query: "I need a powerful portable computer for modern PC games",
  start: 5,
  end: 6,
}), true);
assert.equal(sourceProductTypeOwnsTarget({
  query: "I need a waterproof jacket for hiking in winter",
  start: 4,
  end: 5,
}), true);

assert.equal(computeDiscoveryNoEvidenceThreshold({
  retrievalMode: "DISCOVERY",
  baseThreshold: 0.5,
  hasStrongCatalogEvidence: false,
  expansionGroundedCount: 4,
}), 0.46);
assert.equal(computeDiscoveryNoEvidenceThreshold({
  retrievalMode: "DISCOVERY",
  baseThreshold: 0.5,
  hasStrongCatalogEvidence: false,
  expansionGroundedCount: 8,
}), 0.45);
assert.equal(computeDiscoveryNoEvidenceThreshold({
  retrievalMode: "DIRECT",
  baseThreshold: 0.5,
  hasStrongCatalogEvidence: false,
  expansionGroundedCount: 12,
}), 0.60);

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
