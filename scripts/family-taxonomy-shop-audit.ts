/**
 * Inspect actual indexed-family coverage in one shop without modifying data.
 *   npx tsx --env-file=.env scripts/family-taxonomy-shop-audit.ts dev-store.myshopify.com
 *
 * Catalog coverage is NOT the same as Shopify's total active products. Compare
 * counts with Online Store's active/published catalog and indexed eligibility.
 */
import db from "../app/db.server";
import {
  classifyFamilyProduct,
  classifyGenericFamilyProduct,
  classifySoldItemLeaf,
  shopifyCategoryLeaf,
} from "../app/services/search/product-family-taxonomy.server";
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
  unmappedTypedIdentity: 0,
  taxonomyTypeConflict: 0,
  dressOrSkirt: { dress: 0, skirt: 0, total: 0 },
  tops: 0,
  vehicles: 0,
  bicycles: 0,
  commonFamilies: {
    // Apparel / accessories
    pants: 0, shorts: 0, shoes: 0, sandals: 0,
    bags: 0, handbags: 0, backpacks: 0, wallets: 0,
    jewelry: 0, rings: 0, necklaces: 0, bracelets: 0, earrings: 0,
    watches: 0, hats: 0, eyewear: 0,
    // Electronics
    phones: 0, laptops: 0, tablets: 0, headphones: 0, speakers: 0,
    cameras: 0, printers: 0, "computer monitors": 0, keyboards: 0,
    // Home / furniture
    furniture: 0, beds: 0, mattresses: 0, chairs: 0, tables: 0,
    lighting: 0, "water bottles": 0, "coffee makers": 0,
    // Beauty
    cosmetics: 0, "skin care": 0, fragrances: 0, shampoo: 0,
    lipstick: 0, sunscreen: 0,
    // Pet / baby / toys / hardware / media
    "dog food": 0, "cat food": 0, "baby strollers": 0, diapers: 0,
    toys: 0, dolls: 0, helmets: 0, "hand tools": 0, "power tools": 0,
    books: 0,
  } as Record<string, number>,
};
const sampleMissing: string[] = [];
const sampleUnmapped: Array<{ productId: string; canonical: string; merchantType: string; shopifyCategory: string }> = [];
const sampleConflict: Array<{ productId: string; canonical: string; category: string }> = [];
const categoryPathCounts = new Map<string, number>();
const canonicalTypeCounts = new Map<string, number>();

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
  for (const path of evidence.shopifyCategoryPaths) {
    categoryPathCounts.set(path, (categoryPathCounts.get(path) ?? 0) + 1);
  }
  for (const type of evidence.canonicalTypes) {
    canonicalTypeCounts.set(type, (canonicalTypeCounts.get(type) ?? 0) + 1);
  }
  if (!evidence.canonicalTypes.length && !evidence.merchantTypes.length &&
      !evidence.shopifyCategoryPaths.length) {
    counters.missingAllTypedIdentity++;
    if (sampleMissing.length < 15) sampleMissing.push(productId);
  }
  const categoryLeaf = evidence.shopifyCategoryPaths.map(shopifyCategoryLeaf).find(Boolean);
  const canonicalLeaf = evidence.canonicalTypes.map(classifySoldItemLeaf).find(Boolean);
  const merchantLeaf = evidence.merchantTypes.map(classifySoldItemLeaf).find(Boolean);
  if (!categoryLeaf && !canonicalLeaf && !merchantLeaf) {
    counters.unmappedTypedIdentity++;
    if (sampleUnmapped.length < 15) sampleUnmapped.push({
      productId,
      canonical: evidence.canonicalTypes[0] ?? "",
      merchantType: evidence.merchantTypes[0] ?? "",
      shopifyCategory: evidence.shopifyCategoryPaths[0] ?? "",
    });
  }
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
  for (const family of Object.keys(counters.commonFamilies)) {
    if (classifyGenericFamilyProduct(evidence, family).match) {
      counters.commonFamilies[family] += 1;
    }
  }
});

const topEntries = (map: Map<string, number>, limit = 40) =>
  [...map.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([value, count]) => ({ value, count }));

console.log(JSON.stringify({
  shop,
  indexedRegistryCount: totals[0],
  searchableWithVectorCount: totals[1],
  indexedButNotEligible: totals[0] - totals[1],
  ...counters,
  topShopifyCategoryPaths: topEntries(categoryPathCounts),
  topCanonicalProductTypes: topEntries(canonicalTypeCounts),
  sampleMissing, sampleUnmapped, sampleConflict,
  reminder: "Compare family counts to Shopify active/published products; missing category/PSF coverage cannot be proven from embeddings.",
}, null, 2));
await db.$disconnect();
