import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  computeDiscoveryNoEvidenceThreshold,
  fuseSemanticVectorBranches,
  shouldRejectNoEvidenceVector,
  validTopVectorScore,
} from "../app/services/search/semantic-search.server";

assert.equal(validTopVectorScore([]), undefined);
assert.equal(validTopVectorScore([NaN, Infinity]), undefined);
assert.equal(validTopVectorScore([0.5, 0.7, NaN]), 0.7);
const top = validTopVectorScore([0.5, 0.6])!;
const minimum = 0.35;
const threshold = Math.max(minimum, top * 0.78);
assert.ok(Math.abs(threshold - 0.468) < 1e-12);
assert.ok(0.5 >= threshold, "valid secondary hit survives raw similarity threshold");
assert.ok(0.5 < (top + 0.2) * 0.78, "a ranking boost would wrongly reject the same hit");
const source = readFileSync(new URL("../app/services/search/semantic-search.server.ts", import.meta.url), "utf8");
assert.ok(source.indexOf("const rawTopVectorScore =") < source.indexOf("const evidenceCandidateIds ="));
assert.ok(source.includes("const topVectorScore = rawTopVectorScore;"));
assert.ok(source.includes("result.vectorSimilarity ?? result.score"));
const fused = fuseSemanticVectorBranches([
  [{ productId: "A", handle: "a", title: "A", score: 0.30, vectorSimilarity: 0.30 }],
  [
    { productId: "A", handle: "a", title: "A", score: 0.50, vectorSimilarity: 0.50 },
    { productId: "B", handle: "b", title: "B", score: 0.60, vectorSimilarity: 0.60 },
  ],
], 10);
const fusedA = fused.find((row) => row.productId === "A")!;
const fusedB = fused.find((row) => row.productId === "B")!;
assert.equal(fusedA.vectorSimilarity, 0.50);
assert.equal(fusedA.primaryVectorSimilarity, 0.30);
assert.equal(fusedB.vectorSimilarity, 0.60);
assert.equal(fusedB.primaryVectorSimilarity, undefined);
assert.ok(fusedA.score !== fusedA.vectorSimilarity, "fusion score must stay distinct from raw cosine");
assert.equal(shouldRejectNoEvidenceVector({ hasStrongCatalogEvidence: false, topVectorScore: 0.39,
  normalThreshold: 0.6, transientFallback: false, transientThreshold: 0.3 }), true);
assert.equal(shouldRejectNoEvidenceVector({ hasStrongCatalogEvidence: true, topVectorScore: 0.39,
  normalThreshold: 0.6, transientFallback: false, transientThreshold: 0.3 }), false);
assert.equal(shouldRejectNoEvidenceVector({ hasStrongCatalogEvidence: false, topVectorScore: 0.31,
  normalThreshold: 0.6, transientFallback: true, transientThreshold: 0.3 }), false);
assert.equal(computeDiscoveryNoEvidenceThreshold({
  retrievalMode: "DISCOVERY",
  baseThreshold: 0.5,
  hasStrongCatalogEvidence: false,
  expansionGroundedCount: 0,
}), 0.55);
assert.equal(computeDiscoveryNoEvidenceThreshold({
  retrievalMode: "DISCOVERY",
  baseThreshold: 0.5,
  hasStrongCatalogEvidence: false,
  expansionGroundedCount: 1,
}), 0.50);
console.log("PASS: raw registry-validated similarity threshold is independent of identity ranking boosts");
