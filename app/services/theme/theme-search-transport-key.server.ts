import { createHash } from "node:crypto";

import {
  loadProductSemanticRows,
  loadShopSemanticRows,
  removeProductSemanticProfileFromCache,
  type StoredSemanticTerm,
} from "../search/product-semantic-profile.server";
import { getSearchCatalogRevisionCached } from "../search/search-catalog-revision.server";

import {
  buildThemeSearchTransportBatches,
  type PlannerOptions,
  type ThemeSearchTransportBatch,
  type ThemeSearchTransportResolvedTarget,
} from "./theme-search-transport.server";

// ============================================================
// TYPES
// ============================================================

export type ThemeSearchTransportKeyKind =
  | "VARIANT_SKU"
  | "VARIANT_BARCODE"
  | "TITLE_VENDOR_PRODUCT_TYPE"
  | "TITLE_VENDOR_PRODUCT_TYPE_TAG"
  | "TITLE_VENDOR"
  | "TITLE_PRODUCT_TYPE"
  | "TITLE_ONLY";

export interface ThemeSearchTransportProductInput {
  productId: string;
  handle?: string | null;
  title: string;

  vendor?: string | null;
  productType?: string | null;

  tags?: readonly string[] | null;

  variants?: readonly {
    sku?: string | null;
    barcode?: string | null;
  }[] | null;

  // Cho phép caller đã flatten dữ liệu từ Shopify.
  skus?: readonly string[] | null;
  barcodes?: readonly string[] | null;
}

export interface ThemeSearchTransportKeyCandidate {
  productId: string;
  kind: ThemeSearchTransportKeyKind;
  signature: string;
  clause: string;
}

export interface ResolvedThemeSearchTransportKey {
  productId: string;
  kind: ThemeSearchTransportKeyKind;
  signature: string;
  clause: string;
}

export interface UnresolvedThemeSearchTransportKey {
  productId: string;
  reason:
    | "NO_TRANSPORT_KEYS"
    | "NO_UNIQUE_TRANSPORT_KEY";
}

export interface ResolveThemeSearchTransportKeysResult {
  resolved: ResolvedThemeSearchTransportKey[];
  unresolved: UnresolvedThemeSearchTransportKey[];
}

export interface ThemeSearchTransportKeyPlanUnresolvedTarget {
  productId: string;
  reason:
    | "NO_TRANSPORT_KEYS"
    | "NO_UNIQUE_TRANSPORT_KEY"
    | "CLAUSE_TOO_LONG";
}

export interface ThemeSearchTransportKeyPlanResult {
  safeToRender: boolean;

  /**
   * AI order sau normalize + loại duplicate.
   */
  targetProductIds: string[];

  /**
   * Chỉ chứa target có key unique và không vượt guard URL.
   */
  resolved: ResolvedThemeSearchTransportKey[];

  unresolved: ThemeSearchTransportKeyPlanUnresolvedTarget[];

  /**
   * Các batch query dùng trực tiếp cho Shopify /search + Section Rendering API.
   */
  batches: ThemeSearchTransportBatch[];
}

// ============================================================
// PRIORITY
// ============================================================

const TRANSPORT_KEY_PRIORITY: Record<
  ThemeSearchTransportKeyKind,
  number
> = {
  VARIANT_SKU: 10,
  VARIANT_BARCODE: 20,
  TITLE_VENDOR_PRODUCT_TYPE: 30,
  TITLE_VENDOR_PRODUCT_TYPE_TAG: 40,
  TITLE_VENDOR: 50,
  TITLE_PRODUCT_TYPE: 60,
  TITLE_ONLY: 70,
};

// ============================================================
// NORMALIZATION
// ============================================================

function normalizeShop(shop: string): string {
  return shop.trim().toLowerCase();
}

function normalizeProductId(productId: string): string {
  return productId.trim();
}

function cleanText(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const cleaned = value
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim();

  return cleaned.length > 0 ? cleaned : null;
}

function normalizeSignatureValue(
  value: string | null | undefined,
): string | null {
  const cleaned = cleanText(value);

  return cleaned ? cleaned.toLocaleLowerCase() : null;
}

function uniqueStrings(values: readonly (string | null | undefined)[]) {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    const cleaned = cleanText(value);

    if (!cleaned) {
      continue;
    }

    const normalized = cleaned.toLocaleLowerCase();

    if (seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    result.push(cleaned);
  }

  return result;
}

