/**
 * Shopify storefront search must only expose products that are ACTIVE and
 * already published to the Online Store. A non-null future publishedAt means
 * scheduled publishing, not current visibility.
 */
export function isSearchableOnlineStoreProduct({
  status,
  publishedAt,
  nowMs = Date.now(),
}: {
  status?: string | null;
  publishedAt?: string | null;
  nowMs?: number;
}) {
  if (String(status ?? "").trim().toUpperCase() !== "ACTIVE" || !publishedAt) {
    return false;
  }

  const publishedMs = Date.parse(publishedAt);
  return Number.isFinite(publishedMs) && publishedMs <= nowMs;
}
