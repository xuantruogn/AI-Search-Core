import db from "../../db.server";
import { normalizeQueryText } from "./deterministic-query-parser.server";
import { createHash } from "node:crypto";

export type DictionaryField =
  | "PRODUCT_TYPE"
  | "CATEGORY"
  | "BRAND"
  | "MODEL"
  | "IDENTIFIER"
  | "ATTRIBUTE"
  | "MEASUREMENT"
  | "AUDIENCE"
  | "CONTEXT"
  | "COMPATIBILITY"
  | "ALIAS";

export type DictionaryEntry = {
  normalized: string;
  canonical: string;
  aliases: string[];
  field: DictionaryField;
  productCount: number;
  conceptId?: string;
  aliasLanguage?: string | null;
  source?: "SHOPIFY" | "ENRICHMENT";
  confidence?: number;
};

export type ShopSearchDictionary = {
  shop: string;
  entries: DictionaryEntry[];
  version: string;
  loadedAt: number;
};

const CACHE_TTL_MS = (() => {
  const value = Number.parseInt(
    process.env.AI_SEARCH_DICTIONARY_CACHE_TTL_MS || "",
    10,
  );
  return Number.isSafeInteger(value) && value >= 30_000
    ? Math.min(value, 60 * 60_000)
    : 5 * 60_000;
})();
const cache = new Map<string, { expiresAt: number; value: ShopSearchDictionary }>();
const pendingLoads = new Map<string, Promise<ShopSearchDictionary>>();

function mapKind(kind: string): DictionaryField | null {
  if (["PRODUCT_TYPE", "CANONICAL_PRODUCT_TYPE"].includes(kind)) return "PRODUCT_TYPE";
  if (kind === "CATEGORY") return "CATEGORY";
  if (["VENDOR", "BRAND"].includes(kind)) return "BRAND";
  if (kind === "MODEL") return "MODEL";
  if (["SKU", "BARCODE", "IDENTIFIER"].includes(kind)) return "IDENTIFIER";
  if (kind === "MEASUREMENT") return "MEASUREMENT";
  if (["ATTRIBUTE", "VARIANT", "VARIANT_OPTION", "TAG"].includes(kind)) {
    return "ATTRIBUTE";
  }
  if (["AUDIENCE", "INFERRED_AUDIENCE"].includes(kind)) return "AUDIENCE";
  if (["USE_CASE", "SOFT_CONTEXT"].includes(kind)) return "CONTEXT";
  if (kind === "COMPATIBILITY") return "COMPATIBILITY";
  if (kind === "ALIAS") return "PRODUCT_TYPE";
  return null;
}

function confidenceForKind(kind: string, normalized: string) {
  if (kind === "TAG") return 0.55;
  if (kind === "SOFT_CONTEXT" || kind === "INFERRED_AUDIENCE") return 0.72;
  if (kind === "ALIAS") return 0.9;
  if (kind === "VARIANT") return 0.78;
  if (kind === "VARIANT_OPTION") return /^\d+(?:[.,]\d+)?$/.test(normalized) ? 0.58 : 0.92;
  if (kind === "MEASUREMENT") return /^\d+(?:[.,]\d+)?$/.test(normalized) ? 0.62 : 0.95;
  if (kind === "PRODUCT_TYPE") return 0.86;
  return 1;
}

async function loadShopSearchDictionaryUncached(
  shop: string,
): Promise<ShopSearchDictionary> {
  const cached = cache.get(shop);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const rows = await db.aiSearchShopContextTerm.findMany({
    where: {
      shop,
      productRecord: {
        is: {
          searchable: true,
          hasVector: true,
        },
      },
    },
    select: {
      kind: true,
      value: true,
      normalizedValue: true,
      productId: true,
      createdAt: true,
    },
    take: 50_000,
  });

  const grouped = new Map<string, DictionaryEntry & { productIds: Set<string> }>();
  let newestTimestamp = 0;
  for (const row of rows) {
    const field = mapKind(row.kind);
    if (!field) continue;
    const normalized = normalizeQueryText(row.normalizedValue || row.value);
    if (!normalized) continue;
    // Keep the semantic canonical value intact. Shopify productType is a
    // separate merchant taxonomy signal and may be broad ("Womens", "Tools").
    const canonical = row.value;
    const canonicalNormalized = normalizeQueryText(canonical);
    const key = `${field}\u0000${normalized}\u0000${canonicalNormalized}`;
    const existing = grouped.get(key);
    if (existing) existing.productIds.add(row.productId);
    else {
      grouped.set(key, {
        normalized,
        canonical,
        aliases: [],
        field,
        productCount: 1,
        productIds: new Set([row.productId]),
        conceptId: createHash("sha256")
          .update(`${shop}\u0000${field}\u0000${canonicalNormalized}`, "utf8")
          .digest("hex")
          .slice(0, 24),
        aliasLanguage: null,
        source: ["PRODUCT_TYPE", "VENDOR", "SKU", "BARCODE", "TAG", "VARIANT", "VARIANT_OPTION"].includes(row.kind)
          ? "SHOPIFY"
          : "ENRICHMENT",
        confidence: confidenceForKind(row.kind, normalized),
      });
    }
    newestTimestamp = Math.max(newestTimestamp, row.createdAt.getTime());
  }

  const entries = [...grouped.values()].map(({ productIds, ...entry }) => ({
    ...entry,
    productCount: productIds.size,
  }));
  const value: ShopSearchDictionary = {
    shop,
    entries,
    version: `context-v1:${entries.length}:${newestTimestamp}`,
    loadedAt: Date.now(),
  };
  cache.set(shop, { expiresAt: Date.now() + CACHE_TTL_MS, value });
  return value;
}

export async function getShopSearchDictionary(
  shop: string,
): Promise<ShopSearchDictionary> {
  const cached = cache.get(shop);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const pending = pendingLoads.get(shop);
  if (pending) return pending;

  const task = loadShopSearchDictionaryUncached(shop);
  pendingLoads.set(shop, task);

  try {
    return await task;
  } finally {
    if (pendingLoads.get(shop) === task) {
      pendingLoads.delete(shop);
    }
  }
}

export function invalidateShopSearchDictionary(shop: string) {
  cache.delete(shop);
}
