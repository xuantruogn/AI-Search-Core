/**
 * App Self Render V3
 *
 * This module starts AFTER the shared search pipeline has already produced
 * the ordered Product ID list. It owns only Product hydration + HTML/CSS
 * rendering + pagination bootstrap for Dedicated/App Self Render mode.
 *
 * It deliberately does not import or call Theme Map V4 services.
 */

type AdminGraphqlClient = {
  graphql: (
    query: string,
    options?: {
      variables?: Record<string, unknown>;
    },
  ) => Promise<Response>;
};

export async function fetchProductsByGids(
  admin: AdminGraphqlClient,
  gids: string[],
) {
  if (!gids || gids.length === 0) {
    return [];
  }

  const query = `#graphql
    query getProductsByIds($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on Product {
          id
          title
          handle
          vendor

          featuredImage {
            url
            altText
          }

          images(first: 2) {
            nodes {
              url
              altText
            }
          }

          priceRangeV2 {
            minVariantPrice {
              amount
              currencyCode
            }
          }

          variants(first: 1) {
            nodes {
              id
              price
              compareAtPrice
            }
          }
        }
      }
    }
  `;

  try {
    console.log(
      "📡 [Dedicated V3] Admin GraphQL product IDs:",
      gids,
    );

    const response = await admin.graphql(query, {
      variables: {
        ids: gids,
      },
    });

    const json = await response.json();

    /*
     * QUAN TRỌNG:
     * Không được nuốt GraphQL errors.
     */
    if (json?.errors?.length) {
      console.error(
        "❌ [Dedicated V3] Admin GraphQL errors:",
        json.errors,
      );

      return [];
    }

    const nodes = json?.data?.nodes || [];

    console.log(
      `📦 [Dedicated V3] Admin GraphQL trả về ${nodes.length}/${gids.length} products`,
    );

    return nodes
      .filter(Boolean)
      .map((product: any) => {
        const firstVariant =
          product.variants?.nodes?.[0];

        const price = parseFloat(
          firstVariant?.price ||
            product.priceRangeV2?.minVariantPrice?.amount ||
            "0",
        );

        const compareAtPrice = parseFloat(
          firstVariant?.compareAtPrice || "0",
        );

        const isSale =
          compareAtPrice > price;

        const discountPercent =
          isSale && compareAtPrice > 0
            ? Math.round(
                ((compareAtPrice - price) /
                  compareAtPrice) *
                  100,
              )
            : 0;

        const currency =
          product.priceRangeV2
            ?.minVariantPrice
            ?.currencyCode || "USD";

        const primaryImg =
          product.featuredImage?.url ||
          product.images?.nodes?.[0]?.url ||
          "";

        const hoverImg =
          product.images?.nodes?.[1]?.url ||
          primaryImg;

        return {
          id: product.id,
          title: product.title || "Sản phẩm",
          handle: product.handle || "",
          vendor: product.vendor || "",

          /*
           * Admin Product query trên đây không dùng
           * availableForSale.
           *
           * Để renderer V3 không bị phụ thuộc vào
           * Storefront-only field.
           */
          availableForSale: true,

          defaultVariantId:
            firstVariant?.id
              ?.replace(
                "gid://shopify/ProductVariant/",
                "",
              ) || "",

          images: {
            primary: primaryImg,
            hover: hoverImg,
            hasHover:
              product.images?.nodes?.length > 1,
          },

          priceInfo: {
            price,
            compareAtPrice,
            isSale,
            discountPercent,
            formattedPrice:
              `${currency}${price.toFixed(2)}`,
            formattedCompareAtPrice:
              compareAtPrice > 0
                ? `${currency}${compareAtPrice.toFixed(2)}`
                : "",
          },
        };
      });
  } catch (err) {
    console.error(
      "❌ [Dedicated V3] GraphQL Fetch Error:",
      err,
    );

    return [];
  }
}