// ============================================================
// SHOPIFY QUERY BUILDING
// ============================================================

function escapeShopifySearchValue(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
}

function quoted(value: string): string {
  return `"${escapeShopifySearchValue(value)}"`;
}

function fieldClause(field: string, value: string): string {
  return `${field}:${quoted(value)}`;
}

function andClauses(clauses: string[]): string {
  return `(${clauses.join(" AND ")})`;
}

// ============================================================
// SIGNATURE
// ============================================================

function createSignature(
  kind: ThemeSearchTransportKeyKind,
  values: readonly string[],
): string {
  const normalizedValues = values.map((value) =>
    normalizeSignatureValue(value),
  );

  const payload = JSON.stringify([
    kind,
    ...normalizedValues,
  ]);

  return createHash("sha256")
    .update(payload)
    .digest("hex");
}

// ============================================================
// BUILD CANDIDATES
// ============================================================

function candidate(
  productId: string,
  kind: ThemeSearchTransportKeyKind,
  signatureValues: string[],
  clause: string,
): ThemeSearchTransportKeyCandidate {
  return {
    productId,
    kind,
    signature: createSignature(
      kind,
      signatureValues,
    ),
    clause,
  };
}

export function buildThemeSearchTransportKeyCandidates(
  product: ThemeSearchTransportProductInput,
): ThemeSearchTransportKeyCandidate[] {
  const productId = normalizeProductId(
    product.productId,
  );

  if (!productId) {
    throw new Error(
      "THEME_SEARCH_TRANSPORT_PRODUCT_ID_REQUIRED",
    );
  }

  const title = cleanText(product.title);

  if (!title) {
    return [];
  }

  const vendor = cleanText(product.vendor);
  const productType = cleanText(
    product.productType,
  );

  const tags = uniqueStrings(product.tags ?? []);

  const variantSkus = uniqueStrings([
    ...(product.skus ?? []),
    ...(product.variants ?? []).map(
      (variant) => variant.sku,
    ),
  ]);

  const variantBarcodes = uniqueStrings([
    ...(product.barcodes ?? []),
    ...(product.variants ?? []).map(
      (variant) => variant.barcode,
    ),
  ]);

  const candidates: ThemeSearchTransportKeyCandidate[] =
    [];

  // ----------------------------------------------------------
  // 1. SKU
  // ----------------------------------------------------------

  for (const sku of variantSkus) {
    candidates.push(
      candidate(
        productId,
        "VARIANT_SKU",
        [sku],
        fieldClause("variants.sku", sku),
      ),
    );
  }

  // ----------------------------------------------------------
  // 2. BARCODE
  // ----------------------------------------------------------

  for (const barcode of variantBarcodes) {
    candidates.push(
      candidate(
        productId,
        "VARIANT_BARCODE",
        [barcode],
        fieldClause(
          "variants.barcode",
          barcode,
        ),
      ),
    );
  }

  // ----------------------------------------------------------
  // 3. TITLE + VENDOR + PRODUCT TYPE
  // ----------------------------------------------------------

  if (vendor && productType) {
    candidates.push(
      candidate(
        productId,
        "TITLE_VENDOR_PRODUCT_TYPE",
        [
          title,
          vendor,
          productType,
        ],
        andClauses([
          fieldClause("title", title),
          fieldClause("vendor", vendor),
          fieldClause(
            "product_type",
            productType,
          ),
        ]),
      ),
    );
  }

  // ----------------------------------------------------------
  // 4. TITLE + VENDOR + PRODUCT TYPE + TAG
  //
  // Nếu 2 sản phẩm cùng title/vendor/type thì tag có thể giúp
  // phân biệt thêm.
  // ----------------------------------------------------------

  if (
    vendor &&
    productType &&
    tags.length > 0
  ) {
    for (const tag of tags) {
      candidates.push(
        candidate(
          productId,
          "TITLE_VENDOR_PRODUCT_TYPE_TAG",
          [
            title,
            vendor,
            productType,
            tag,
          ],
          andClauses([
            fieldClause("title", title),
            fieldClause("vendor", vendor),
            fieldClause(
              "product_type",
              productType,
            ),
            fieldClause("tag", tag),
          ]),
        ),
      );
    }
  }

  // ----------------------------------------------------------
  // 5. TITLE + VENDOR
  // ----------------------------------------------------------

  if (vendor) {
    candidates.push(
      candidate(
        productId,
        "TITLE_VENDOR",
        [title, vendor],
        andClauses([
          fieldClause("title", title),
          fieldClause("vendor", vendor),
        ]),
      ),
    );
  }

  // ----------------------------------------------------------
  // 6. TITLE + PRODUCT TYPE
  // ----------------------------------------------------------

  if (productType) {
    candidates.push(
      candidate(
        productId,
        "TITLE_PRODUCT_TYPE",
        [
          title,
          productType,
        ],
        andClauses([
          fieldClause("title", title),
          fieldClause(
            "product_type",
            productType,
          ),
        ]),
      ),
    );
  }

  // ----------------------------------------------------------
  // 7. TITLE ONLY
  // ----------------------------------------------------------

  candidates.push(
    candidate(
      productId,
      "TITLE_ONLY",
      [title],
      fieldClause("title", title),
    ),
  );

  // Có thể một product có nhiều variant cùng SKU/barcode sau
  // normalize. Loại duplicate trước khi ghi DB.

  const deduped = new Map<
    string,
    ThemeSearchTransportKeyCandidate
  >();

  for (const item of candidates) {
    const key = [
      item.kind,
      item.signature,
    ].join(":");

    if (!deduped.has(key)) {
      deduped.set(key, item);
    }
  }

  return [...deduped.values()];
}

