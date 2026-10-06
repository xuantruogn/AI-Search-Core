import assert from "node:assert/strict";

import {
  sourceOwnedSemanticDemandIdentities,
  QUERY_EMBEDDING_PIPELINE_VERSION,
  QUERY_SEMANTIC_PROFILE_VERSION,
} from "../app/services/search/query-semantic-profile.server";
import { parseRewrittenQuery } from "../app/services/search/query-rewriter.server";
import {
  currentSearchPipelineSignature,
} from "../app/services/search/search-result-cache.server";
import {
  SEMANTIC_CONTRACT_VERSION,
} from "../app/services/search/semantic-contract.server";

assert.deepEqual(
  sourceOwnedSemanticDemandIdentities({
    originalQuery: "tôi muốn xe đạp để đi cuối tuần",
    identities: ["bicycle"],
    mandatoryConcepts: [{ target: "bicycle", source: "xe đạp" }],
  }),
  ["bicycle"],
  "translated shopper-owned identity must survive the legacy adapter",
);

assert.deepEqual(
  sourceOwnedSemanticDemandIdentities({
    originalQuery: "quà tặng giáng sinh",
    identities: ["gift box"],
    mandatoryConcepts: [{ target: "Christmas celebration", source: "giáng sinh" }],
  }),
  [],
  "LLM-expanded product identity must not become shopper-owned identity",
);

assert.deepEqual(
  sourceOwnedSemanticDemandIdentities({
    originalQuery: "bicycle accessories",
    identities: ["bicycle"],
    mandatoryConcepts: [{ target: "accessories", source: "bicycle accessories" }],
  }),
  [],
  "reference/family words must not be promoted when canonical MUST meaning disagrees",
);

const parsedRewrite = parseRewrittenQuery(
  JSON.stringify({
    semanticDemand: {
      identity: ["bicycle"],
      desiredOutcomes: ["weekend riding"],
      useCases: [],
      contexts: [],
      qualities: [],
      audience: [],
      styles: [],
      negativeConstraints: [],
      exactConstraints: [],
    },
    detectedLanguage: "vi",
    retrievalMode: "DIRECT",
    referenceTerms: [],
    semanticQuery: "Looking for bicycle. The goal is weekend riding.",
    expansions: ["bike"],
    mandatoryConcepts: [
      { target: "bicycle", source: "xe đạp" },
      { target: "weekend riding", source: "đi cuối tuần" },
    ],
    mustNotTerms: [],
  }),
  "tôi muốn xe đạp để đi cuối tuần",
  "en",
  "COMPLEX",
);
assert.ok(parsedRewrite, "aligned mandatory-concept rewrite must parse");
assert.deepEqual(
  parsedRewrite?.analysis.semanticMandatoryConcepts,
  [
    { target: "bicycle", source: "xe đạp" },
    { target: "weekend riding", source: "đi cuối tuần" },
  ],
);
assert.deepEqual(parsedRewrite?.analysis.semanticMustTerms, [
  "bicycle",
  "weekend riding",
]);
assert.deepEqual(parsedRewrite?.analysis.semanticSourceMustTerms, [
  "xe đạp",
  "đi cuối tuần",
]);

const signature = currentSearchPipelineSignature();
assert.ok(signature.includes("qdrant:"), "cache signature must include resolved collection");
assert.ok(signature.includes("dense:1536"), "cache signature must include embedding dimension");
assert.ok(signature.includes("qdrant/bm25"), "cache signature must include BM25 contract");
assert.ok(signature.includes(QUERY_SEMANTIC_PROFILE_VERSION));
assert.ok(signature.includes(QUERY_EMBEDDING_PIPELINE_VERSION));
assert.ok(signature.includes(SEMANTIC_CONTRACT_VERSION));
assert.ok(signature.includes("semantic-product-v9-supply-demand-dense-bm25"));

console.log("PASS: source-owned identity and cache schema responsibility boundaries");
