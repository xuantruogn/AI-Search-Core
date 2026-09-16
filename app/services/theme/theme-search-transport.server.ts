export type ThemeSearchTransportStrategy =
  | "VARIANT_SKU"
  | "VARIANT_BARCODE"
  | "TITLE_VENDOR_PRODUCT_TYPE"
  | "TITLE_VENDOR_PRODUCT_TYPE_TAG"
  | "TITLE_VENDOR"
  | "TITLE_PRODUCT_TYPE"
  | "TITLE_ONLY";

export interface ThemeSearchTransportCatalogProduct {
  productId: string;
  handle: string;

  title: string;

  vendor?: string | null;

  productType?: string | null;

  tags?: string[] | null;

  /**
   * Tất cả SKU của variants.
   */
  skus?: string[] | null;

  /**
   * Tất cả barcode của variants.
   */
  barcodes?: string[] | null;
}

export interface ThemeSearchTransportTarget {
  productId: string;
}

export interface ThemeSearchTransportResolvedTarget {
  productId: string;

  handle: string;

  strategy: ThemeSearchTransportStrategy;

  /**
   * Clause Shopify storefront search.
   *
   * Ví dụ:
   *
   * variants.sku:"ABC-001"
   *
   * hoặc:
   *
   * (
   *   title:"Gift Card"
   *   AND vendor:"Snowboard Vendor"
   *   AND product_type:"giftcard"
   * )
   */
  clause: string;
}

export interface ThemeSearchTransportUnresolvedTarget {
  productId: string;

  reason:
    | "PRODUCT_NOT_FOUND_IN_CATALOG"
    | "NO_SAFE_SEARCH_SIGNATURE"
    | "CLAUSE_TOO_LONG";
}

export interface ThemeSearchTransportBatch {
  /**
   * Thứ tự này vẫn là thứ tự AI.
   * Shopify không cần giữ đúng thứ tự này.
   */
  productIds: string[];

  /**
   * Query dùng cho /search?q=...
   */
  query: string;

  encodedQueryLength: number;
}

export interface ThemeSearchTransportPlan {
  safeToRender: boolean;

  resolved:
    ThemeSearchTransportResolvedTarget[];

  unresolved:
    ThemeSearchTransportUnresolvedTarget[];

  batches:
    ThemeSearchTransportBatch[];
}

export interface PlannerOptions {
  /**
   * Không nhồi toàn bộ 20 product vào một URL quá dài.
   *
   * Sau này có thể tune bằng benchmark.
   */
  maxProductsPerBatch?: number;

  /**
   * Tính theo encodeURIComponent(query).length.
   *
   * Đây không phải giới hạn Shopify chính thức.
   * Chỉ là guard để tránh transport URL quá lớn.
   */
  maxEncodedQueryLength?: number;
}

interface CatalogIndexes {
  skuOwners:
    Map<string, Set<string>>;

  barcodeOwners:
    Map<string, Set<string>>;

  titleOwners:
    Map<string, Set<string>>;

  titleVendorOwners:
    Map<string, Set<string>>;

  titleTypeOwners:
    Map<string, Set<string>>;

  titleVendorTypeOwners:
    Map<string, Set<string>>;

  titleVendorTypeTagOwners:
    Map<string, Set<string>>;
}

const DEFAULT_MAX_PRODUCTS_PER_BATCH =
  8;

const DEFAULT_MAX_ENCODED_QUERY_LENGTH =
  1400;

function cleanText(
  value:
    | string
    | null
    | undefined,
): string {
  return String(
    value ?? "",
  ).trim();
}

function normalize(
  value:
    | string
    | null
    | undefined,
): string {
  return cleanText(
    value,
  )
    .toLocaleLowerCase()
    .replace(
      /\s+/g,
      " ",
    );
}

function uniqueNonEmpty(
  values:
    | string[]
    | null
    | undefined,
): string[] {
  const result =
    new Map<
      string,
      string
    >();

  for (
    const value
    of values ?? []
  ) {
    const cleaned =
      cleanText(
        value,
      );

    if (!cleaned) {
      continue;
    }

    const key =
      normalize(
        cleaned,
      );

    if (
      !result.has(
        key,
      )
    ) {
      result.set(
        key,
        cleaned,
      );
    }
  }

  return [
    ...result.values(),
  ];
}

function signature(
  ...parts:
    Array<
      string |
      null |
      undefined
    >
): string {
  return parts
    .map(
      normalize,
    )
    .join("\u001f");
}

function addOwner(
  map:
    Map<
      string,
      Set<string>
    >,

  key: string,

  productId: string,
): void {
  if (!key) {
    return;
  }

  let owners =
    map.get(
      key,
    );

  if (!owners) {
    owners =
      new Set<string>();

    map.set(
      key,
      owners,
    );
  }

  owners.add(
    productId,
  );
}