// ============================================================
// PROFILE CACHE
// ============================================================

type ShopTransportIndex = {
  uniqueOwnerBySignature: Map<string, string | null>;
};

const TRANSPORT_CACHE_TTL_MS = (() => {
  const raw = Number.parseInt(
    process.env.AI_SEARCH_TRANSPORT_PROFILE_CACHE_TTL_MS || "",
    10,
  );
  return Number.isSafeInteger(raw) && raw >= 30_000
    ? Math.min(raw, 60 * 60_000)
    : 5 * 60_000;
})();

const MAX_TOTAL_TRANSPORT_SIGNATURES = (() => {
  const raw = Number.parseInt(
    process.env.AI_SEARCH_TRANSPORT_CACHE_MAX_SIGNATURES || "",
    10,
  );
  return Number.isSafeInteger(raw) && raw >= 10_000
    ? Math.min(raw, 2_000_000)
    : 500_000;
})();

type TransportCacheEntry = {
  expiresAt: number;
  semanticRevision: string;
  value: ShopTransportIndex;
  signatureCount: number;
};

const transportCache = new Map<string, TransportCacheEntry>();
const pendingTransportLoads = new Map<string, Promise<ShopTransportIndex>>();

function touchTransportCache(shop: string, entry: TransportCacheEntry) {
  transportCache.delete(shop);
  transportCache.set(shop, entry);
}

function enforceTransportCacheBudget() {
  let totalSignatures = [...transportCache.values()].reduce(
    (sum, entry) => sum + entry.signatureCount,
    0,
  );
  while (
    transportCache.size > 100 ||
    totalSignatures > MAX_TOTAL_TRANSPORT_SIGNATURES
  ) {
    const oldest = transportCache.entries().next().value as
      | [string, TransportCacheEntry]
      | undefined;
    if (!oldest) break;
    transportCache.delete(oldest[0]);
    totalSignatures -= oldest[1].signatureCount;
  }
}

export function invalidateThemeSearchTransportCache(shopInput: string) {
  transportCache.delete(normalizeShop(shopInput));
}

export function invalidateDerivedProductSearchCaches(
  shopInput: string,
  productId?: string,
) {
  const shop = normalizeShop(shopInput);
  if (!shop) return;
  if (productId) {
    removeProductSemanticProfileFromCache(shop, normalizeProductId(productId));
  }
  invalidateThemeSearchTransportCache(shop);
}

function transportProductFromSemanticRows(
  productId: string,
  rows: readonly StoredSemanticTerm[],
): ThemeSearchTransportProductInput | null {
  let title = "";
  let vendor: string | null = null;
  let productType: string | null = null;
  const tags: string[] = [];
  const skus: string[] = [];
  const barcodes: string[] = [];

  for (const row of rows) {
    switch (row.kind) {
      case "PRODUCT_TITLE":
        if (!title) title = row.value;
        break;
      case "VENDOR":
        if (!vendor) vendor = row.value;
        break;
      case "PRODUCT_TYPE":
        if (!productType) productType = row.value;
        break;
      case "TAG":
        tags.push(row.value);
        break;
      case "SKU":
        skus.push(row.value);
        break;
      case "BARCODE":
        barcodes.push(row.value);
        break;
      default:
        break;
    }
  }

  if (!title) return null;
  return {
    productId,
    title,
    vendor,
    productType,
    tags,
    skus,
    barcodes,
  };
}

