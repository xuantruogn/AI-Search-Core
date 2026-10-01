import db from "../app/db.server";

const shop = process.env.AI_SEARCH_REGRESSION_SHOP || "dev-app-6fvh2isn.myshopify.com";
const patterns = ["cardigan", "dress", "jacket", "jeans", "charger", "tire", "crank"];
const counts = await db.aiSearchShopContextTerm.groupBy({
  by: ["kind"],
  where: { shop },
  _count: { _all: true },
});
console.log(JSON.stringify({ shop, contextKinds: counts }, null, 2));
for (const pattern of patterns) {
  const products = await db.aiSearchIndexedProduct.findMany({
    where: { shop, title: { contains: pattern }, hasVector: true },
    take: 8,
    select: {
      productId: true, handle: true, title: true, enrichmentVersion: true,
      contextTerms: {
        where: { kind: { in: ["ATTRIBUTE", "VARIANT_OPTION", "MEASUREMENT", "COMPATIBILITY", "BRAND", "MODEL", "IDENTIFIER"] } },
        select: { kind: true, value: true },
      },
    },
  });
  console.log(JSON.stringify({
    pattern,
    products: products.map((product) => ({
      handle: product.handle,
      title: product.title,
      enrichmentVersion: product.enrichmentVersion,
      facets: product.contextTerms
        .filter((term) => term.kind !== "VARIANT_OPTION" && term.kind !== "IDENTIFIER")
        .slice(0, 18)
        .map((term) => `${term.kind}:${term.value}`),
      typedVariantOptions: product.contextTerms
        .filter((term) => term.kind === "VARIANT_OPTION" && term.value.includes("="))
        .slice(0, 6)
        .map((term) => term.value),
    })),
  }));
}
await db.$disconnect();
