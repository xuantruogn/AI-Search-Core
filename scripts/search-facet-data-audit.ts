import db from "../app/db.server";
import {
  loadProductSemanticRows,
  loadShopSemanticRows,
} from "../app/services/search/product-semantic-profile.server";

const shop = process.env.AI_SEARCH_REGRESSION_SHOP || "dev-app-6fvh2isn.myshopify.com";
const patterns = ["cardigan", "dress", "jacket", "jeans", "charger", "tire", "crank"];

const allRows = await loadShopSemanticRows(shop);
const kindCounts = new Map<string, number>();
for (const row of allRows) {
  kindCounts.set(row.kind, (kindCounts.get(row.kind) ?? 0) + 1);
}
console.log(JSON.stringify({
  shop,
  contextKinds: [...kindCounts.entries()].map(([kind, count]) => ({ kind, count })),
}, null, 2));

for (const pattern of patterns) {
  const products = await db.aiSearchIndexedProduct.findMany({
    where: { shop, title: { contains: pattern }, hasVector: true },
    take: 8,
    select: {
      productId: true,
      handle: true,
      title: true,
      enrichmentVersion: true,
    },
  });
  const rows = await loadProductSemanticRows(
    shop,
    products.map((product) => product.productId),
  );
  const byProduct = new Map<string, typeof rows>();
  for (const row of rows) {
    const list = byProduct.get(row.productId) ?? [];
    list.push(row);
    byProduct.set(row.productId, list);
  }
  console.log(JSON.stringify({
    pattern,
    products: products.map((product) => {
      const terms = byProduct.get(product.productId) ?? [];
      return {
        handle: product.handle,
        title: product.title,
        enrichmentVersion: product.enrichmentVersion,
        facets: terms
          .filter((term) => term.kind !== "VARIANT_OPTION" && term.kind !== "IDENTIFIER")
          .slice(0, 18)
          .map((term) => `${term.kind}:${term.value}`),
        typedVariantOptions: terms
          .filter((term) => term.kind === "VARIANT_OPTION" && term.value.includes("="))
          .slice(0, 6)
          .map((term) => term.value),
      };
    }),
  }));
}
await db.$disconnect();
