/** Only result-changing filters belong in a storefront cache key. */
const SEARCH_CACHE_IGNORED_PARAMS = new Set([
  "q",
  "page",
  "receipt",
  "format",
  "mode",
  "theme_id",
  "map_fingerprint",
  "native_search_url",
  "native_search_path",
  "section_id",
  "ids",
  // Shopify App Proxy adds signed transport metadata on each request.
  // These values are already authenticated by the proxy/session layer and
  // must not split the same shop+query result into a new cache key every time.
  "shop",
  "timestamp",
  "signature",
  "hmac",
  "path_prefix",
  "logged_in_customer_id",
  "host",
  // Client transport/cache-busting values do not change search semantics.
  "_",
  "_t",
  "cache_bust",
  "cacheBust",
  "request_id",
  "_ai_search_bypass",
]);

export function buildSearchCacheRequestVariant(url: URL) {
  return [...url.searchParams.entries()]
    .filter(([key]) => !SEARCH_CACHE_IGNORED_PARAMS.has(key))
    .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
      leftKey === rightKey
        ? leftValue.localeCompare(rightValue)
        : leftKey.localeCompare(rightKey),
    )
    .map(([key, value]) => encodeURIComponent(key) + "=" + encodeURIComponent(value))
    .join("&");
}

