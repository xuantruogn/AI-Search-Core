import db from "../../db.server";

export type CatalogRevisionSnapshot = {
  catalogRevision: string;
  catalogUpdatedAt: Date | null;
  semanticRevision: string;
  semanticUpdatedAt: Date | null;
  productPolicyVersion: number;
  settingsUpdatedAt: Date;
  searchLanguage: string | null;
  shopifyShopId: string | null;
};

type CachedCatalogRevision = {
  expiresAt: number;
  value: CatalogRevisionSnapshot | null;
};

const REVISION_CACHE_TTL_MS = (() => {
  const value = Number.parseInt(
    process.env.AI_SEARCH_CATALOG_REVISION_CACHE_TTL_MS || "",
    10,
  );
  return Number.isSafeInteger(value) && value >= 250
    ? Math.min(value, 30_000)
    : 2_000;
})();

const revisionCache = new Map<string, CachedCatalogRevision>();
const pendingRevisionReads = new Map<string, Promise<CatalogRevisionSnapshot | null>>();

function normalizeShop(shop: string) {
  return shop.trim().toLowerCase();
}

function cacheRevision(
  shop: string,
  value: CatalogRevisionSnapshot | null,
) {
  revisionCache.set(shop, {
    expiresAt: Date.now() + REVISION_CACHE_TTL_MS,
    value,
  });
  while (revisionCache.size > 500) {
    const oldest = revisionCache.keys().next().value as string | undefined;
    if (!oldest) break;
    revisionCache.delete(oldest);
  }
}

export function invalidateSearchCatalogRevisionCache(shop: string) {
  const normalizedShop = normalizeShop(shop);
  revisionCache.delete(normalizedShop);
  // An in-flight SELECT may have started before the writer committed. Do not
  // let it repopulate the cache after invalidation or serve subsequent callers.
  pendingRevisionReads.delete(normalizedShop);
}

/**
 * Monotonic per-shop revision for anything that can change storefront search
 * results. Full-result cache keys read this scalar instead of scanning
 * AiSearchIndexedProduct for COUNT/MAX(updatedAt) on every search.
 */
async function bumpSearchRevision(
  shop: string,
  semanticChanged: boolean,
) {
  const normalizedShop = normalizeShop(shop);
  if (!normalizedShop) {
    throw new Error("SHOP_REQUIRED_FOR_CATALOG_REVISION");
  }

  const updated = semanticChanged
    ? await db.$executeRaw`
        UPDATE \`AiSearchShopSettings\`
        SET
          \`catalogRevision\` = \`catalogRevision\` + 1,
          \`catalogUpdatedAt\` = UTC_TIMESTAMP(3),
          \`semanticRevision\` = \`semanticRevision\` + 1,
          \`semanticUpdatedAt\` = UTC_TIMESTAMP(3),
          \`updatedAt\` = UTC_TIMESTAMP(3)
        WHERE \`shop\` = ${normalizedShop}
      `
    : await db.$executeRaw`
        UPDATE \`AiSearchShopSettings\`
        SET
          \`catalogRevision\` = \`catalogRevision\` + 1,
          \`catalogUpdatedAt\` = UTC_TIMESTAMP(3),
          \`updatedAt\` = UTC_TIMESTAMP(3)
        WHERE \`shop\` = ${normalizedShop}
      `;

  if (updated !== 1) {
    throw new Error(`SHOP_SETTINGS_MISSING_FOR_CATALOG_REVISION:${normalizedShop}`);
  }

  // The writer knows the revision changed but MySQL does not return the new
  // scalar from this UPDATE. Force the next local reader to refresh it.
  invalidateSearchCatalogRevisionCache(normalizedShop);
}

export function bumpSearchCatalogRevision(shop: string) {
  return bumpSearchRevision(shop, false);
}

/**
 * Semantic/profile/searchability changes also invalidate the ordinary catalog
 * result cache, so one atomic update advances both revisions.
 */
export function bumpSearchSemanticRevision(shop: string) {
  return bumpSearchRevision(shop, true);
}

async function readSearchCatalogRevision(
  normalizedShop: string,
): Promise<CatalogRevisionSnapshot | null> {
  const row = await db.aiSearchShopSettings.findUnique({
    where: { shop: normalizedShop },
    select: {
      catalogRevision: true,
      catalogUpdatedAt: true,
      semanticRevision: true,
      semanticUpdatedAt: true,
      productPolicyVersion: true,
      searchLanguage: true,
      updatedAt: true,
      shopRecord: {
        select: { shopifyShopId: true },
      },
    },
  });
  return row
    ? {
        catalogRevision: row.catalogRevision.toString(),
        catalogUpdatedAt: row.catalogUpdatedAt,
        semanticRevision: row.semanticRevision.toString(),
        semanticUpdatedAt: row.semanticUpdatedAt,
        productPolicyVersion: row.productPolicyVersion,
        settingsUpdatedAt: row.updatedAt,
        searchLanguage: row.searchLanguage?.trim() || null,
        shopifyShopId: row.shopRecord.shopifyShopId?.trim() || null,
      }
    : null;
}

export async function getSearchCatalogRevision(shop: string) {
  const normalizedShop = normalizeShop(shop);
  return normalizedShop
    ? readSearchCatalogRevision(normalizedShop)
    : null;
}

/**
 * Fast revision read for hot query-planning/context caches.
 *
 * Cross-process workers cannot share in-memory invalidation, so an infinite
 * local cache would eventually become stale. A tiny TTL gives near-immediate
 * cross-process coherence while avoiding one settings SELECT for every stage
 * of every search.
 */
export async function getSearchCatalogRevisionCached(shop: string) {
  const normalizedShop = normalizeShop(shop);
  if (!normalizedShop) return null;

  const cached = revisionCache.get(normalizedShop);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const pending = pendingRevisionReads.get(normalizedShop);
  if (pending) return pending;

  const task = readSearchCatalogRevision(normalizedShop);
  pendingRevisionReads.set(normalizedShop, task);
  try {
    const value = await task;
    if (pendingRevisionReads.get(normalizedShop) === task) {
      cacheRevision(normalizedShop, value);
    }
    return value;
  } finally {
    if (pendingRevisionReads.get(normalizedShop) === task) {
      pendingRevisionReads.delete(normalizedShop);
    }
  }
}
