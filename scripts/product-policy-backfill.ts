import db from "../app/db.server";
import { getShopEntitlement } from "../app/services/commerce/entitlement.server";
import { reconcileIndexedProductEligibility } from "../app/services/commerce/indexed-products.server";
import { withDistributedLease } from "../app/services/commerce/lease-lock.server";

const shops = await db.aiSearchShop.findMany({ select: { shop: true }, orderBy: { shop: "asc" } });
for (const row of shops) {
  const result = await withDistributedLease({
    shop: row.shop,
    resource: "product-policy:reconcile",
    task: async () => {
      const entitlement = await getShopEntitlement(row.shop);
      return reconcileIndexedProductEligibility({
        shop: row.shop,
        policyActive: entitlement.active,
        productLimit: entitlement.limits.productLimit,
      });
    },
  });
  console.log("[PRODUCT POLICY BACKFILL]", { shop: row.shop, ...result });
}
await db.$disconnect();