export async function renderAppSelfSearchPage(args: {
  admin: AdminGraphqlClient;
  query: string;
  productIds: string[];
  pageSize: number;
}): Promise<{
  html: string;
  pageSize: number;
  totalProducts: number;
  totalPages: number;
  page1Products: any[];
}> {
  const { admin, query, productIds, pageSize } = args;

console.log(
  `🚀 [AI Search Dedicated] Đã nhận ${productIds.length} IDs từ AI & Qdrant.`
);
const allIds = productIds.map((id) => id);
const dynamicPageSize = pageSize && pageSize > 0 ? pageSize : 5;

console.log("🔍 [DEBUG DEDICATED] 1. Danh sách allIds gốc từ AI/Qdrant:", allIds);

const page1Ids = allIds.slice(0, dynamicPageSize).map((id) => {
  const cleanId = String(id).replace(/^gid:\/\/shopify\/Product\//, "").trim();
  return `gid://shopify/Product/${cleanId}`;
});

let page1Products: any[] = [];

console.log("📦 [DEBUG DEDICATED] 2. Mảng page1Ids gửi lên Shopify Admin GraphQL:", page1Ids);

if (page1Ids.length > 0) {
  try {
    page1Products = await fetchProductsByGids(admin, page1Ids);
    console.log(`✅ [DEBUG DEDICATED] 3. Kết quả GraphQL trả về ${page1Products.length} sản phẩm:`, page1Products);
  } catch (e) {
    console.error("❌ [DEBUG DEDICATED] Lỗi GraphQL:", e);
  }
}

const totalProducts = allIds.length;
const totalPages = Math.ceil(totalProducts / dynamicPageSize);

function renderCard(product: any) {
  const isAvailable = product?.availableForSale ?? true;
  const priceInfo = product?.priceInfo || {};
  const primaryImg = product?.images?.primary || "";
  const hoverImg = product?.images?.hover || primaryImg;
  const hasHover = product?.images?.hasHover && hoverImg !== primaryImg;

  return `
    <div class="ai-card">
      <div class="ai-card__media">
        ${!isAvailable 
          ? '<span class="ai-badge ai-badge--soldout">Sold out</span>' 
          : priceInfo?.isSale 
          ? `<span class="ai-badge ai-badge--sale">Sale -${priceInfo.discountPercent}%</span>` 
          : ''}
        <a href="/products/${product.handle}">
          <img class="ai-card__img" src="${primaryImg}" alt="${(product.title || '').replace(/"/g, '&quot;')}" loading="lazy" />
          ${hasHover ? `<img class="ai-card__img ai-card__img--hover" src="${hoverImg}" alt="${(product.title || '').replace(/"/g, '&quot;')}" loading="lazy" />` : ''}
        </a>
      </div>
      <div class="ai-card__info">
        ${product.vendor ? `<div class="ai-card__vendor">${product.vendor}</div>` : ''}
        <a href="/products/${product.handle}" class="ai-card__title">${product.title}</a>
        <div class="ai-card__price-wrapper">
          <span class="ai-card__price ${priceInfo?.isSale ? 'ai-card__price--sale' : ''}">
            ${priceInfo?.formattedPrice || ''}
          </span>
          ${priceInfo?.isSale && priceInfo?.formattedCompareAtPrice ? `<span class="ai-card__compare-price">${priceInfo.formattedCompareAtPrice}</span>` : ''}
        </div>
        <form action="/cart/add" method="post" style="margin-top: auto;">
          <input type="hidden" name="id" value="${product.defaultVariantId || ''}" />
          <button type="submit" class="ai-card__btn" ${!isAvailable ? 'disabled' : ''}>
            ${isAvailable ? 'Add to cart' : 'Sold out'}
          </button>
        </form>
      </div>
    </div>
  `;
}

const inlineCss = `
  .ai-product-container { width: 100%; max-width: 1200px; margin: 0 auto; padding: 32px 16px; box-sizing: border-box; }
  .ai-product-header { font-size: 24px; margin: 0 0 6px 0; font-weight: 700; color: #1a1a1a; width: 100%; box-sizing: border-box; }
  .ai-product-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 20px; margin: 24px 0; width: 100%; max-width: 100%; box-sizing: border-box; }
  @media (max-width: 749px) { .ai-product-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  .ai-card { position: relative; border: 1px solid #e8e8e8; border-radius: 8px; overflow: hidden; background: #fff; transition: transform 0.2s ease, box-shadow 0.2s ease; display: flex; flex-direction: column; width: 100%; box-sizing: border-box; }
  .ai-card:hover { transform: translateY(-4px); box-shadow: 0 8px 24px rgba(0,0,0,0.08); }
  .ai-card__media { position: relative; width: 100%; padding-bottom: 100%; background: #f4f4f4; overflow: hidden; }
  .ai-card__img { position: absolute; top: 0; left: 0; width: 100%; height: 100%; object-fit: cover; transition: opacity 0.3s ease; }
  .ai-card__img--hover { opacity: 0; }
  .ai-card:hover .ai-card__img--hover { opacity: 1; }
  .ai-badge { position: absolute; top: 10px; left: 10px; padding: 4px 8px; font-size: 11px; font-weight: 700; border-radius: 4px; text-transform: uppercase; z-index: 2; }
  .ai-badge--sale { background: #d72c0d; color: #fff; }
  .ai-badge--soldout { background: #4a4a4a; color: #fff; }
  .ai-card__info { padding: 14px; display: flex; flex-direction: column; flex-grow: 1; }
  .ai-card__vendor { font-size: 11px; color: #6d7175; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; }
  .ai-card__title { font-size: 14px; font-weight: 600; color: #1a1a1a; text-decoration: none; line-height: 1.4; margin-bottom: 8px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .ai-card__title:hover { color: #008060; }
  .ai-card__price-wrapper { display: flex; align-items: baseline; gap: 8px; margin-bottom: 12px; margin-top: auto; }
  .ai-card__price { font-size: 15px; font-weight: 700; color: #1a1a1a; }
  .ai-card__price--sale { color: #d72c0d; }
  .ai-card__compare-price { font-size: 13px; color: #6d7175; text-decoration: line-through; }
  .ai-card__btn { width: 100%; padding: 10px; background: #1a1a1a; color: #fff; border: none; border-radius: 6px; font-size: 13px; font-weight: 600; cursor: pointer; transition: background 0.2s ease; }
  .ai-card__btn:hover { background: #008060; }
  .ai-card__btn:disabled { background: #e3e3e3; color: #8c9196; cursor: not-allowed; }
  .ai-pagination { display: flex; align-items: center; justify-content: center; gap: 8px; margin: 32px 0; }
  .ai-pagination__btn { display: inline-flex; align-items: center; justify-content: center; min-width: 40px; height: 40px; padding: 0 12px; border: 1px solid #e8e8e8; border-radius: 6px; background: #fff; color: #1a1a1a; font-size: 14px; font-weight: 600; cursor: pointer; text-decoration: none; }
  .ai-pagination__btn--active { background: #1a1a1a; color: #fff; border-color: #1a1a1a; }
`;

const htmlContent = `
  <style>${inlineCss}</style>

  <div class="ai-product-container">
    <h1 class="ai-product-header">Kết quả tìm kiếm cho: "${query.replace(/"/g, '&quot;')}"</h1>
    <p style="color: #666; margin-bottom: 24px;">Tổng sản phẩm tìm thấy: ${totalProducts}</p>

    <div id="ai-product-grid" class="ai-product-grid">
      ${page1Products.map(renderCard).join("")}
    </div>

    ${totalPages > 1 ? `
      <div id="ai-pagination" class="ai-pagination">
        ${Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => `
          <button type="button" data-page="${p}" class="ai-pagination__btn ${p === 1 ? 'ai-pagination__btn--active' : ''}">
            ${p}
          </button>
        `).join("")}
      </div>
    ` : ""}
  </div>

  <script>
    window.__BUYENSE_CACHE__ = {
      query: ${JSON.stringify(query)},
      allIds: ${JSON.stringify(allIds)},
      pageSize: ${dynamicPageSize},
      totalPages: ${totalPages},
      pages: {
        1: ${JSON.stringify(page1Products)}
      }
    };
  </script>
`;

  return {
    html: htmlContent,
    pageSize: dynamicPageSize,
    totalProducts,
    totalPages,
    page1Products,
  };
}
