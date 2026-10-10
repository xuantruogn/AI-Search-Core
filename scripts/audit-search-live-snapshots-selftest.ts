import assert from "node:assert/strict";
import { fetchSearchableProductSnapshotsByIds } from "../app/services/products/product-sync.server";
import { filterSearchResultsByPrice } from "../app/services/search/search-price-filter.server";

const makeNode = (id: string, amount = 10) => ({
  id, handle: id.split("/").at(-1)!, title: "Verified product",
  status: "ACTIVE", publishedAt: "2026-09-01T00:00:00Z",
  priceRangeV2: {
    minVariantPrice: { amount: String(amount), currencyCode: "USD" },
    maxVariantPrice: { amount: String(amount), currencyCode: "USD" },
  },
});

const calls: number[] = [];
const admin = {
  graphql: async (_query: string, options?: { variables?: Record<string, unknown> }) => {
    const ids = (options?.variables?.ids ?? []) as string[];
    calls.push(ids.length);
    return Response.json({ data: { nodes: ids.map((id) => makeNode(id)) } });
  },
};
const ids = Array.from({ length: 201 }, (_, i) => `gid://shopify/Product/${i + 1}`);
const snapshots = await fetchSearchableProductSnapshotsByIds(admin, ids);
assert.equal(snapshots.size, 201);
assert.deepEqual(calls, [100, 100, 1]);
assert.ok([...snapshots.values()].every((p) => p.currencyCode === "USD"));

// A sort-only request must never remove a valid product solely because its
// legacy price payload is missing and Shopify does not return a price snapshot.
const missingId = "gid://shopify/Product/999";
const priceAdmin = {
  graphql: async () => Response.json({ data: { nodes: [null] } }),
};
const candidates = [
  { productId: ids[0], handle: "expensive", title: "Expensive", score: 0.9, minVariantPrice: 30, maxVariantPrice: 30, currencyCode: "USD" },
  { productId: missingId, handle: "legacy", title: "Legacy", score: 0.8 },
  { productId: ids[1], handle: "cheap", title: "Cheap", score: 0.7, minVariantPrice: 10, maxVariantPrice: 10, currencyCode: "USD" },
] as unknown as Parameters<typeof filterSearchResultsByPrice>[0]["results"];
const sorted = await filterSearchResultsByPrice({
  admin: priceAdmin, shop: "example.myshopify.com", results: candidates,
  constraint: null, sortIntent: "PRICE_ASC",
});
assert.deepEqual(sorted.map((p) => p.productId), [ids[1], ids[0], missingId]);

console.log("PASS audit search: 201 Shopify IDs validated in 3 chunks; missing-price sort retains candidates");