async function loadShopTransportIndexUncached(
  shop: string,
  semanticRevision: string,
): Promise<ShopTransportIndex> {
  const uniqueOwnerBySignature = new Map<string, string | null>();
  const transportTermsByProduct = new Map<string, StoredSemanticTerm[]>();
  const transportKinds = new Set([
    "PRODUCT_TITLE",
    "VENDOR",
    "PRODUCT_TYPE",
    "TAG",
    "SKU",
    "BARCODE",
  ]);

  // Reuse the bounded semantic cache instead of issuing a second full-catalog
  // DB scan. Only the six deterministic fields needed for native transport are
  // retained in this temporary build map.
  for (const row of await loadShopSemanticRows(shop)) {
    if (!transportKinds.has(row.kind)) continue;
    const terms = transportTermsByProduct.get(row.productId) ?? [];
    terms.push(row);
    transportTermsByProduct.set(row.productId, terms);
  }

  for (const [productId, terms] of transportTermsByProduct) {
    const source = transportProductFromSemanticRows(productId, terms);
    if (!source) continue;

    for (const candidate of buildThemeSearchTransportKeyCandidates(source)) {
      if (!uniqueOwnerBySignature.has(candidate.signature)) {
        uniqueOwnerBySignature.set(candidate.signature, productId);
        continue;
      }

      const currentOwner = uniqueOwnerBySignature.get(candidate.signature);
      if (currentOwner !== productId) {
        uniqueOwnerBySignature.set(candidate.signature, null);
      }
    }
  }

  const value = { uniqueOwnerBySignature };
  transportCache.set(shop, {
    expiresAt: Date.now() + TRANSPORT_CACHE_TTL_MS,
    semanticRevision,
    value,
    signatureCount: uniqueOwnerBySignature.size,
  });
  enforceTransportCacheBudget();
  return value;
}

async function loadShopTransportIndex(shop: string): Promise<ShopTransportIndex> {
  const revisionSnapshot = await getSearchCatalogRevisionCached(shop);
  const semanticRevision = revisionSnapshot?.semanticRevision ?? "0";
  const cached = transportCache.get(shop);
  if (
    cached &&
    cached.expiresAt > Date.now() &&
    cached.semanticRevision === semanticRevision
  ) {
    touchTransportCache(shop, cached);
    return cached.value;
  }

  const pendingKey = shop + "\u0000" + semanticRevision;
  const pending = pendingTransportLoads.get(pendingKey);
  if (pending) return pending;

  const task = loadShopTransportIndexUncached(shop, semanticRevision);
  pendingTransportLoads.set(pendingKey, task);
  try {
    return await task;
  } finally {
    if (pendingTransportLoads.get(pendingKey) === task) {
      pendingTransportLoads.delete(pendingKey);
    }
  }
}

// ============================================================
// RESOLVE UNIQUE KEYS
// ============================================================

// ============================================================
// RESOLVE UNIQUE KEYS
// ============================================================

