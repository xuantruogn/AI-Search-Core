import assert from "node:assert/strict";
import db from "../app/db.server";
import { filterResultsByExplicitGender } from "../app/services/search/shop-context-index.server";
import type { QueryRewriteResult } from "../app/services/search/query-rewriter.server";

const shop = process.env.AI_SEARCH_REGRESSION_SHOP || "dev-app-6fvh2isn.myshopify.com";
const handles = ["unbalanced-cardigan-black", "gertrude-cardigan", "giacca-mohair-cardigan-blue"];
const products = await db.aiSearchIndexedProduct.findMany({
  where: { shop, handle: { in: handles } },
  select: { productId: true, handle: true, title: true },
});
assert.equal(products.length, handles.length, "real cardigan fixture unavailable");
const candidates = products.map((product) => ({ ...product, score: 0.6 }));
function rewrite(attribute: string, negativeTerms: string[] = [], sourceAttribute = attribute): QueryRewriteResult {
  return {
    query: "cardigan", rewritten: false, catalogRelevant: true, model: null, fallbackReason: null,
    planning: {
      route: "CODE_SEMANTIC", retrievalMode: "DIRECT", semanticQuery: "cardigan",
      semanticResolution: "CODE", semanticResolutionConfidence: 1,
      resolvedSegments: [{ field: "ATTRIBUTE", text: sourceAttribute, canonicalValue: attribute, confidence: 1 }],
      unresolvedSegments: [],
    },
    analysis: {
      retrievalMode: "DIRECT", productType: "cardigan", productTypes: ["cardigan"],
      attributes: [attribute], requiredAttributes: [], optionalPreferences: [attribute],
      useCases: [], negativeTerms, entities: [], shopLanguageTerms: [],
      brands: [], models: [], identifiers: [], compatibility: [], audience: [],
      semanticMustTerms: [], semanticSourceMustTerms: [], referenceTerms: [],
    },
  } as unknown as QueryRewriteResult;
}
async function run(query: string, negativeTerms: string[] = []) {
  const results = await filterResultsByExplicitGender({
    shop, originalQuery: query, rewrite: rewrite("black", negativeTerms), results: candidates,
  });
  return results.map((item) => ({ handle: item.handle, score: item.score }));
}
const ordinary = await run("black cardigan");
assert.equal(ordinary.length, 3, "ordinary color lost near-shade recall");
assert.equal(ordinary[0].handle, "unbalanced-cardigan-black", "exact color should lead at equal vector score");
const strict = await run("only black cardigan");
assert.deepEqual(strict.map((item) => item.handle), ["unbalanced-cardigan-black"]);
const excluded = await run("cardigan not black", ["black"]);
assert.ok(!excluded.some((item) => item.handle === "unbalanced-cardigan-black"));
assert.ok(excluded.length > 0);
const vietnameseExcluded = await filterResultsByExplicitGender({
  shop,
  originalQuery: "cardigan không đen",
  rewrite: rewrite("black", [], "đen"),
  results: candidates,
});
assert.ok(!vietnameseExcluded.some((item) => item.handle === "unbalanced-cardigan-black"));
const tireHandles = ["city-tire", "continental-gatorskin-tire"];
const tires = await db.aiSearchIndexedProduct.findMany({
  where: { shop, handle: { in: tireHandles } },
  select: { productId: true, handle: true, title: true },
});
assert.equal(tires.length, 2);
const exactTire = await filterResultsByExplicitGender({
  shop,
  originalQuery: "700x35C tire",
  rewrite: {
    ...rewrite("", []),
    analysis: { ...rewrite("", []).analysis, productType: "tire", productTypes: ["tire"] },
  },
  results: tires.map((item) => ({ ...item, score: 0.6 })),
});
assert.deepEqual(exactTire.map((item) => item.handle), ["city-tire"]);
const exactEntityCandidates = await db.aiSearchIndexedProduct.findMany({
  where: {
    shop,
    handle: {
      in: [
        "sram-s300-165mm-48t-black-crankset-and-bottom-bracket",
        "shimano-dura-ace-lockring",
      ],
    },
  },
  select: { productId: true, handle: true, title: true },
});
const entityBase = rewrite("");
const exactEntity = await filterResultsByExplicitGender({
  shop,
  originalQuery: "Shimano Dura-Ace crankset",
  rewrite: {
    ...entityBase,
    analysis: {
      ...entityBase.analysis,
      productType: "crankset",
      productTypes: ["crankset"],
      brands: ["Shimano"],
      models: ["Dura-Ace"],
    },
    planning: {
      ...entityBase.planning!,
      resolvedSegments: [
        { field: "BRAND", text: "Shimano", canonicalValue: "Shimano", confidence: 1 },
        { field: "MODEL", text: "Dura-Ace", canonicalValue: "Dura-Ace", confidence: 1 },
      ],
    },
  },
  results: exactEntityCandidates.map((item) => ({ ...item, score: 0.6 })),
});
assert.deepEqual(exactEntity, [], "exact brand/model must not degrade to a similar competitor");

