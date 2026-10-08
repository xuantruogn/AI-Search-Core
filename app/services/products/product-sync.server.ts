import type {
  ProductForIndex,
  ProductVariantForIndex,
} from "./product-document.server";
import { isSearchableOnlineStoreProduct } from "./product-visibility.server";

type AdminGraphqlClient = {
  graphql: (
    query: string,
    options?: {
      variables?: Record<string, unknown>;
    },
  ) => Promise<Response>;
};

type ShopifyProductStatus =
  | "ACTIVE"
  | "DRAFT"
  | "ARCHIVED"
  | "UNLISTED";

type ShopifyProductNode = {
  id: string;
  handle: string;
  title: string;
  description: string;
  vendor: string;
  productType: string;
  category?: { id: string; fullName: string } | null;
  tags: string[];

  status?: ShopifyProductStatus;
  publishedAt?: string | null;

  priceRangeV2?: {
    minVariantPrice?: {
      amount?: string;
      currencyCode?: string;
    };

    maxVariantPrice?: {
      amount?: string;
      currencyCode?: string;
    };
  };

  variants: {
    nodes: Array<{
      id: string;
      title: string;
      sku: string | null;
      barcode: string | null;
      selectedOptions: Array<{
        name: string;
        value: string;
      }>;
    }>;
    pageInfo?: {
      hasNextPage: boolean;
      endCursor: string | null;
    };
  };
};

type ProductsResponse = {
  data?: {
    products?: {
      nodes: ShopifyProductNode[];

      pageInfo: {
        hasNextPage: boolean;
        endCursor: string | null;
      };
    };
  };

  errors?: Array<{
    message: string;
  }>;
};

type ProductResponse = {
  data?: {
    product?: ShopifyProductNode | null;
  };

  errors?: Array<{
    message: string;
  }>;
};

export type ProductPage = {
  products: ProductForIndex[];
  hasNextPage: boolean;
  endCursor: string | null;
};

type ShopifyVariantNode = ShopifyProductNode["variants"]["nodes"][number];

function maxVariantsPerProduct() {
  const parsed = Number.parseInt(
    process.env.AI_SEARCH_MAX_VARIANTS_PER_PRODUCT || "",
    10,
  );
  return Number.isSafeInteger(parsed) && parsed >= 250
    ? Math.min(parsed, 10_000)
    : 5_000;
}

async function hydrateAllProductVariants(
  admin: AdminGraphqlClient,
  product: ShopifyProductNode,
): Promise<ShopifyProductNode> {
  if (!product.variants.pageInfo?.hasNextPage) return product;

  const nodes: ShopifyVariantNode[] = [...product.variants.nodes];
  let after = product.variants.pageInfo.endCursor;
  const maxVariants = maxVariantsPerProduct();

  while (after && nodes.length < maxVariants) {
    const response = await admin.graphql(
      `#graphql
        query AiSearchProductVariants($id: ID!, $after: String) {
          product(id: $id) {
            id
            variants(first: 250, after: $after) {
              nodes {
                id
                title
                sku
                barcode
                selectedOptions {
                  name
                  value
                }
              }
              pageInfo {
                hasNextPage
                endCursor
              }
            }
          }
        }
      `,
      { variables: { id: product.id, after } },
    );
    const json = (await response.json()) as {
      data?: {
        product?: {
          variants?: {
            nodes?: ShopifyVariantNode[];
            pageInfo?: { hasNextPage: boolean; endCursor: string | null };
          };
        } | null;
      };
      errors?: Array<{ message?: string }>;
    };

    if (!response.ok || json.errors?.length || !json.data?.product?.variants) {
      const detail = json.errors?.map((error) => error.message).filter(Boolean).join("; ");
      throw new Error(
        detail
          ? `Shopify product variants query failed: ${detail}`
          : `Shopify product variants query failed with HTTP ${response.status}`,
      );
    }

    const connection = json.data.product.variants;
    nodes.push(...(connection.nodes ?? []));
    if (!connection.pageInfo?.hasNextPage) {
      after = null;
      break;
    }
    if (!connection.pageInfo.endCursor || connection.pageInfo.endCursor === after) {
      throw new Error("Shopify variants pagination did not advance");
    }
    after = connection.pageInfo.endCursor;
  }

  if (nodes.length >= maxVariants && after) {
    throw new Error(
      `Product ${product.id} exceeds AI_SEARCH_MAX_VARIANTS_PER_PRODUCT=${maxVariants}; refusing a partial semantic index`,
    );
  }

  return {
    ...product,
    variants: {
      nodes,
      pageInfo: {
        hasNextPage: false,
        endCursor: null,
      },
    },
  };
}