export async function resolveUniqueThemeSearchTransportKeys(
  args: {
    shop: string;
    productIds: readonly string[];
  },
): Promise<ResolveThemeSearchTransportKeysResult> {
  const shop = normalizeShop(args.shop);

  const productIds = [
    ...new Set(
      args.productIds
        .map(normalizeProductId)
        .filter(Boolean),
    ),
  ];

  if (
    !shop ||
    productIds.length === 0
  ) {
    return {
      resolved: [],
      unresolved: productIds.map(
        (productId) => ({
          productId,
          reason: "NO_TRANSPORT_KEYS",
        }),
      ),
    };
  }

  const { uniqueOwnerBySignature } =
    await loadShopTransportIndex(shop);
  const targetRows = await loadProductSemanticRows(shop, productIds);
  const rowsByProduct = new Map<string, StoredSemanticTerm[]>();
  for (const row of targetRows) {
    const list = rowsByProduct.get(row.productId) ?? [];
    list.push(row);
    rowsByProduct.set(row.productId, list);
  }

  const resolved: ResolvedThemeSearchTransportKey[] =
    [];

  const unresolved: UnresolvedThemeSearchTransportKey[] =
    [];

  // Giữ đúng order AI result.
  for (const productId of productIds) {
    const source = transportProductFromSemanticRows(
      productId,
      rowsByProduct.get(productId) ?? [],
    );
    const rows = source
      ? buildThemeSearchTransportKeyCandidates(source)
      : [];

    if (rows.length === 0) {
      unresolved.push({
        productId,
        reason: "NO_TRANSPORT_KEYS",
      });

      continue;
    }

    const sorted = [...rows].sort(
      (a, b) => {
        const priorityA =
          TRANSPORT_KEY_PRIORITY[
            a.kind as ThemeSearchTransportKeyKind
          ] ?? 999;

        const priorityB =
          TRANSPORT_KEY_PRIORITY[
            b.kind as ThemeSearchTransportKeyKind
          ] ?? 999;

        return priorityA - priorityB;
      },
    );

    const selected = sorted.find(
      (row) =>
        uniqueOwnerBySignature.get(row.signature) ===
        productId,
    );

    if (!selected) {
      unresolved.push({
        productId,
        reason:
          "NO_UNIQUE_TRANSPORT_KEY",
      });

      continue;
    }

    resolved.push({
      productId,
      kind:
        selected.kind as ThemeSearchTransportKeyKind,
      signature: selected.signature,
      clause: selected.clause,
    });
  }

  return {
    resolved,
    unresolved,
  };
}

// ============================================================
// BUILD PRODUCTION TRANSPORT PLAN FROM STORED KEYS
// ============================================================

function toBatchPlannerTarget(
  item: ResolvedThemeSearchTransportKey,
): ThemeSearchTransportResolvedTarget {
  return {
    productId: item.productId,

    // Stored transport keys intentionally do not duplicate handle.
    // Batching only needs productId + clause, so an empty handle is safe here.
    handle: "",

    strategy: item.kind,

    clause: item.clause,
  };
}

export async function planThemeSearchTransportFromStoredKeys(
  args: {
    shop: string;
    productIds: readonly string[];
    options?: PlannerOptions;
  },
): Promise<ThemeSearchTransportKeyPlanResult> {
  const targetProductIds = [
    ...new Set(
      args.productIds
        .map(normalizeProductId)
        .filter(Boolean),
    ),
  ];

  if (targetProductIds.length === 0) {
    return {
      safeToRender: false,
      targetProductIds: [],
      resolved: [],
      unresolved: [],
      batches: [],
    };
  }

  const resolution =
    await resolveUniqueThemeSearchTransportKeys({
      shop: args.shop,
      productIds: targetProductIds,
    });

  const {
    batches,
    tooLong,
  } =
    buildThemeSearchTransportBatches(
      resolution.resolved.map(
        toBatchPlannerTarget,
      ),
      args.options,
    );

  const tooLongIds =
    new Set(
      tooLong.map(
        (item) =>
          item.productId,
      ),
    );

  const usableResolved =
    resolution.resolved.filter(
      (item) =>
        !tooLongIds.has(
          item.productId,
        ),
    );

  const unresolved:
    ThemeSearchTransportKeyPlanUnresolvedTarget[] =
    [
      ...resolution.unresolved,
      ...tooLong.map(
        (item) => ({
          productId:
            item.productId,

          reason:
            "CLAUSE_TOO_LONG" as const,
        }),
      ),
    ];

  /**
   * Fail closed:
   *
   * - mọi AI target phải resolve được
   * - không target nào được vượt query-length guard
   * - phải sinh được ít nhất một batch
   *
   * Nếu một target không transport an toàn thì không render partial AI results.
   */
  const safeToRender =
    unresolved.length === 0 &&
    usableResolved.length ===
      targetProductIds.length &&
    batches.length > 0;

  return {
    safeToRender,

    targetProductIds,

    resolved:
      usableResolved,

    unresolved,

    batches,
  };
}

// ============================================================
// DEBUG
// ============================================================

export async function getProductThemeSearchTransportKeys(
  args: {
    shop: string;
    productId: string;
  },
) {
  const shop = normalizeShop(args.shop);
  const productId = normalizeProductId(
    args.productId,
  );

  if (!shop || !productId) return [];

  const rows = await loadProductSemanticRows(shop, [productId]);
  const source = transportProductFromSemanticRows(productId, rows);
  if (!source) return [];

  return buildThemeSearchTransportKeyCandidates(source)
    .sort((a, b) => a.kind.localeCompare(b.kind));
}