const discoveryFixtures = await db.aiSearchIndexedProduct.findMany({
  where: {
    shop,
    handle: { in: ["comfortable-jogger-pants", "business-jacket"] },
  },
  select: { productId: true, handle: true, title: true },
});
assert.equal(discoveryFixtures.length, 2, "discovery context fixtures unavailable");
const business = discoveryFixtures.find((item) => item.handle === "business-jacket")!;
const jogger = discoveryFixtures.find((item) => item.handle === "comfortable-jogger-pants")!;
const discoveryBase = rewrite("");
const officeDiscovery = await filterResultsByExplicitGender({
  shop,
  originalQuery: "comfortable office apparel",
  rewrite: {
    ...discoveryBase,
    query: "comfortable office apparel",
    planning: {
      ...discoveryBase.planning!,
      route: "LIGHT_LLM",
      retrievalMode: "DISCOVERY",
      semanticQuery: "comfortable office apparel",
      resolvedSegments: [],
      unresolvedSegments: ["office"],
    },
    analysis: {
      ...discoveryBase.analysis,
      retrievalMode: "DISCOVERY",
      productType: "",
      productTypes: [],
      attributes: [],
      optionalPreferences: ["Comfortable"],
      semanticMustTerms: ["office", "comfortable"],
      semanticSourceMustTerms: ["office", "comfortable"],
    },
    context: {
      selectedTerms: [],
      loadMs: 0,
      filterMs: 0,
      totalMs: 0,
      cacheStatus: "HIT",
      dbReadMs: 0,
      aggregateCodeMs: 0,
      signalBuildCodeMs: 0,
      scoreCodeMs: 0,
      sortSelectCodeMs: 0,
      composeCodeMs: 0,
      discoverySourceGroundedProductIds: [business.productId],
      discoveryExpansionGroundedProductIds: [business.productId, jogger.productId],
    },
  },
  // Give the generic comfortable product a much higher vector score. Direct
  // shopper context must still lead in DISCOVERY without hard-filtering recall.
  results: [
    { ...jogger, score: 0.9 },
    { ...business, score: 0.5 },
  ],
});
assert.equal(
  officeDiscovery[0]?.handle,
  "business-jacket",
  "source-grounded discovery context must outrank expansion-only similarity",
);
assert.equal(officeDiscovery.length, 2, "discovery context tier must remain soft");

// DISCOVERY must rank fulfillment of the semantic need ahead of a generic
// source-overlap tier. A phone mount may mention "phone", but a power bank
// actually satisfies "portable charger".
const chargerFixtures = await db.aiSearchIndexedProduct.findMany({
  where: {
    shop,
    handle: { in: ["kodiak-mini-usb-power-bank", "quad-lock-iphone-mount"] },
  },
  select: { productId: true, handle: true, title: true },
});
assert.equal(chargerFixtures.length, 2, "charger discovery fixtures unavailable");
const powerBank = chargerFixtures.find((item) => item.handle === "kodiak-mini-usb-power-bank")!;
const phoneMount = chargerFixtures.find((item) => item.handle === "quad-lock-iphone-mount")!;
const chargerBase = rewrite("");
const chargerDiscovery = await filterResultsByExplicitGender({
  shop,
  originalQuery: "portable phone charger",
  rewrite: {
    ...chargerBase,
    query: "portable phone charger",
    planning: {
      ...chargerBase.planning!,
      route: "LIGHT_LLM",
      retrievalMode: "DISCOVERY",
      semanticQuery: "portable phone charger",
      resolvedSegments: [],
      unresolvedSegments: ["portable phone charger"],
    },
    analysis: {
      ...chargerBase.analysis,
      retrievalMode: "DISCOVERY",
      productType: "",
      productTypes: [],
      attributes: [],
      optionalPreferences: [],
      semanticMustTerms: ["portable charger"],
      semanticSourceMustTerms: ["portable charger"],
    },
    context: {
      selectedTerms: [],
      loadMs: 0, filterMs: 0, totalMs: 0, cacheStatus: "HIT",
      dbReadMs: 0, aggregateCodeMs: 0, signalBuildCodeMs: 0,
      scoreCodeMs: 0, sortSelectCodeMs: 0, composeCodeMs: 0,
      discoverySourceGroundedProductIds: [phoneMount.productId],
      discoveryExpansionGroundedProductIds: [powerBank.productId],
    },
  },
  results: [
    { ...phoneMount, score: 0.9 },
    { ...powerBank, score: 0.5 },
  ],
});
assert.equal(
  chargerDiscovery[0]?.handle,
  "kodiak-mini-usb-power-bank",
  "semantic need coverage must outrank generic source overlap in DISCOVERY",
);