// =====================================================
// MAP SHOPIFY PRODUCT
//        ↓
// ProductForIndex
//
// Dùng chung cho:
// - Initial full sync
// - products/create
// - products/update
// =====================================================

function mapShopifyProduct(
  product: ShopifyProductNode,
): ProductForIndex {
  /*
   * ProductVariantForIndex hiện tại chưa cần barcode
   * cho semantic document.
   *
   * Nhưng runtime object vẫn giữ barcode để
   * Theme Search Transport Key sử dụng.
   */
  const variants: Array<
    ProductVariantForIndex & {
      barcode: string | null;
    }
  > = product.variants.nodes.map(
    (variant) => ({
      id: variant.id,
      title: variant.title,
      sku: variant.sku,
      barcode: variant.barcode,
      selectedOptions: variant.selectedOptions,
    }),
  );

  const minPrice =
    Number.parseFloat(
      product.priceRangeV2
        ?.minVariantPrice
        ?.amount ?? "",
    );

  const maxPrice =
    Number.parseFloat(
      product.priceRangeV2
        ?.maxVariantPrice
        ?.amount ?? "",
    );

  const currencyCode =
    product.priceRangeV2
      ?.minVariantPrice
      ?.currencyCode
      ?.toUpperCase() ??
    "";

  return {
    id: product.id,

    handle:
      product.handle,

    title:
      product.title,

    description:
      product.description,

    vendor:
      product.vendor,

    productType:
      product.productType,

    shopifyCategory: product.category ?? null,

    tags:
      product.tags,

    variants,

    priceRange:
      Number.isFinite(
        minPrice,
      ) &&
      Number.isFinite(
        maxPrice,
      ) &&
      currencyCode
        ? {
            min:
              minPrice,

            max:
              maxPrice,

            currencyCode,
          }
        : null,
  };
}

// =====================================================
// FETCH ONE PAGE
//
// Dùng cho initial full catalog sync.
// Chỉ lấy sản phẩm ACTIVE và đang published lên Online Store.
// =====================================================

export async function fetchProductsForIndex(
  admin: AdminGraphqlClient,
  options?: {
    first?: number;
    after?: string | null;
  },
): Promise<ProductPage> {
  const first =
    Math.max(
      1,
      Math.min(
        Math.trunc(
          options?.first ??
            50,
        ),
        100,
      ),
    );

  const after =
    options?.after ??
    null;

  const response =
    await admin.graphql(
      `#graphql
        query ProductsForAiSearch(
          $first: Int!
          $after: String
        ) {
          products(
            first: $first
            after: $after
            query: "status:ACTIVE AND published_status:published"
            sortKey: ID
          ) {
            nodes {
              id
              handle
              title
              description
              vendor
              productType
              category { id fullName }
              tags
              status
              publishedAt

              priceRangeV2 {
                minVariantPrice {
                  amount
                  currencyCode
                }

                maxVariantPrice {
                  amount
                  currencyCode
                }
              }

              variants(first: 250) {
                nodes {
                  id
                  title
                  sku
                  barcode
                  selectedOptions {
                    name
                    value
                  }
                }
                pageInfo {
                  hasNextPage
                  endCursor
                }
              }
            }

            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      `,
      {
        variables: {
          first,
          after,
        },
      },
    );

  const json =
    (await response.json()) as ProductsResponse;

  if (
    !response.ok ||
    json.errors?.length
  ) {
    const detail =
      json.errors
        ?.map(
          (error) =>
            error.message,
        )
        .filter(Boolean)
        .join("; ");

    throw new Error(
      detail
        ? `Shopify products query failed: ${detail}`
        : `Shopify products query failed with HTTP ${response.status}`,
    );
  }

  const connection =
    json.data?.products;

  if (!connection) {
    throw new Error(
      "Shopify products query returned no products connection",
    );
  }

  // `published_status:published` is the primary Shopify-side filter, but keep
  // the same local visibility predicate used by webhook/search revalidation as
  // a second safety fence. This also protects against a future/scheduled
  // `publishedAt` value being treated as live before its effective time.
  const searchableNodes =
    connection.nodes.filter((product) =>
      isSearchableOnlineStoreProduct({
        status: product.status,
        publishedAt: product.publishedAt,
      }),
    );
  const hydratedNodes = await Promise.all(
    searchableNodes.map((product) =>
      hydrateAllProductVariants(admin, product),
    ),
  );
  const products = hydratedNodes.map(mapShopifyProduct);

  return {
    products,

    hasNextPage:
      connection.pageInfo
        .hasNextPage,

    endCursor:
      connection.pageInfo
        .endCursor,
  };
}

