import assert from "node:assert/strict";
import { applyFinalRelevanceCutoff } from "../app/services/search/final-relevance-cutoff.server";

const base = (id: string, score = 0.5) => ({
  productId: id,
  score,
  retrievalSources: [] as Array<"SEMANTIC" | "SPARSE" | "LEXICAL" | "STRUCTURED">,
});

const direct = applyFinalRelevanceCutoff({
  retrievalMode: "DIRECT",
  semanticThreshold: 0.35,
  results: [
    { ...base("exact"), lexicalMatchType: "EXACT_TITLE" as const, retrievalSources: ["LEXICAL" as const] },
    { ...base("semantic-good"), vectorSimilarity: 0.42, retrievalSources: ["SEMANTIC" as const] },
    { ...base("semantic-weak"), vectorSimilarity: 0.31, retrievalSources: ["SEMANTIC" as const] },
    { ...base("hybrid"), vectorSimilarity: 0.37, sparseScore: 3, sparseRank: 7, retrievalSources: ["SEMANTIC" as const, "SPARSE" as const] },
    { ...base("sparse-top"), sparseScore: 10, sparseRank: 1, retrievalSources: ["SPARSE" as const] },
    { ...base("sparse-tail"), sparseScore: 2, sparseRank: 30, retrievalSources: ["SPARSE" as const] },
    { ...base("closed-world"), structuredAnchorKinds: ["IDENTIFIER"], retrievalSources: ["STRUCTURED" as const] },
  ],
});
assert.deepEqual(direct.map((r: any) => r.productId), [
  "exact", "semantic-good", "hybrid", "closed-world",
], "DIRECT BM25-only recall cannot become final truth without semantic/exact authority");

const discovery = applyFinalRelevanceCutoff({
  retrievalMode: "DISCOVERY",
  semanticThreshold: 0.35,
  results: [
    { ...base("dense"), vectorSimilarity: 0.5, primaryVectorSimilarity: 0.5, retrievalSources: ["SEMANTIC" as const] },
    { ...base("confirmed"), vectorSimilarity: 0.4, primaryVectorSimilarity: 0.4, sparseScore: 1, sparseRank: 10, retrievalSources: ["SEMANTIC" as const, "SPARSE" as const] },
    { ...base("sparse-strong"), sparseScore: 10, sparseRank: 1, retrievalSources: ["SPARSE" as const] },
    { ...base("sparse-mid"), sparseScore: 6, sparseRank: 3, retrievalSources: ["SPARSE" as const] },
    { ...base("sparse-tail"), sparseScore: 9, sparseRank: 8, retrievalSources: ["SPARSE" as const] },
  ],
});
assert.deepEqual(discovery.map((r: any) => r.productId), [
  "dense", "confirmed",
]);

const discoveryJointDemand = applyFinalRelevanceCutoff({
  retrievalMode: "DISCOVERY",
  semanticThreshold: 0.35,
  results: [
    {
      ...base("joint-primary"),
      vectorSimilarity: 0.42,
      primaryVectorSimilarity: 0.39,
      sparseScore: 5,
      sparseRank: 2,
      retrievalSources: ["SEMANTIC" as const, "SPARSE" as const],
    },
    {
      ...base("branch-only-hybrid"),
      vectorSimilarity: 0.48,
      sparseScore: 8,
      sparseRank: 1,
      retrievalSources: ["SEMANTIC" as const, "SPARSE" as const],
    },
    {
      ...base("weak-primary-hybrid"),
      vectorSimilarity: 0.47,
      primaryVectorSimilarity: 0.31,
      sparseScore: 7,
      sparseRank: 2,
      retrievalSources: ["SEMANTIC" as const, "SPARSE" as const],
    },
    {
      ...base("exact-authority"),
      structuredAnchorKinds: ["MEASUREMENT"],
      retrievalSources: ["STRUCTURED" as const],
    },
    {
      ...base("sparse-strong"),
      sparseScore: 20,
      sparseRank: 1,
      retrievalSources: ["SPARSE" as const],
    },
  ],
});
assert.deepEqual(
  discoveryJointDemand.map((r: any) => r.productId),
  ["joint-primary", "exact-authority"],
  "DISCOVERY sparse/branch agreement cannot replace full primary Supply↔Demand evidence",
);

const complementJointDemand = applyFinalRelevanceCutoff({
  retrievalMode: "COMPLEMENT",
  semanticThreshold: 0.35,
  results: [
    {
      ...base("relation-primary"),
      vectorSimilarity: 0.44,
      primaryVectorSimilarity: 0.4,
      sparseScore: 6,
      sparseRank: 1,
      retrievalSources: ["SEMANTIC" as const, "SPARSE" as const],
    },
    {
      ...base("relation-branch-only"),
      vectorSimilarity: 0.49,
      sparseScore: 9,
      sparseRank: 1,
      retrievalSources: ["SEMANTIC" as const, "SPARSE" as const],
    },
    {
      ...base("relation-weak-primary"),
      vectorSimilarity: 0.47,
      primaryVectorSimilarity: 0.31,
      structuredScore: 0.7,
      retrievalSources: ["SEMANTIC" as const, "STRUCTURED" as const],
    },
    {
      ...base("relation-exact"),
      structuredAnchorKinds: ["COMPATIBILITY"],
      retrievalSources: ["STRUCTURED" as const],
    },
  ],
});
assert.deepEqual(
  complementJointDemand.map((r: any) => r.productId),
  ["relation-primary", "relation-exact"],
  "COMPLEMENT requires primary relation/Demand evidence unless exact authority independently proves the result",
);

console.log("PASS: final relevance cutoff preserves authority/semantic evidence and removes weak sparse tail");