// A versioned named entity is closed-world once the catalog proves the entity
// family exists. Never degrade iPhone 15 Pro Max into iPhone 18 accessories.
const iphoneFixtures = await db.aiSearchIndexedProduct.findMany({
  where: {
    shop,
    handle: {
      in: [
        "seashell-coastal-crustaceans-iphone-18-pro-case",
        "quad-lock-iphone-mount",
      ],
    },
  },
  select: { productId: true, handle: true, title: true },
});
assert.equal(iphoneFixtures.length, 2, "versioned entity fixtures unavailable");
const iphoneBase = rewrite("");
const exactVersionedEntity = await filterResultsByExplicitGender({
  shop,
  originalQuery: "iphone 15 pro max",
  rewrite: {
    ...iphoneBase,
    query: "iphone 15 pro max smartphone",
    planning: {
      ...iphoneBase.planning!,
      route: "LIGHT_LLM",
      retrievalMode: "DISCOVERY",
      semanticQuery: "iphone 15 pro max smartphone",
      resolvedSegments: [],
      unresolvedSegments: ["iphone 15 pro max"],
    },
    analysis: {
      ...iphoneBase.analysis,
      retrievalMode: "DISCOVERY",
      productType: "",
      productTypes: [],
      attributes: [],
      optionalPreferences: [],
      semanticMustTerms: ["iphone 15 pro max"],
      semanticSourceMustTerms: ["iphone 15 pro max"],
    },
    context: {
      selectedTerms: [
        { kind: "COMPATIBILITY", value: "iPhone 18 Pro", score: 40, productCount: 3 },
      ],
      loadMs: 0, filterMs: 0, totalMs: 0, cacheStatus: "HIT",
      dbReadMs: 0, aggregateCodeMs: 0, signalBuildCodeMs: 0,
      scoreCodeMs: 0, sortSelectCodeMs: 0, composeCodeMs: 0,
      discoverySourceGroundedProductIds: [],
      discoveryExpansionGroundedProductIds: [],
    },
  },
  results: iphoneFixtures.map((item) => ({ ...item, score: 0.8 })),
});
assert.deepEqual(
  exactVersionedEntity,
  [],
  "versioned entity must not degrade to another version in the same family",
);

// Accent folding in source text must not invent a gender constraint: Vietnamese
// "màn" is not English "man".
const accentGenderCollision = await filterResultsByExplicitGender({
  shop,
  originalQuery: "vải màn che mắt",
  rewrite: {
    ...discoveryBase,
    query: "veil fabric",
    planning: {
      ...discoveryBase.planning!,
      route: "FULL_LLM",
      retrievalMode: "DISCOVERY",
      semanticQuery: "veil fabric",
      resolvedSegments: [],
      unresolvedSegments: ["veil fabric"],
    },
    analysis: {
      ...discoveryBase.analysis,
      retrievalMode: "DISCOVERY",
      productType: "",
      productTypes: [],
      attributes: [],
      audience: [],
      semanticMustTerms: ["veil fabric"],
      semanticSourceMustTerms: ["vải màn che mắt"],
    },
  },
  results: candidates,
});
assert.equal(
  accentGenderCollision.length,
  candidates.length,
  "Vietnamese màn must not be interpreted as male/man",
);

console.log(JSON.stringify({
  ordinary,
  strict,
  excluded,
  vietnameseExcluded: vietnameseExcluded.map((item) => item.handle),
  exactTire: exactTire.map((item) => item.handle),
  exactEntity,
  officeDiscovery: officeDiscovery.map((item) => item.handle),
}));
await db.$disconnect();
