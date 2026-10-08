/**
 * Read-only audit of indexed product-family coverage.
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/family-taxonomy-shop-audit.ts shop.myshopify.com
 *
 * Family counts overlap by design: a Shirt belongs to both tops and clothing.
 */
import db from "../app/db.server";
import {
  classifyFamilyProduct,
  classifySoldItemLeaf,
  shopifyCategoryLeaf,
  supportedFamilyGroups,
  type FamilyGroup,
} from "../app/services/search/product-family-taxonomy.server";
import { scanShopSemanticProfiles } from "../app/services/search/product-semantic-profile.server";

const shop = (process.argv[2] || "").trim().toLowerCase();
if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop)) {
  throw new Error(
    "Usage: npx tsx --env-file=.env scripts/family-taxonomy-shop-audit.ts your-shop.myshopify.com",
  );
}

const [indexedRegistryCount, searchableWithVectorCount] = await Promise.all([
  db.aiSearchIndexedProduct.count({ where: { shop } }),
  db.aiSearchIndexedProduct.count({
    where: { shop, searchable: true, hasVector: true },
  }),
]);

const groups = supportedFamilyGroups();
const familyCounts = Object.fromEntries(
  groups.map((group) => [group, 0]),
) as Record<FamilyGroup, number>;

let scanned = 0;
let standardCategory = 0;
let canonicalType = 0;
let missingAllTypedIdentity = 0;
let unmappedTypedIdentity = 0;
let taxonomyTypeConflict = 0;

const leafCounts: Record<string, number> = {};
const sampleMissing: string[] = [];
const sampleUnmapped: Array<{
  productId: string;
  canonical: string;
  merchantType: string;
  shopifyCategory: string;
}> = [];
const sampleConflict: Array<{
  productId: string;
  canonical: string;
  category: string;
}> = [];

await scanShopSemanticProfiles(shop, ({ productId, terms }) => {
  scanned += 1;
  const values = (kind: string) =>
    terms.filter((term) => term.kind === kind).map((term) => term.value);
  const evidence = {
    canonicalTypes: values("CANONICAL_PRODUCT_TYPE"),
    merchantTypes: values("PRODUCT_TYPE"),
    shopifyCategoryPaths: values("SHOPIFY_CATEGORY_PATH"),
  };

  if (evidence.shopifyCategoryPaths.length) standardCategory += 1;
  if (evidence.canonicalTypes.length) canonicalType += 1;

  if (
    !evidence.canonicalTypes.length &&
    !evidence.merchantTypes.length &&
    !evidence.shopifyCategoryPaths.length
  ) {
    missingAllTypedIdentity += 1;
    if (sampleMissing.length < 20) sampleMissing.push(productId);
  }

  const categoryLeaf = evidence.shopifyCategoryPaths
    .map(shopifyCategoryLeaf).find(Boolean) ?? null;
  const canonicalLeaf = evidence.canonicalTypes
    .map(classifySoldItemLeaf).find(Boolean) ?? null;
  const merchantLeaf = evidence.merchantTypes
    .map(classifySoldItemLeaf).find(Boolean) ?? null;
  const bestLeaf = categoryLeaf ?? canonicalLeaf ?? merchantLeaf;
  if (bestLeaf) leafCounts[bestLeaf] = (leafCounts[bestLeaf] ?? 0) + 1;

  let mappedToAnyFamily = false;
  for (const group of groups) {
    if (classifyFamilyProduct(evidence, group).match) {
      familyCounts[group] += 1;
      mappedToAnyFamily = true;
    }
  }

  if (!mappedToAnyFamily) {
    unmappedTypedIdentity += 1;
    if (sampleUnmapped.length < 20) {
      sampleUnmapped.push({
        productId,
        canonical: evidence.canonicalTypes[0] ?? "",
        merchantType: evidence.merchantTypes[0] ?? "",
        shopifyCategory: evidence.shopifyCategoryPaths[0] ?? "",
      });
    }
  }

  if (categoryLeaf && canonicalLeaf && categoryLeaf !== canonicalLeaf) {
    taxonomyTypeConflict += 1;
    if (sampleConflict.length < 20) {
      sampleConflict.push({
        productId,
        canonical: evidence.canonicalTypes[0] ?? "",
        category: evidence.shopifyCategoryPaths[0] ?? "",
      });
    }
  }
});

console.log(JSON.stringify({
  shop,
  indexedRegistryCount,
  searchableWithVectorCount,
  indexedButNotEligible: indexedRegistryCount - searchableWithVectorCount,
  scanned,
  standardCategory,
  canonicalType,
  missingAllTypedIdentity,
  unmappedTypedIdentity,
  taxonomyTypeConflict,
  familyCounts,
  leafCounts: Object.fromEntries(
    Object.entries(leafCounts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
  ),
  sampleMissing,
  sampleUnmapped,
  sampleConflict,
  reminder:
    "Compare familyCounts with Shopify active/published catalog. Embedding similarity is not family proof; missing/unmapped taxonomy must be fixed or mapped.",
}, null, 2));

await db.$disconnect();
