import assert from "node:assert/strict";
import { buildQdrantV9CollectionName } from "../app/services/search/qdrant.server";
import {
  isProductEmbeddingPipelineMigration,
} from "../app/services/products/product-indexer.server";

assert.equal(
  buildQdrantV9CollectionName("ai_search_products", 1536),
  "ai_search_products_v9_1536_bm25",
);
assert.equal(
  buildQdrantV9CollectionName("custom", 3072),
  "custom_v9_3072_bm25",
);
assert.throws(() => buildQdrantV9CollectionName("custom", 0));

assert.equal(
  isProductEmbeddingPipelineMigration({
    registryHasVector: true,
    registrySourceDocumentHash: "same-source",
    sourceDocumentHash: "same-source",
    registryDocumentHash: "old-pipeline-hash",
    currentDocumentHash: "new-pipeline-hash",
    previousDocumentHash: "old-pipeline-hash",
    knownLegacyHashes: [],
  }),
  true,
  "unchanged Shopify source must migrate without charging vector-update quota",
);
assert.equal(
  isProductEmbeddingPipelineMigration({
    registryHasVector: true,
    registrySourceDocumentHash: "old-source",
    sourceDocumentHash: "new-source",
    registryDocumentHash: "old-pipeline-hash",
    currentDocumentHash: "new-pipeline-hash",
    previousDocumentHash: "unrecognized",
    knownLegacyHashes: [],
  }),
  false,
  "real source changes are not pipeline-only migrations",
);
assert.equal(
  isProductEmbeddingPipelineMigration({
    registryHasVector: true,
    registrySourceDocumentHash: null,
    sourceDocumentHash: "same-source",
    registryDocumentHash: "legacy",
    currentDocumentHash: "new",
    previousDocumentHash: "legacy",
    knownLegacyHashes: ["legacy"],
  }),
  true,
  "pre-source-hash rows may migrate through a known historical hash",
);

console.log("PASS: v9 collection isolation and quota-safe pipeline migration");