function hasExactlyOneOwner(
  map:
    Map<
      string,
      Set<string>
    >,

  key: string,

  productId: string,
): boolean {
  const owners =
    map.get(
      key,
    );

  return (
    owners?.size ===
      1 &&
    owners.has(
      productId,
    )
  );
}

function buildIndexes(
  catalog:
    ThemeSearchTransportCatalogProduct[],
): CatalogIndexes {
  const indexes:
    CatalogIndexes =
    {
      skuOwners:
        new Map(),

      barcodeOwners:
        new Map(),

      titleOwners:
        new Map(),

      titleVendorOwners:
        new Map(),

      titleTypeOwners:
        new Map(),

      titleVendorTypeOwners:
        new Map(),

      titleVendorTypeTagOwners:
        new Map(),
    };

  for (
    const product
    of catalog
  ) {
    const productId =
      cleanText(
        product.productId,
      );

    if (!productId) {
      continue;
    }

    const title =
      cleanText(
        product.title,
      );

    const vendor =
      cleanText(
        product.vendor,
      );

    const productType =
      cleanText(
        product.productType,
      );

    const tags =
      uniqueNonEmpty(
        product.tags,
      );

    for (
      const sku
      of uniqueNonEmpty(
        product.skus,
      )
    ) {
      addOwner(
        indexes.skuOwners,

        normalize(
          sku,
        ),

        productId,
      );
    }

    for (
      const barcode
      of uniqueNonEmpty(
        product.barcodes,
      )
    ) {
      addOwner(
        indexes.barcodeOwners,

        normalize(
          barcode,
        ),

        productId,
      );
    }

    if (title) {
      addOwner(
        indexes.titleOwners,

        signature(
          title,
        ),

        productId,
      );
    }

    if (
      title &&
      vendor
    ) {
      addOwner(
        indexes
          .titleVendorOwners,

        signature(
          title,
          vendor,
        ),

        productId,
      );
    }

    if (
      title &&
      productType
    ) {
      addOwner(
        indexes
          .titleTypeOwners,

        signature(
          title,
          productType,
        ),

        productId,
      );
    }

    if (
      title &&
      vendor &&
      productType
    ) {
      addOwner(
        indexes
          .titleVendorTypeOwners,

        signature(
          title,
          vendor,
          productType,
        ),

        productId,
      );

      for (
        const tag
        of tags
      ) {
        addOwner(
          indexes
            .titleVendorTypeTagOwners,

          signature(
            title,
            vendor,
            productType,
            tag,
          ),

          productId,
        );
      }
    }
  }

  return indexes;
}

function escapeSearchPhrase(
  value: string,
): string {
  return value
    .replace(
      /\\/g,
      "\\\\",
    )
    .replace(
      /"/g,
      '\\"',
    )
    .replace(
      /\r/g,
      " ",
    )
    .replace(
      /\n/g,
      " ",
    );
}

function phrase(
  value: string,
): string {
  return `"${escapeSearchPhrase(
    value,
  )}"`;
}

function fieldClause(
  field: string,
  value: string,
): string {
  return `${field}:${phrase(
    value,
  )}`;
}

function andClause(
  parts: string[],
): string {
  return `(${parts.join(
    " AND ",
  )})`;
}

