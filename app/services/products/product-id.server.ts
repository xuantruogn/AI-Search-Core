// =====================================================
// SHOPIFY PRODUCT ID NORMALIZATION
//
// Webhook payload thường dùng numeric ID trong khi Admin GraphQL dùng GID.
// Giữ utility này độc lập với Qdrant/OpenAI để enqueue webhook không phải
// load toàn bộ search stack chỉ để chuẩn hóa ID.
// =====================================================

const SHOPIFY_PRODUCT_GID_PREFIX = "gid://shopify/Product/";

export function normalizeProductGid(productId: string | number): string {
  const raw = String(productId).trim();

  if (!raw) {
    throw new Error("Product ID cannot be empty");
  }

  if (raw.startsWith(SHOPIFY_PRODUCT_GID_PREFIX)) {
    const numericId = raw.slice(SHOPIFY_PRODUCT_GID_PREFIX.length);

    if (!/^\d+$/.test(numericId)) {
      throw new Error(`Invalid Shopify product ID: ${raw}`);
    }

    return raw;
  }

  if (!/^\d+$/.test(raw)) {
    throw new Error(`Invalid Shopify product ID: ${raw}`);
  }

  return `${SHOPIFY_PRODUCT_GID_PREFIX}${raw}`;
}
