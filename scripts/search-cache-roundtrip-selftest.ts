import assert from "node:assert/strict";
import { buildSearchCacheRequestVariant } from "../app/services/search/search-cache-request-variant.server";
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

const base = "https://example.myshopify.com/apps/ai-search";
const common = "q=waterproof+boots&filter.v.option.color=Navy";
const first = new URL(`${base}?${common}&shop=example.myshopify.com&timestamp=123&signature=abc&page=1`);
const second = new URL(`${base}?${common}&shop=example.myshopify.com&timestamp=456&signature=xyz&page=2`);
assert.equal(
  buildSearchCacheRequestVariant(first),
  buildSearchCacheRequestVariant(second),
  "app-proxy signed transport metadata must not fragment result cache",
);
const altered = new URL(`${base}?q=waterproof+boots&filter.v.option.color=Red&timestamp=456`);
assert.notEqual(
  buildSearchCacheRequestVariant(first),
  buildSearchCacheRequestVariant(altered),
  "real storefront filters must keep separate result-cache identities",
);

console.log("PASS: search cache roundtrip, Shopify transport keys and result-changing filters");