function resolveProductClause(
  product:
    ThemeSearchTransportCatalogProduct,

  indexes:
    CatalogIndexes,
): ThemeSearchTransportResolvedTarget | null {
  const productId =
    cleanText(
      product.productId,
    );

  const title =
    cleanText(
      product.title,
    );

  const vendor =
    cleanText(
      product.vendor,
    );

  const productType =
    cleanText(
      product.productType,
    );

  const skus =
    uniqueNonEmpty(
      product.skus,
    );

  const barcodes =
    uniqueNonEmpty(
      product.barcodes,
    );

  const tags =
    uniqueNonEmpty(
      product.tags,
    );

  /**
   * 1. SKU unique trong chính catalog shop.
   */
  for (
    const sku
    of skus
  ) {
    if (
      hasExactlyOneOwner(
        indexes.skuOwners,
        normalize(sku),
        productId,
      )
    ) {
      return {
        productId,

        handle:
          product.handle,

        strategy:
          "VARIANT_SKU",

        clause:
          fieldClause(
            "variants.sku",
            sku,
          ),
      };
    }
  }

  /**
   * 2. Barcode unique.
   */
  for (
    const barcode
    of barcodes
  ) {
    if (
      hasExactlyOneOwner(
        indexes.barcodeOwners,
        normalize(barcode),
        productId,
      )
    ) {
      return {
        productId,

        handle:
          product.handle,

        strategy:
          "VARIANT_BARCODE",

        clause:
          fieldClause(
            "variants.barcode",
            barcode,
          ),
      };
    }
  }

  /**
   * 3. title + vendor + product_type
   */
  if (
    title &&
    vendor &&
    productType &&
    hasExactlyOneOwner(
      indexes
        .titleVendorTypeOwners,

      signature(
        title,
        vendor,
        productType,
      ),

      productId,
    )
  ) {
    return {
      productId,

      handle:
        product.handle,

      strategy:
        "TITLE_VENDOR_PRODUCT_TYPE",

      clause:
        andClause([
          fieldClause(
            "title",
            title,
          ),

          fieldClause(
            "vendor",
            vendor,
          ),

          fieldClause(
            "product_type",
            productType,
          ),
        ]),
    };
  }

  /**
   * 4. Nếu bộ trên chưa unique,
   * thử thêm một tag thực sự phân biệt được product.
   */
  if (
    title &&
    vendor &&
    productType
  ) {
    for (
      const tag
      of tags
    ) {
      if (
        hasExactlyOneOwner(
          indexes
            .titleVendorTypeTagOwners,

          signature(
            title,
            vendor,
            productType,
            tag,
          ),

          productId,
        )
      ) {
        return {
          productId,

          handle:
            product.handle,

          strategy:
            "TITLE_VENDOR_PRODUCT_TYPE_TAG",

          clause:
            andClause([
              fieldClause(
                "title",
                title,
              ),

              fieldClause(
                "vendor",
                vendor,
              ),

              fieldClause(
                "product_type",
                productType,
              ),

              fieldClause(
                "tag",
                tag,
              ),
            ]),
        };
      }
    }
  }

  /**
   * 5. title + vendor
   */
  if (
    title &&
    vendor &&
    hasExactlyOneOwner(
      indexes
        .titleVendorOwners,

      signature(
        title,
        vendor,
      ),

      productId,
    )
  ) {
    return {
      productId,

      handle:
        product.handle,

      strategy:
        "TITLE_VENDOR",

      clause:
        andClause([
          fieldClause(
            "title",
            title,
          ),

          fieldClause(
            "vendor",
            vendor,
          ),
        ]),
    };
  }

  /**
   * 6. title + type
   */
  if (
    title &&
    productType &&
    hasExactlyOneOwner(
      indexes
        .titleTypeOwners,

      signature(
        title,
        productType,
      ),

      productId,
    )
  ) {
    return {
      productId,

      handle:
        product.handle,

      strategy:
        "TITLE_PRODUCT_TYPE",

      clause:
        andClause([
          fieldClause(
            "title",
            title,
          ),

          fieldClause(
            "product_type",
            productType,
          ),
        ]),
    };
  }

  /**
   * 7. Title duy nhất trong catalog.
   */
  if (
    title &&
    hasExactlyOneOwner(
      indexes.titleOwners,

      signature(
        title,
      ),

      productId,
    )
  ) {
    return {
      productId,

      handle:
        product.handle,

      strategy:
        "TITLE_ONLY",

      clause:
        fieldClause(
          "title",
          title,
        ),
    };
  }

  /**
   * Không chứng minh được signature đủ an toàn.
   *
   * Không đoán.
   */
  return null;
}

function encodedLength(
  query: string,
): number {
  return encodeURIComponent(
    query,
  ).length;
}

/**
 * Public batching helper.
 *
 * Dùng chung cho:
 *
 * - planner thuần dựa trên catalog
 * - DB transport-key resolver
 * - production Section Rendering transport
 *
 * Quy tắc:
 *
 * - giữ nguyên thứ tự AI
 * - tối đa N product / batch
 * - giới hạn encoded query length
 * - một clause riêng lẻ quá dài sẽ bị loại
 */
