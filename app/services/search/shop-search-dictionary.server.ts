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

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { expiresAt: number; value: ShopSearchDictionary }>();

function mapKind(kind: string): DictionaryField | null {
  if (["PRODUCT_TYPE", "CANONICAL_PRODUCT_TYPE"].includes(kind)) return "PRODUCT_TYPE";
  if (kind === "CATEGORY") return "CATEGORY";
  if (["VENDOR", "BRAND"].includes(kind)) return "BRAND";
  if (kind === "MODEL") return "MODEL";
  if (["SKU", "BARCODE", "IDENTIFIER"].includes(kind)) return "IDENTIFIER";
  if (["ATTRIBUTE", "TAG", "VARIANT"].includes(kind)) return "ATTRIBUTE";
  if (kind === "AUDIENCE") return "AUDIENCE";
  if (kind === "USE_CASE") return "CONTEXT";
  if (kind === "COMPATIBILITY") return "COMPATIBILITY";
  if (kind === "ALIAS") return "ALIAS";
  return null;
}

export async function getShopSearchDictionary(shop: string): Promise<ShopSearchDictionary> {
  const cached = cache.get(shop);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const rows = await db.aiSearchShopContextTerm.findMany({
    where: { shop },
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
  const merchantTypeByProduct = new Map<string, string>();
  for (const row of rows) {
    if (row.kind === "PRODUCT_TYPE" && row.value.trim()) {
      merchantTypeByProduct.set(row.productId, row.value.trim());
    }
  }
  let newestTimestamp = 0;
  for (const row of rows) {
    const field = mapKind(row.kind);
    if (!field) continue;
    const normalized = normalizeQueryText(row.normalizedValue || row.value);
    if (!normalized) continue;
    const canonical = row.kind === "CANONICAL_PRODUCT_TYPE"
      ? merchantTypeByProduct.get(row.productId) ?? row.value
      : row.value;
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
        source: ["PRODUCT_TYPE", "VENDOR", "SKU", "BARCODE"].includes(row.kind)
          ? "SHOPIFY"
          : "ENRICHMENT",
        confidence: row.kind === "ALIAS" ? 0.9 : 1,
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

export function invalidateShopSearchDictionary(shop: string) {
  cache.delete(shop);
}
