/**
 * Inspect actual indexed-family coverage in one shop without modifying data.
 *   npx tsx --env-file=.env scripts/family-taxonomy-shop-audit.ts dev-store.myshopify.com
 *
 * Catalog coverage is NOT the same as Shopify's total active products. Compare
 * counts with Online Store's active/published catalog and indexed eligibility.
 */
import db from "../app/db.server";
import { classifyFamilyProduct, classifySoldItemLeaf, shopifyCategoryLeaf } from "../app/services/search/product-family-taxonomy.server";
import { scanShopSemanticProfiles } from "../app/services/search/product-semantic-profile.server";

const shop = (process.argv[2] || "").trim().toLowerCase();
if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop)) {
  throw new Error("Usage: npx tsx --env-file=.env scripts/family-taxonomy-shop-audit.ts your-shop.myshopify.com");
}
const totals = await Promise.all([
  db.aiSearchIndexedProduct.count({ where: { shop } }),
  db.aiSearchIndexedProduct.count({ where: { shop, searchable: true, hasVector: true } }),
]);
const counters = {
  scanned: 0,
  standardCategory: 0,
  canonicalType: 0,
  missingAllTypedIdentity: 0,
  taxonomyTypeConflict: 0,
  dressOrSkirt: { dress: 0, skirt: 0, total: 0 },
  tops: 0,
  vehicles: 0,
  bicycles: 0,
};
const sampleMissing: string[] = [];
const sampleConflict: Array<{ productId: string; canonical: string; category: string }> = [];

await scanShopSemanticProfiles(shop, ({ productId, terms }) => {
  counters.scanned++;
  const values = (kind: string) => terms.filter((t) => t.kind === kind).map((t) => t.value);
  const evidence = {
    canonicalTypes: values("CANONICAL_PRODUCT_TYPE"),
    merchantTypes: values("PRODUCT_TYPE"),
    shopifyCategoryPaths: values("SHOPIFY_CATEGORY_PATH"),
  };
  if (evidence.shopifyCategoryPaths.length) counters.standardCategory++;
  if (evidence.canonicalTypes.length) counters.canonicalType++;
  if (!evidence.canonicalTypes.length && !evidence.merchantTypes.length &&
      !evidence.shopifyCategoryPaths.length) {
    counters.missingAllTypedIdentity++;
    if (sampleMissing.length < 15) sampleMissing.push(productId);
  }
  const categoryLeaf = evidence.shopifyCategoryPaths.map(shopifyCategoryLeaf).find(Boolean);
  const canonicalLeaf = evidence.canonicalTypes.map(classifySoldItemLeaf).find(Boolean);
  if (categoryLeaf && canonicalLeaf && categoryLeaf !== canonicalLeaf) {
    counters.taxonomyTypeConflict++;
    if (sampleConflict.length < 15) sampleConflict.push({
      productId, category: evidence.shopifyCategoryPaths[0],
      canonical: evidence.canonicalTypes[0],
    });
  }
  const apparel = classifyFamilyProduct(evidence, "dress_or_skirt");
  if (apparel.match) {
    counters.dressOrSkirt.total++;
    counters.dressOrSkirt[apparel.node === "skirt" ? "skirt" : "dress"]++;
  }
  if (classifyFamilyProduct(evidence, "tops").match) counters.tops++;
  if (classifyFamilyProduct(evidence, "vehicles").match) counters.vehicles++;
  if (classifyFamilyProduct(evidence, "bicycle").match) counters.bicycles++;
});

console.log(JSON.stringify({
  shop,
  indexedRegistryCount: totals[0],
  searchableWithVectorCount: totals[1],
  indexedButNotEligible: totals[0] - totals[1],
  ...counters,
  sampleMissing, sampleConflict,
  reminder: "Compare family counts to Shopify active/published products; missing category/PSF coverage cannot be proven from embeddings.",
}, null, 2));
await db.$disconnect();
