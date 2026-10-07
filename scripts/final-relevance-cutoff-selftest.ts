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
  "exact", "semantic-good", "hybrid", "sparse-top", "closed-world",
]);

const discovery = applyFinalRelevanceCutoff({
  retrievalMode: "DISCOVERY",
  semanticThreshold: 0.35,
  results: [
    { ...base("dense"), vectorSimilarity: 0.5, retrievalSources: ["SEMANTIC" as const] },
    { ...base("confirmed"), vectorSimilarity: 0.4, sparseScore: 1, sparseRank: 10, retrievalSources: ["SEMANTIC" as const, "SPARSE" as const] },
    { ...base("sparse-strong"), sparseScore: 10, sparseRank: 1, retrievalSources: ["SPARSE" as const] },
    { ...base("sparse-mid"), sparseScore: 6, sparseRank: 3, retrievalSources: ["SPARSE" as const] },
    { ...base("sparse-tail"), sparseScore: 9, sparseRank: 8, retrievalSources: ["SPARSE" as const] },
  ],
});
assert.deepEqual(discovery.map((r: any) => r.productId), [
  "dense", "confirmed", "sparse-strong",
]);

const discoveryDemandAware = applyFinalRelevanceCutoff({
  retrievalMode: "DISCOVERY",
  semanticThreshold: 0.35,
  results: [
    {
      ...base("joint-good"),
      vectorSimilarity: 0.39,
      semanticDemandCoverage: 0.7,
      semanticDemandSignalCount: 3,
      retrievalSources: ["SEMANTIC" as const, "SPARSE" as const],
    },
    {
      ...base("joint-weak"),
      vectorSimilarity: 0.39,
      semanticDemandCoverage: 0,
      semanticDemandSignalCount: 3,
      retrievalSources: ["SEMANTIC" as const, "SPARSE" as const],
    },
    {
      ...base("joint-weak-strong-dense"),
      vectorSimilarity: 0.47,
      semanticDemandCoverage: 0,
      semanticDemandSignalCount: 3,
      retrievalSources: ["SEMANTIC" as const, "SPARSE" as const],
    },
    {
      ...base("sparse-weak-demand"),
      sparseScore: 20,
      sparseRank: 1,
      semanticDemandCoverage: 0,
      semanticDemandSignalCount: 3,
      retrievalSources: ["SPARSE" as const],
    },
  ],
});
assert.deepEqual(
  discoveryDemandAware.map((r: any) => r.productId),
  ["joint-good", "joint-weak", "joint-weak-strong-dense", "sparse-weak-demand"],
  "PSF term coverage must not become a hidden hard filter for open-world Demand",
);

console.log("PASS: final relevance cutoff preserves authority/semantic evidence and removes weak sparse tail");
