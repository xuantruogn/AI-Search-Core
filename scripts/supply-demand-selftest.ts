import assert from "node:assert/strict";
import { emptySemanticSupplyProfile, emptySemanticDemandProfile, parseSemanticSupplyProfile, parseSemanticDemandProfile, renderSemanticSupply, renderSemanticDemand } from "../app/services/search/semantic-contract.server";
import { parseProductLlmAnalysis, groundProductSemanticAnalysis, composeProductSemanticVectorDocument } from "../app/services/products/product-embedding-input.server";
import { parseRewrittenQuery } from "../app/services/search/query-rewriter.server";
import { collectProductContextTerms } from "../app/services/search/shop-context-index.server";
import { parseStoredSemanticProfile } from "../app/services/search/product-semantic-profile.server";

assert.equal(parseSemanticSupplyProfile({ identity: [] }), null);
assert.equal(parseSemanticDemandProfile({ ...emptySemanticDemandProfile(), contexts: [123] }), null);
const normalizedSummerDemand = parseSemanticDemandProfile({
  ...emptySemanticDemandProfile(),
  identity: ["clothing"],
  contexts: ["summer"],
  exactConstraints: ["summer", "size 42"],
})!;
assert.deepEqual(normalizedSummerDemand.exactConstraints, ["size 42"], "semantic meaning must not be duplicated as an exact constraint");
const supply = { ...emptySemanticSupplyProfile(), identity: ["audio headphones"], purposes: ["enable bicycle steering"], qualities: ["waterproof"], audience: ["children"], contexts: ["cycling"], semanticExplicit: ["waterproof"], semanticInferred: ["cycling"] };
const factProfile = {
  sourceLanguage: "en", canonicalProductType: "bicycle headset", shopLanguageProductType: "bicycle headset", category: "bicycle components",
  brandTerms: ["Invented"], modelTerms: [], identifiers: [], audiences: [], inferredAudiences: [], compatibility: ["any bicycle"],
  exactAttributes: ["waterproof", "sealed bearings"], measurements: [], explicitContexts: [], compatibleContexts: [], aliases: [],
  variantAttributes: [], sourceLanguageTerms: [], shopLanguageTerms: [], factualSummary: "Unsupported summary",
};
assert.equal(parseProductLlmAnalysis(JSON.stringify(factProfile)), null, "single response must include both sections");
const parsed = parseProductLlmAnalysis(JSON.stringify({ factProfile, semanticSupply: supply }))!;
assert.ok(parsed);
const grounded = groundProductSemanticAnalysis(parsed, "A bicycle headset with sealed bearings.");
assert.deepEqual(grounded.exactAttributes, ["sealed bearings"]);
assert.deepEqual(grounded.brandTerms, []);
assert.deepEqual(grounded.compatibility, []);
assert.deepEqual(grounded.semanticSupply?.identity, ["bicycle headset"]);
assert.deepEqual(grounded.semanticSupply?.audience, []);
assert.deepEqual(grounded.semanticSupply?.semanticExplicit, []);
assert.ok(grounded.semanticSupply?.semanticInferred.includes("waterproof"));
assert.ok(!grounded.semanticSupply?.qualities.includes("waterproof"), "unsupported factual-like quality must not enter dense axes");
const product = { id: "fixture", handle: "fixture", title: "Bicycle Headset", productType: "bicycle headset", description: "A bicycle headset with sealed bearings." };
const terms = collectProductContextTerms(product, grounded);
assert.ok(!terms.some(term => term.value === "waterproof" || term.value === "children"), "Supply inference cannot enter exact/dictionary evidence");
const text = composeProductSemanticVectorDocument({ product, analysis: grounded });
assert.ok(text.includes("bicycle headset") && text.includes("enable bicycle steering"), "soft purpose may support dense recall only");
assert.ok(!text.includes("waterproof"), "unsupported quality must not contaminate dense embedding");
assert.ok(!text.includes("audio headphones") && !text.includes("children"));
const restored = parseStoredSemanticProfile({ schemaVersion: 2, meta: { semanticSupply: grounded.semanticSupply! }, values: { ATTRIBUTE: ["sealed bearings"] } });
assert.deepEqual(restored.analysisMeta?.semanticSupply, grounded.semanticSupply);
assert.deepEqual(restored.terms.map(term => term.value), ["sealed bearings"]);

const demand = { ...emptySemanticDemandProfile(), identity: ["jacket"], desiredOutcomes: ["stay dry"], contexts: ["rainy weather"], qualities: ["waterproof", "hood"], negativeConstraints: ["hood"], exactConstraints: ["black", "under $100", "size 42"] };
const queryText = renderSemanticDemand(demand);
assert.ok(queryText.includes("stay dry") && queryText.includes("rainy weather") && queryText.includes("waterproof"));
assert.ok(!/hood|black|100|42|;/.test(queryText));
const summerDemand = { ...emptySemanticDemandProfile(), identity: ["clothing"], contexts: ["summer"], exactConstraints: ["summer"] };
assert.ok(renderSemanticDemand(summerDemand).includes("summer"), "semantic context must survive accidental exactConstraints overlap");
const response = { detectedLanguage: "en", retrievalMode: "DIRECT", referenceTerms: [], semanticQuery: "ignored ; facet dump", expansions: ["raincoat"], mustTerms: ["jacket"], sourceMustTerms: ["jacket"], mustNotTerms: ["hood"], semanticDemand: demand };
const rewrite = parseRewrittenQuery(JSON.stringify(response), "black jacket without hood under $100 size 42", "en", "COMPLEX")!;
assert.ok(rewrite);
assert.equal(rewrite.query, queryText);
assert.deepEqual(rewrite.analysis.semanticDemand, demand);
assert.deepEqual(rewrite.analysis.identifiers, []);
assert.ok(!rewrite.query.includes("raincoat"), "expansion class cannot replace source demand");
const discovery = { ...emptySemanticDemandProfile(), desiredOutcomes: ["stay dry"], useCases: ["commuting by bicycle"], contexts: ["rainy weather"] };
assert.ok(!/jacket|raincoat/.test(renderSemanticDemand(discovery)), "category-neutral discovery retains empty identity");
assert.ok(!/SKU|12 cm/.test(renderSemanticSupply({ ...emptySemanticSupplyProfile(), identity: ["bag"], qualities: ["SKU-123", "12 cm", "lightweight"] })));
console.log("PASS: Supply/Demand schema, provenance, PSF isolation, persistence and dense constraint separation");