// =====================================================
// REVALIDATE PRODUCT PRESENCE FOR CATALOG CLEANUP
//
// Full scans can race with product webhooks. Before deleting a registry/vector
// row that looks stale by timestamp, ask Shopify (the source of truth) whether
// that product is still searchable on Online Store (ACTIVE + published).
// `nodes(ids:)` keeps this to one GraphQL request per cleanup batch instead of
// one request per product.
// =====================================================

export type ProductPresenceStatus =
  | "SEARCHABLE"
  | "NOT_SEARCHABLE"
  | "MISSING";

export async function fetchProductPresenceByIds(
  admin: AdminGraphqlClient,
  productIds: string[],
): Promise<
  Map<
    string,
    ProductPresenceStatus
  >
> {
  const ids = [
    ...new Set(
      productIds.map(
        (id) =>
          id.trim(),
      ),
    ),
  ]
    .filter(Boolean)
    .slice(0, 100);

  const result =
    new Map<
      string,
      ProductPresenceStatus
    >();

  if (
    ids.length === 0
  ) {
    return result;
  }

  const response =
    await admin.graphql(
      `#graphql
        query AiSearchProductPresence(
          $ids: [ID!]!
        ) {
          nodes(ids: $ids) {
            ... on Product {
              id
              status
              publishedAt
              handle
              title
            }
          }
        }
      `,
      {
        variables: {
          ids,
        },
      },
    );

  const json =
    (await response.json()) as {
      data?: {
        nodes?: Array<
          | {
              id?: string;
              status?: string;
              publishedAt?: string | null;
              handle?: string;
              title?: string;
            }
          | null
        >;
      };

      errors?: Array<{
        message?: string;
      }>;
    };

  if (
    !response.ok ||
    json.errors?.length
  ) {
    const detail =
      json.errors
        ?.map(
          (error) =>
            error.message,
        )
        .filter(Boolean)
        .join("; ");

    throw new Error(
      detail
        ? `Shopify product-presence query failed: ${detail}`
        : `Shopify product-presence query failed with HTTP ${response.status}`,
    );
  }

  for (
    const id
    of ids
  ) {
    result.set(
      id,
      "MISSING",
    );
  }

  for (
    const node
    of json.data
      ?.nodes ??
    []
  ) {
    if (
      !node?.id ||
      !result.has(node.id)
    ) {
      continue;
    }

    result.set(
      node.id,

      isSearchableOnlineStoreProduct({
        status:
          node.status,

        publishedAt:
          node.publishedAt,
      })
        ? "SEARCHABLE"
        : "NOT_SEARCHABLE",
    );
  }

  return result;
}

// =====================================================
// FETCH ONE PRODUCT BY SHOPIFY GID
//
// Dùng cho webhook:
//
// products/create
// products/update
//
// Ví dụ productId:
//
// gid://shopify/Product/123456789
//
// Nếu:
// - product không tồn tại
// - product không ACTIVE
// - product không còn published trên Online Store
//
// thì return null. Điều này giữ Qdrant đồng nhất với những gì storefront
// thực sự có thể tìm thấy/hiển thị.
// =====================================================

export async function fetchProductForIndexById(
  admin: AdminGraphqlClient,
  productId: string,
): Promise<
  ProductForIndex | null
> {
  if (
    !productId.trim()
  ) {
    throw new Error(
      "Product ID cannot be empty",
    );
  }

  const response =
    await admin.graphql(
      `#graphql
        query ProductForAiSearch(
          $id: ID!
        ) {
          product(id: $id) {
            id
            handle
            title
            description
            vendor
            productType
            category { id fullName }
            tags
            status
            publishedAt

            priceRangeV2 {
              minVariantPrice {
                amount
                currencyCode
              }

              maxVariantPrice {
                amount
                currencyCode
              }
            }

            variants(first: 250) {
              nodes {
                id
                title
                sku
                barcode
                selectedOptions {
                  name
                  value
                }
              }
              pageInfo {
                hasNextPage
                endCursor
              }
            }
          }
        }
      `,
      {
        variables: {
          id:
            productId,
        },
      },
    );

  const json =
    (await response.json()) as ProductResponse;

  if (
    !response.ok ||
    json.errors?.length
  ) {
    const detail =
      json.errors
        ?.map(
          (error) =>
            error.message,
        )
        .filter(Boolean)
        .join("; ");

    throw new Error(
      detail
        ? `Shopify product query failed: ${detail}`
        : `Shopify product query failed with HTTP ${response.status}`,
    );
  }

  const product =
    json.data?.product;

  if (!product) {
    return null;
  }

  // Chỉ ACTIVE + Online Store published products được phép tồn tại
  // trong AI Search index. ACTIVE nhưng unpublished/unlisted vẫn phải native.
  if (
    !isSearchableOnlineStoreProduct({
      status:
        product.status,

      publishedAt:
        product.publishedAt,
    })
  ) {
    console.log(
      "[AI Search] Product is not storefront-searchable:",
      {
        productId:
          product.id,

        handle:
          product.handle,

        status:
          product.status,

        publishedAt:
          product.publishedAt ??
          null,
      },
    );

    return null;
  }

  const hydratedProduct = await hydrateAllProductVariants(admin, product);
  return mapShopifyProduct(hydratedProduct);
}

