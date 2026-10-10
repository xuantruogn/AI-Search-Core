import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import db from "../app/db.server";
import { reconcileIndexedProductEligibility } from "../app/services/commerce/indexed-products.server";

if (!process.env.DATABASE_URL?.includes("/ai_search_ci")) {
  throw new Error("Product policy integration test requires dedicated ai_search_ci database");
}
const shop = `audit-policy-${randomUUID()}.myshopify.com`;
const productId = "gid://shopify/Product/100";
await db.aiSearchShop.create({ data: { shop } });
try {
  await db.aiSearchShopSettings.create({ data: { shop } });
  await db.aiSearchIndexedProduct.create({
    data: { shop, productId, handle: "sample", title: "Sample product", searchable: true,
      hasVector: true, vectorStatus: "READY", status: "INDEXED" },
  });
  const original = await db.aiSearchIndexedProduct.findUniqueOrThrow({ where: { shop_productId: { shop, productId } } });
  const noop = await reconcileIndexedProductEligibility({ shop, policyActive: true, productLimit: 1 });
  assert.equal(noop.activeAfter, 1);
  assert.equal(noop.deactivate.length, 0);
  const unchanged = await db.aiSearchIndexedProduct.findUniqueOrThrow({ where: { shop_productId: { shop, productId } } });
  assert.equal(unchanged.updatedAt.getTime(), original.updatedAt.getTime(), "no-op must not rewrite updatedAt");
  const shrink = await reconcileIndexedProductEligibility({ shop, policyActive: true, productLimit: 0 });
  assert.deepEqual(shrink.deactivate, [productId]);
  const blocked = await db.aiSearchIndexedProduct.findUniqueOrThrow({ where: { shop_productId: { shop, productId } } });
  assert.equal(blocked.searchable, false);
  assert.equal(blocked.hasVector, true, "downgrade must retain paid embeddings");
  const restore = await reconcileIndexedProductEligibility({ shop, policyActive: true, productLimit: 1 });
  assert.deepEqual(restore.reactivateReady, [productId]);
  const recovered = await db.aiSearchIndexedProduct.findUniqueOrThrow({ where: { shop_productId: { shop, productId } } });
  assert.equal(recovered.searchable, true);
  assert.equal(recovered.hasVector, true);
  console.log("PASS product policy: no-op does not write; downgrade retains vector; restore reactivates");
} finally {
  await db.aiSearchShop.delete({ where: { shop } });
  await db.$disconnect();
}
