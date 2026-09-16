import { createHash } from "node:crypto";

import db from "../../db.server";

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
// PERSIST
// ============================================================

export async function replaceProductThemeSearchTransportKeys(
  args: {
    shop: string;
    product: ThemeSearchTransportProductInput;
  },
): Promise<{
  productId: string;
  keyCount: number;
}> {
  const shop = normalizeShop(args.shop);

  const productId = normalizeProductId(
    args.product.productId,
  );

  if (!shop) {
    throw new Error(
      "THEME_SEARCH_TRANSPORT_SHOP_REQUIRED",
    );
  }

  if (!productId) {
    throw new Error(
      "THEME_SEARCH_TRANSPORT_PRODUCT_ID_REQUIRED",
    );
  }

  const candidates =
    buildThemeSearchTransportKeyCandidates({
      ...args.product,
      productId,
    });

  await db.$transaction(async (tx) => {
    await tx.aiSearchRenderTransportKey.deleteMany({
      where: {
        shop,
        productId,
      },
    });

    if (candidates.length === 0) {
      return;
    }

    await tx.aiSearchRenderTransportKey.createMany({
      data: candidates.map((item) => ({
        shop,
        productId,
        kind: item.kind,
        signature: item.signature,
        clause: item.clause,
      })),
    });
  });

  return {
    productId,
    keyCount: candidates.length,
  };
}

// ============================================================
// DELETE
// ============================================================

export async function deleteProductThemeSearchTransportKeys(
  args: {
    shop: string;
    productId: string;
  },
): Promise<number> {
  const shop = normalizeShop(args.shop);
  const productId = normalizeProductId(
    args.productId,
  );

  if (!shop || !productId) {
    return 0;
  }

  const result =
    await db.aiSearchRenderTransportKey.deleteMany({
      where: {
        shop,
        productId,
      },
    });

  return result.count;
}

export async function deleteShopThemeSearchTransportKeys(
  shopInput: string,
): Promise<number> {
  const shop = normalizeShop(shopInput);

  if (!shop) {
    return 0;
  }

  const result =
    await db.aiSearchRenderTransportKey.deleteMany({
      where: {
        shop,
      },
    });

  return result.count;
}

// ============================================================
// RESOLVE UNIQUE KEYS
// ============================================================

function pairKey(
  kind: string,
  signature: string,
): string {
  return `${kind}:${signature}`;
}

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

  // ----------------------------------------------------------
  // Chỉ load key của các AI target.
  // Không load cả catalog.
  // ----------------------------------------------------------

  const targetRows =
    await db.aiSearchRenderTransportKey.findMany({
      where: {
        shop,
        productId: {
          in: productIds,
        },
      },
      select: {
        productId: true,
        kind: true,
        signature: true,
        clause: true,
      },
    });

  if (targetRows.length === 0) {
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

  // ----------------------------------------------------------
  // Lấy tập (kind, signature) cần kiểm uniqueness.
  // ----------------------------------------------------------

  const pairs = new Map<
    string,
    {
      kind: string;
      signature: string;
    }
  >();

  for (const row of targetRows) {
    const key = pairKey(
      row.kind,
      row.signature,
    );

    if (!pairs.has(key)) {
      pairs.set(key, {
        kind: row.kind,
        signature: row.signature,
      });
    }
  }

  // ----------------------------------------------------------
  // Query tất cả owner của đúng những signature cần thiết.
  //
  // Ví dụ:
  //
  // Product A:
  // title/vendor/type signature XYZ
  //
  // Ta chỉ hỏi DB:
  // "shop này có product nào khác cũng sở hữu XYZ không?"
  //
  // Không cần load toàn bộ catalog.
  // ----------------------------------------------------------

  const pairFilters = [...pairs.values()];

  const ownerRows =
    await db.aiSearchRenderTransportKey.findMany({
      where: {
        shop,
        OR: pairFilters.map((pair) => ({
          kind: pair.kind,
          signature: pair.signature,
        })),
      },
      select: {
        productId: true,
        kind: true,
        signature: true,
      },
    });

  const ownersByPair = new Map<
    string,
    Set<string>
  >();

  for (const row of ownerRows) {
    const key = pairKey(
      row.kind,
      row.signature,
    );

    let owners = ownersByPair.get(key);

    if (!owners) {
      owners = new Set<string>();
      ownersByPair.set(key, owners);
    }

    owners.add(row.productId);
  }

  // ----------------------------------------------------------
  // Group candidate theo product.
  // ----------------------------------------------------------

  const rowsByProduct = new Map<
    string,
    typeof targetRows
  >();

  for (const productId of productIds) {
    rowsByProduct.set(productId, []);
  }

  for (const row of targetRows) {
    const rows =
      rowsByProduct.get(row.productId);

    if (rows) {
      rows.push(row);
    }
  }

  const resolved: ResolvedThemeSearchTransportKey[] =
    [];

  const unresolved: UnresolvedThemeSearchTransportKey[] =
    [];

  // Giữ đúng order AI result.
  for (const productId of productIds) {
    const rows =
      rowsByProduct.get(productId) ?? [];

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

    const selected = sorted.find((row) => {
      const owners = ownersByPair.get(
        pairKey(
          row.kind,
          row.signature,
        ),
      );

      return (
        owners?.size === 1 &&
        owners.has(productId)
      );
    });

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

  return db.aiSearchRenderTransportKey.findMany({
    where: {
      shop,
      productId,
    },
    orderBy: [
      {
        kind: "asc",
      },
      {
        signature: "asc",
      },
    ],
  });
}