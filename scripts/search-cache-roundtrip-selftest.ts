import assert from "node:assert/strict";
import {
  normalizeRankedProducts,
  parseProducts,
} from "../app/services/search/search-result-cache.server";

const rows = normalizeRankedProducts([
  {
    productId: "gid://shopify/Product/123",
    handle: "navy-jacket",
    score: 0.84,
    vectorSimilarity: 0.71,
    primaryVectorSimilarity: 0.68,
  },
  {
    productId: "gid://shopify/Product/123",
    handle: "duplicate",
    score: 0.1,
  },
]);
assert.equal(rows.length, 1, "ranked products must deduplicate by product ID");
const loaded = parseProducts(JSON.stringify(rows));
assert.deepEqual(loaded, rows, "persistent cache must retain vector provenance and rank");
const historical = parseProducts(
  JSON.stringify([{ productId: "old", handle: "old", score: 0.5 }]),
);
assert.equal(historical?.[0]?.vectorSimilarity, undefined, "old receipts still load");
assert.equal(
  parseProducts(JSON.stringify([{ productId: "bad", handle: "bad", score: "NaN" }])),
  null,
  "invalid cached scores must not reach storefront",
);
console.log("PASS: persistent result cache preserves rank, dedupe and vector similarity");