export function buildThemeSearchTransportBatches(
  resolved:
    ThemeSearchTransportResolvedTarget[],

  options?:
    PlannerOptions,
): {
  batches:
    ThemeSearchTransportBatch[];

  tooLong:
    ThemeSearchTransportUnresolvedTarget[];
} {
  const normalizedOptions:
    Required<PlannerOptions> =
      {
        maxProductsPerBatch:
          Math.max(
            1,
            Math.floor(
              options
                ?.maxProductsPerBatch ??
              DEFAULT_MAX_PRODUCTS_PER_BATCH,
            ),
          ),

        maxEncodedQueryLength:
          Math.max(
            256,
            Math.floor(
              options
                ?.maxEncodedQueryLength ??
              DEFAULT_MAX_ENCODED_QUERY_LENGTH,
            ),
          ),
      };

  const batches:
    ThemeSearchTransportBatch[] =
      [];

  const tooLong:
    ThemeSearchTransportUnresolvedTarget[] =
      [];

  let current:
    ThemeSearchTransportResolvedTarget[] =
      [];

  const flush = () => {
    if (
      current.length ===
      0
    ) {
      return;
    }

    const query =
      current
        .map(
          (item) =>
            item.clause,
        )
        .join(" OR ");

    batches.push({
      productIds:
        current.map(
          (item) =>
            item.productId,
        ),

      query,

      encodedQueryLength:
        encodedLength(
          query,
        ),
    });

    current =
      [];
  };

  for (
    const item
    of resolved
  ) {
    const singleLength =
      encodedLength(
        item.clause,
      );

    if (
      singleLength >
      normalizedOptions
        .maxEncodedQueryLength
    ) {
      tooLong.push({
        productId:
          item.productId,

        reason:
          "CLAUSE_TOO_LONG",
      });

      continue;
    }

    if (
      current.length ===
      0
    ) {
      current.push(
        item,
      );

      continue;
    }

    const tentative =
      [
        ...current,
        item,
      ];

    const tentativeQuery =
      tentative
        .map(
          (entry) =>
            entry.clause,
        )
        .join(" OR ");

    const exceedsCount =
      tentative.length >
      normalizedOptions
        .maxProductsPerBatch;

    const exceedsLength =
      encodedLength(
        tentativeQuery,
      ) >
      normalizedOptions
        .maxEncodedQueryLength;

    if (
      exceedsCount ||
      exceedsLength
    ) {
      flush();

      current.push(
        item,
      );

      continue;
    }

    current.push(
      item,
    );
  }

  flush();

  return {
    batches,
    tooLong,
  };
}

export function planThemeSearchTransport(
  args: {
    targets:
      ThemeSearchTransportTarget[];

    catalog:
      ThemeSearchTransportCatalogProduct[];

    options?:
      PlannerOptions;
  },
): ThemeSearchTransportPlan {
  const options:
    Required<PlannerOptions> =
      {
        maxProductsPerBatch:
          Math.max(
            1,
            Math.floor(
              args.options
                ?.maxProductsPerBatch ??
              DEFAULT_MAX_PRODUCTS_PER_BATCH,
            ),
          ),

        maxEncodedQueryLength:
          Math.max(
            256,
            Math.floor(
              args.options
                ?.maxEncodedQueryLength ??
              DEFAULT_MAX_ENCODED_QUERY_LENGTH,
            ),
          ),
      };

  const catalogById =
    new Map<
      string,
      ThemeSearchTransportCatalogProduct
    >();

  for (
    const product
    of args.catalog
  ) {
    const productId =
      cleanText(
        product.productId,
      );

    if (!productId) {
      continue;
    }

    catalogById.set(
      productId,
      product,
    );
  }

  const indexes =
    buildIndexes(
      args.catalog,
    );

  /**
   * Giữ nguyên AI order nhưng loại duplicate ID.
   */
  const seenTargets =
    new Set<string>();

  const targetIds:
    string[] = [];

  for (
    const target
    of args.targets
  ) {
    const productId =
      cleanText(
        target.productId,
      );

    if (
      !productId ||
      seenTargets.has(
        productId,
      )
    ) {
      continue;
    }

    seenTargets.add(
      productId,
    );

    targetIds.push(
      productId,
    );
  }

  const resolved:
    ThemeSearchTransportResolvedTarget[] =
      [];

  const unresolved:
    ThemeSearchTransportUnresolvedTarget[] =
      [];

  for (
    const productId
    of targetIds
  ) {
    const product =
      catalogById.get(
        productId,
      );

    if (!product) {
      unresolved.push({
        productId,

        reason:
          "PRODUCT_NOT_FOUND_IN_CATALOG",
      });

      continue;
    }

    const result =
      resolveProductClause(
        product,
        indexes,
      );

    if (!result) {
      unresolved.push({
        productId,

        reason:
          "NO_SAFE_SEARCH_SIGNATURE",
      });

      continue;
    }

    resolved.push(
      result,
    );
  }

  const {
    batches,
    tooLong,
  } =
    buildThemeSearchTransportBatches(
      resolved,
      options,
    );

  unresolved.push(
    ...tooLong,
  );

  const tooLongIds =
    new Set(
      tooLong.map(
        (item) =>
          item.productId,
      ),
    );

  const usableResolved =
    resolved.filter(
      (item) =>
        !tooLongIds.has(
          item.productId,
        ),
    );

  /**
   * Quan trọng:
   *
   * Chỉ takeover khi TẤT CẢ target AI
   * đều có transport signature an toàn.
   *
   * Không render thiếu một phần rồi giả vờ
   * đó là kết quả AI hoàn chỉnh.
   */
  const safeToRender =
    unresolved.length ===
      0 &&
    usableResolved.length ===
      targetIds.length &&
    batches.length >
      0;

  return {
    safeToRender,

    resolved:
      usableResolved,

    unresolved,

    batches,
  };
}