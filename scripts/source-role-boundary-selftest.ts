import assert from "node:assert/strict";
import { sourceProductTypeOwnsTarget } from "../app/services/search/query-planner.server";
import { composeFacetEmbeddingInput, pureTargetDemandEmbedding, sourceOwnedSemanticDemandIdentities, sourceOwnedSemanticExactConstraints, isGenericDiscoveryFamily } from "../app/services/search/query-semantic-profile.server";
import { currentTargetColors, detectExplicitGender } from "../app/services/search/shop-context-index.server";
import { parseDeterministicQuery } from "../app/services/search/deterministic-query-parser.server";
import { applyFinalRelevanceCutoff } from "../app/services/search/final-relevance-cutoff.server";
assert.equal(sourceProductTypeOwnsTarget({ query: "something cool for travel", start: 1, end: 2 }), false);
assert.equal(sourceProductTypeOwnsTarget({ query: "a cooler for travel", start: 1, end: 2 }), true);
assert.deepEqual(sourceOwnedSemanticDemandIdentities({ originalQuery: "black adapter for Console 7", identities: ["adapter", "Console 7"], mandatoryConcepts: [{ target: "adapter", source: "adapter" }, { target: "Console 7", source: "Console 7" }] }), ["adapter"]);
assert.deepEqual(sourceOwnedSemanticDemandIdentities({ originalQuery: "chemise blanche", identities: ["white shirt"], exactConstraints: ["white"], mandatoryConcepts: [{ target: "shirt", source: "chemise" }, { target: "white", source: "blanche" }] }), ["shirt"]);
assert.equal(isGenericDiscoveryFamily("cold weather apparel"), true);
assert.equal(isGenericDiscoveryFamily("cold weather jacket"), false);
assert.deepEqual(sourceOwnedSemanticDemandIdentities({ originalQuery: "winter jacket", identities: ["winter jacket"], modifiers: ["winter"], mandatoryConcepts: [{ target: "winter jacket", source: "winter jacket" }] }), ["jacket"]);
assert.deepEqual(sourceOwnedSemanticDemandIdentities({ originalQuery: "snowboard boots", identities: ["snowboard boots"], modifiers: [], mandatoryConcepts: [{ target: "snowboard boots", source: "snowboard boots" }] }), ["snowboard boots"]);
assert.deepEqual(parseDeterministicQuery("adapter compatible with Console 7").compatibility.map(item => item.normalizedValue), ["console 7"]);
assert.deepEqual(parseDeterministicQuery("case compatible with Phone 12 Pro").compatibility.map(item => item.normalizedValue), ["phone 12 pro"]);
assert.deepEqual(parseDeterministicQuery("shoes size 42 under 50 dollars").compatibility.map(item => item.normalizedValue), []);
const complementPlan = { retrievalMode: "COMPLEMENT", referenceTerms: ["white sneakers"] } as any;
assert.deepEqual(sourceOwnedSemanticExactConstraints({ originalQuery: "something that matches white sneakers", exactConstraints: ["white"], mandatoryConcepts: [{ target: "white", source: "white" }], rawPlan: complementPlan }), []);
const candidates = [{ score: 0.8, sparseRank: 1, sparseScore: 10, retrievalSources: ["SPARSE" as const] }, { score: 0.7, vectorSimilarity: 0.5, primaryVectorSimilarity: 0.5, retrievalSources: ["SEMANTIC" as const] }];
assert.equal(applyFinalRelevanceCutoff({ results: candidates, retrievalMode: "DISCOVERY", semanticThreshold: 0.35 }).length, 1);
assert.equal(applyFinalRelevanceCutoff({ results: candidates, retrievalMode: "DIRECT", semanticThreshold: 0.35 }).length, 1);
console.log("PASS: source role, translated modifier, abstract lexical support and versioned relation boundaries");
const colorRewrite = { analysis: { sourceOwnedExactConstraints: ["brown"], negativeTerms: [], negativeAttributes: [], attributes: [], requiredAttributes: [], optionalPreferences: [], compatibility: [] }, planning: { retrievalMode: "DIRECT", resolvedSegments: [] } } as any;
assert.deepEqual(currentTargetColors("pantalon marron", colorRewrite, new Set(["brown"])), ["brown"]);
assert.deepEqual(currentTargetColors("pantalon marron", colorRewrite, new Set(["black"])), []);
assert.equal(detectExplicitGender("gift for a friend", { ...colorRewrite, analysis: { ...colorRewrite.analysis, productType: "women's scarf", audience: ["women"], shopLanguageTerms: ["women's perfume"] } }), null);
assert.equal(detectExplicitGender("chaussures pour femme", colorRewrite), "FEMALE");

const emptyDemand = {
  identity: [] as string[],
  desiredOutcomes: [] as string[],
  useCases: [] as string[],
  contexts: [] as string[],
  qualities: [] as string[],
  audience: [] as string[],
  styles: [] as string[],
  negativeConstraints: [] as string[],
  exactConstraints: [] as string[],
};
const translatedBikeDemand = { ...emptyDemand, identity: ["bicycle"] };
assert.equal(pureTargetDemandEmbedding({
  originalQuery: "Xe đạp",
  retrievalMode: "DIRECT",
  identities: ["bicycle"],
  concepts: [{ target: "bicycle", source: "Xe đạp" }],
  demand: translatedBikeDemand,
}), "bicycle");
const winterDemand = {
  ...emptyDemand,
  identity: ["clothing"],
  contexts: ["winter weather"],
};
const winterEmbedding = composeFacetEmbeddingInput(
  "Looking for clothing suitable for winter weather",
  { rawQuery: "quần áo mùa đông", retrievalMode: "DIRECT" } as any,
  {} as any,
  { fallbackReason: null, analysis: {
    sourceOwnedTargetIdentities: ["clothing"],
    semanticMandatoryConcepts: [],
    semanticDemand: winterDemand,
    intent: "Looking for clothing suitable for winter weather",
  }} as any,
);
assert.match(winterEmbedding, /winter weather/i);
assert.doesNotMatch(winterEmbedding, /quần áo|mùa đông/i);
const complementEmbedding = composeFacetEmbeddingInput(
  "Looking for a shirt to wear with a black skirt",
  { rawQuery: "áo mặc với váy đen", retrievalMode: "COMPLEMENT" } as any,
  {} as any,
  { fallbackReason: null, analysis: {
    sourceOwnedTargetIdentities: [],
    semanticMandatoryConcepts: [],
    semanticDemand: { ...emptyDemand, identity: ["shirt"] },
    intent: "Looking for a shirt to wear with a black skirt",
  }} as any,
);
assert.match(complementEmbedding, /black skirt/i);
assert.doesNotMatch(complementEmbedding, /áo mặc với|váy đen/i);
console.log("PASS: canonical shop-language dense input, pure translated family, complement relation");
