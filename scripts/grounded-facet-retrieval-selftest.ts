import assert from "node:assert/strict";
import db from "../app/db.server";
import { retrieveGroundedFacetCandidates } from "../app/services/search/structured-candidate-retrieval.server";

const originalQueryRaw = db.$queryRaw;
const originalFindMany = db.aiSearchProductSemanticProfile.findMany;
let registryCalls = 0;
const rewrite: any = {
  planning: { retrievalMode: "DIRECT", resolvedSegments: [
    { field: "ATTRIBUTE", canonicalValue: "waterproof", confidence: 1 },
    { field: "ATTRIBUTE", canonicalValue: "hood", confidence: 1 },
  ] },
  analysis: { negativeTerms: ["hood"] },
  context: { directSourceFacetConsensusProductIds: ["source", "generic", "component-only", "blocked"] },
};
(db as any).$queryRaw = async (sql: any) => {
  registryCalls++;
  assert.ok(sql.values.includes("fixture-shop"), "registry lookup must be tenant scoped");
  assert.ok(sql.sql.includes("`searchable` = true"));
  assert.ok(sql.sql.includes("`hasVector` = true"));
  // A retained but ineligible vector is deliberately absent from the registry result.
  return ["source", "generic", "component-only"].map(productId => ({ productId, handle: productId, title: productId }));
};
(db.aiSearchProductSemanticProfile as any).findMany = async () => ["source", "generic", "component-only", "blocked"].map(productId => ({
  productId, updatedAt: new Date(), profile: { schemaVersion: 2, analysisMeta: null,
    terms: productId === "generic" ? [] : [
      { kind: "ATTRIBUTE", value: productId === "component-only" ? "waterproof synthetic sole" : "waterproof",
        normalizedValue: productId === "component-only" ? "waterproof synthetic sole" : "waterproof" },
    ] },
}));
try {
  const results = await retrieveGroundedFacetCandidates({ shop: "fixture-shop", rewrite });
  assert.deepEqual(results.map(r => r.productId), ["source"]);
  assert.ok(!results.some(r => r.productId === "component-only"), "component property must not rescue a whole-product capability");
  assert.deepEqual(results[0].structuredMatchedTerms, [{ kind: "ATTRIBUTE", value: "waterproof" }]);
  assert.equal(results[0].vectorSimilarity, undefined, "structured evidence must not invent a cosine score");
  assert.deepEqual(await retrieveGroundedFacetCandidates({ shop: "fixture-shop", rewrite: {
    ...rewrite, planning: { ...rewrite.planning, retrievalMode: "DISCOVERY" },
  } }), []);
  assert.equal(registryCalls, 1, "non-direct queries must not open this recall lane");
  console.log("PASS: grounded facet recall verifies positive facts and searchable tenant registry");
} finally {
  (db as any).$queryRaw = originalQueryRaw;
  (db.aiSearchProductSemanticProfile as any).findMany = originalFindMany;
  await db.$disconnect();
}