export type SearchableProductSnapshot = {
  productId: string;
  handle: string;
  title: string;
  minVariantPrice: number;
  maxVariantPrice: number;
  currencyCode: string;
};

/**
 * Revalidates ranked vector candidates against Shopify immediately before
 * storefront rendering. Webhooks are eventually consistent and Online Store
 * publication changes aren't guaranteed to reach a third-party app, so a
 * stale Qdrant point must never be enough to expose an unpublished product.
 */
export async function fetchSearchableProductSnapshotsByIds(
  admin: AdminGraphqlClient,
  productIds: string[],
): Promise<
  Map<
    string,
    SearchableProductSnapshot
  >
> {
  const ids = [
    ...new Set(
      productIds.map(
        (id) =>
          id.trim(),
      ),
    ),
  ]
    .filter(Boolean)
    .slice(0, 100);

  const result =
    new Map<
      string,
      SearchableProductSnapshot
    >();

  if (
    ids.length === 0
  ) {
    return result;
  }

  const response =
    await admin.graphql(
      `#graphql
        query AiSearchStorefrontProductVisibility(
          $ids: [ID!]!
        ) {
          nodes(ids: $ids) {
            ... on Product {
              id
              handle
              title
              status
              publishedAt

              priceRangeV2 {
                minVariantPrice {
                  amount
                  currencyCode
                }

                maxVariantPrice {
                  amount
                  currencyCode
                }
              }
            }
          }
        }
      `,
      {
        variables: {
          ids,
        },
      },
    );

  const json =
    (await response.json()) as {
      data?: {
        nodes?: Array<
          | {
              id?: string;
              handle?: string;
              title?: string;
              status?: string;
              publishedAt?: string | null;

              priceRangeV2?: {
                minVariantPrice?: {
                  amount?: string;
                  currencyCode?: string;
                };

                maxVariantPrice?: {
                  amount?: string;
                  currencyCode?: string;
                };
              };
            }
          | null
        >;
      };

      errors?: Array<{
        message?: string;
      }>;
    };

  if (
    !response.ok ||
    json.errors?.length
  ) {
    const detail =
      json.errors
        ?.map(
          (error) =>
            error.message,
        )
        .filter(Boolean)
        .join("; ");

    throw new Error(
      detail
        ? `Shopify storefront-product validation failed: ${detail}`
        : `Shopify storefront-product validation failed with HTTP ${response.status}`,
    );
  }

  for (
    const node
    of json.data
      ?.nodes ??
    []
  ) {
    const minVariantPrice =
      Number.parseFloat(
        node?.priceRangeV2
          ?.minVariantPrice
          ?.amount ??
          "",
      );

    const maxVariantPrice =
      Number.parseFloat(
        node?.priceRangeV2
          ?.maxVariantPrice
          ?.amount ??
          "",
      );

    const currencyCode =
      node?.priceRangeV2
        ?.minVariantPrice
        ?.currencyCode
        ?.toUpperCase() ??
      "";

    if (
      !node?.id ||
      !node.handle ||
      !node.title ||
      !Number.isFinite(
        minVariantPrice,
      ) ||
      !Number.isFinite(
        maxVariantPrice,
      ) ||
      !currencyCode ||
      !isSearchableOnlineStoreProduct({
        status:
          node.status,

        publishedAt:
          node.publishedAt,
      })
    ) {
      continue;
    }

    result.set(
      node.id,
      {
        productId:
          node.id,

        handle:
          node.handle,

        title:
          node.title,

        minVariantPrice,

        maxVariantPrice,

        currencyCode,
      },
    );
  }

  return result;
}