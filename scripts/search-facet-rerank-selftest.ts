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
console.log(JSON.stringify({ ordinary, strict, excluded, vietnameseExcluded: vietnameseExcluded.map((item) => item.handle), exactTire: exactTire.map((item) => item.handle), exactEntity }));
await db.$disconnect();
