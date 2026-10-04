import assert from "node:assert/strict";
import db from "../app/db.server";
import { loadProductSemanticRows } from "../app/services/search/product-semantic-profile.server";

// Development-only: exercises the existing proxy; calls can consume search quota.
if (process.env.NODE_ENV === "production") throw new Error("Development test only");
const endpoint = process.env.AI_SEARCH_LIVE_TEST_URL;
if (!endpoint) throw new Error("Set AI_SEARCH_LIVE_TEST_URL to the running dev/proxy-e2e endpoint");
const queries = ["sunglasses", "kính râm", "women jacket", "men jacket", "jacket without hood", "jacket under 50 USD", "power bank", "clothing"];
const idsByQuery = new Map<string, string[]>();
let failures = 0;
try {
  for (const query of queries) {
    const start = Date.now();
    try {
      const url: URL = new URL(endpoint); url.searchParams.set("q", query);
      const response: Response = await fetch(url, { signal: AbortSignal.timeout(60000) });
      const body = await response.json() as any;
      assert.equal(response.status, 200);
      assert.equal(body.status, "success");
      const receipt = await db.aiSearchResultReceipt.findUnique({ where: { receiptId: body.render_receipt.id } });
      assert.ok(receipt);
      const ranked = JSON.parse(receipt.rankedProductsJson) as any[];
      const ids = ranked.map(p => /^\d+$/.test(String(p.productId)) ? `gid://shopify/Product/${p.productId}` : String(p.productId));
      idsByQuery.set(query, ids);
      const rows = await db.aiSearchIndexedProduct.findMany({ where: { shop: receipt.shop, productId: { in: ids } }, select: { productId: true, title: true, searchable: true, hasVector: true } });
      assert.equal(rows.length, ids.length);
      assert.ok(rows.every(p => p.searchable && p.hasVector));
      const facts = await loadProductSemanticRows(receipt.shop, ids);
      assert.ok(ids.length > 0, "positive query must return products");
      if (query === "kính râm") assert.deepEqual(ids, idsByQuery.get("sunglasses"), "translated identity must preserve exact result");
      if (query === "jacket without hood") {
        const hooded = facts.filter(f => f.kind === "ATTRIBUTE" && /\bhood(?:ed)?\b/i.test(f.value) && !/\b(?:no|without|non)[ -]?hood/i.test(f.value));
        assert.equal(hooded.length, 0, "explicitly hooded product must be excluded");
      }
      console.log(JSON.stringify({ query, pass: true, total: ids.length, ms: Date.now() - start,
        top: ids.slice(0, 5).map(id => rows.find(r => r.productId === id)?.title), filters: body.applied_filters }));
    } catch (error) { failures++; console.log(JSON.stringify({ query, pass: false, error: error instanceof Error ? error.message : String(error) })); }
  }
} finally { await db.$disconnect(); }
assert.equal(failures, 0, "live quality checks failed");
