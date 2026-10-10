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

// Shopify must distinguish an active price-less product from a deleted or
// unpublished product. Both produce no usable price, but only one is visible.
const missingId = "gid://shopify/Product/999";
const deletedId = "gid://shopify/Product/998";
const unpublishedId = "gid://shopify/Product/997";
const priceAdmin = {
  graphql: async (_query: string, options?: { variables?: Record<string, unknown> }) => {
    const requested = (options?.variables?.ids ?? []) as string[];
    return Response.json({ data: { nodes: requested.map((id) =>
      id === missingId ? { ...makeNode(id), priceRangeV2: null } :
      id === unpublishedId ? { ...makeNode(id), publishedAt: null } : null,
    ) } });
  },
};
const candidates = [
  { productId: ids[0], handle: "expensive", title: "Expensive", score: 0.9, minVariantPrice: 30, maxVariantPrice: 30, currencyCode: "USD" },
  { productId: missingId, handle: "legacy", title: "Legacy", score: 0.8 },
  { productId: deletedId, handle: "deleted", title: "Deleted", score: 0.79 },
  { productId: unpublishedId, handle: "unpublished", title: "Unpublished", score: 0.78 },
  { productId: ids[1], handle: "cheap", title: "Cheap", score: 0.7, minVariantPrice: 10, maxVariantPrice: 10, currencyCode: "USD" },
] as unknown as Parameters<typeof filterSearchResultsByPrice>[0]["results"];
const sorted = await filterSearchResultsByPrice({
  admin: priceAdmin, shop: "example.myshopify.com", results: candidates,
  constraint: null, sortIntent: "PRICE_ASC",
});
assert.deepEqual(sorted.map((p) => p.productId), [ids[1], ids[0], missingId]);
const visibleSnapshots = await fetchSearchableProductSnapshotsByIds(priceAdmin, [missingId, deletedId, unpublishedId]);
assert.equal(visibleSnapshots.size, 1);
assert.equal(visibleSnapshots.get(missingId)?.minVariantPrice, null);
await assert.rejects(
  fetchSearchableProductSnapshotsByIds({ graphql: async () => Response.json({ data: {} }) }, [missingId]),
  /incomplete nodes/,
);
console.log("PASS audit search: batched 201 Shopify IDs, published no-price retained, deleted/unpublished fail closed, malformed response rejected");
