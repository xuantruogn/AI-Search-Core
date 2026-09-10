import type { LoaderFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";
import { getActiveThemeMap } from "../services/theme/theme-map-lifecycle.server";
import type { ThemeMap } from "../services/theme-map.server";
import { semanticSearch } from "../services/search/semantic-search.server";
import { classifySearchRequest } from "../services/search/search-request-router.server";
import {
  getActiveTheme,
  type ActiveTheme,
} from "../services/theme/theme-reader.server";
import { getAiSearchAppEmbedStatusForTheme } from "../services/theme/app-embed.server";
import { getShopEntitlement } from "../services/commerce/entitlement.server";
import { reconcileShopCommercialState } from "../services/commerce/reconciliation.server";
import { refreshShopifyAppPricingIfStale } from "../services/billing/shopify-app-pricing.server";
import {
  commitSearchUsage,
  markUsageReservationEffectApplied,
  recordFallback,
  recordQueryEmbeddingConsumed,
  reserveSearchUsage,
  rollbackSearchUsage,
  type UsageReservation,
} from "../services/commerce/usage.server";

const NATIVE_BYPASS_PARAM = "_ai_search_bypass";
const SEARCH_LIMIT = 1000;

// ==========================================
// IN-MEMORY QUERY EMBEDDING CACHE (TTL 24 HOURS)
// ==========================================
const queryEmbeddingCache = new Map<
  string,
  { embedding: number[]; timestamp: number }
>();
const EMBEDDING_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours
const EMBEDDING_QUERY_PIPELINE_VERSION = "semantic-expansion-v2";

function buildEmbeddingCacheKey(shop: string, query: string) {
  return `${EMBEDDING_QUERY_PIPELINE_VERSION}:${shop}:${query.toLowerCase().trim()}`;
}

export function getCachedQueryEmbedding(
  shop: string,
  query: string,
): number[] | null {
  const key = buildEmbeddingCacheKey(shop, query);
  const cached = queryEmbeddingCache.get(key);
  if (cached && Date.now() - cached.timestamp < EMBEDDING_CACHE_TTL) {
    return cached.embedding;
  }
  return null;
}

export function setCachedQueryEmbedding(
  shop: string,
  query: string,
  embedding: number[],
) {
  const key = buildEmbeddingCacheKey(shop, query);
  if (queryEmbeddingCache.size > 10000) {
    const oldestKey = queryEmbeddingCache.keys().next().value;
    if (oldestKey) queryEmbeddingCache.delete(oldestKey);
  }
  queryEmbeddingCache.set(key, { embedding, timestamp: Date.now() });
}

// ==========================================
// HELPER FUNCTIONS
// ==========================================

function nativeSearchUrl(query: string, requestedUrl?: string | null) {
  if (
    requestedUrl &&
    requestedUrl.startsWith("/") &&
    !requestedUrl.startsWith("//") &&
    !requestedUrl.includes("..")
  ) {
    try {
      const parsed = new URL(requestedUrl, "https://shop.invalid");
      if (/\/search\/?$/i.test(parsed.pathname)) {
        parsed.searchParams.set("q", query);
        parsed.searchParams.set(NATIVE_BYPASS_PARAM, "1");
        return `${parsed.pathname}${parsed.search}`;
      }
    } catch {
      // Fall through to canonical Shopify search.
    }
  }

  const params = new URLSearchParams();
  params.set("q", query);
  params.set(NATIVE_BYPASS_PARAM, "1");
  return `/search?${params.toString()}`;
}

function nativeRedirectResponse(
  query: string,
  requestedUrl?: string | null,
  reason = "NATIVE_SEARCH",
) {
  return new Response(null, {
    status: 302,
    headers: {
      Location: nativeSearchUrl(query, requestedUrl),
      "Cache-Control": "no-store",
      "X-AI-Search-Fallback": "native-redirect",
      "X-AI-Search-Route": reason,
    },
  });
}

function readPositiveInteger(name: string, fallback: number) {
  const value = Number.parseInt(process.env[name] || "", 10);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

const MAX_QUERY_CHARS = readPositiveInteger("AI_SEARCH_MAX_QUERY_CHARS", 500);
const MIN_SEMANTIC_QUERY_CHARS = readPositiveInteger(
  "AI_SEARCH_MIN_SEMANTIC_QUERY_CHARS",
  3,
);

// ==========================================
// IN-MEMORY CACHE FOR THEME PREFLIGHT (TTL 60s)
// ==========================================
interface CachedThemeData {
  activeTheme: ActiveTheme;
  preflightMap: ThemeMap;
  timestamp: number;
}

const themeCache = new Map<string, CachedThemeData>();
const THEME_CACHE_TTL_MS = 60 * 1000; // 60 seconds

// Hàm xóa RAM cache khi người dùng bấm Sync Theme trên Admin Dashboard
export function clearShopThemeCache(shop: string) {
  themeCache.delete(shop);
}

async function getCachedThemePreflight(admin: any, shop: string) {
  const cached = themeCache.get(shop);
  const now = Date.now();

  if (cached && now - cached.timestamp < THEME_CACHE_TTL_MS) {
    return {
      activeTheme: cached.activeTheme,
      preflightMap: cached.preflightMap,
      fromCache: true,
      embedEnabled: true,
      reason: null,
    };
  }

  const activeTheme = await getActiveTheme(admin);
  const appEmbed = await getAiSearchAppEmbedStatusForTheme(admin, activeTheme);

  if (appEmbed.enabled !== true) {
    return {
      activeTheme,
      preflightMap: null,
      fromCache: false,
      embedEnabled: false,
      reason: appEmbed.reason,
    };
  }

  const preflightMap = await getActiveThemeMap({
    admin,
    shop,
    activeTheme,
  });

  themeCache.set(shop, { activeTheme, preflightMap, timestamp: now });
  return {
    activeTheme,
    preflightMap,
    fromCache: false,
    embedEnabled: true,
    reason: null,
  };
}

// ==========================================
// KẾ THỪA LOGIC PHÂN TRANG ĐỘNG TỪ SEARCH.TSX
// ==========================================
type CandidateProduct = {
  id: string;
  handle?: string;
};

type PaginationResult = {
  totalProducts: number;
  totalPages: number;
  currentPage: number;
  pageSize: number;
  targetIds: string;
  pageProducts: CandidateProduct[];
};

function buildShopifyProductQuery(
  products: CandidateProduct[],
  page: number,
  pageSize: number,
): PaginationResult {
  const totalProducts = products.length; // Kế thừa totalProducts từ độ dài thực tế[cite: 12]

  const totalPages =
    totalProducts > 0
      ? Math.ceil(totalProducts / pageSize) // Kế thừa công thức tính tổng số trang[cite: 12]
      : 0;

  const currentPage =
    Number.isInteger(page) && page >= 1
      ? page // Kế thừa kiểm tra số trang hợp lệ[cite: 12]
      : 1;

  const offset = (currentPage - 1) * pageSize; // Kế thừa cách tính vị trí cắt mảng[cite: 12]

  const pageProducts = products.slice(offset, offset + pageSize); // Kế thừa việc cắt mảng theo offset và pageSize[cite: 12]

  const productTerms = pageProducts
    .map((product) => product?.id)
    .filter(Boolean)
    .map((id) => `id:${id}`); // Kế thừa việc tạo mảng ID[cite: 12]

  const targetIds =
    productTerms.length > 0
      ? productTerms.join(" OR ") // Kế thừa việc ghép chuỗi "id:1 OR id:2"[cite: 12]
      : "id:0"; // Kế thừa việc fallback về "id:0" khi trống[cite: 12]

  return {
    totalProducts,
    totalPages,
    currentPage,
    pageSize,
    targetIds,
    pageProducts,
  };
}

// ==========================================
// LOADER
// ==========================================

export const loader = async ({ request }: LoaderFunctionArgs) => {
  console.time("[PERF-PROXY] TOTAL PROXY REQUEST");
  const requestUrl = new URL(request.url);
  const query = requestUrl.searchParams.get("q")?.trim() ?? "";
  const nativeSearchTarget =
    requestUrl.searchParams.get("native_search_url") ??
    requestUrl.searchParams.get("native_search_path");

  const wantsJson = requestUrl.searchParams.get("format") === "json";
  const requestedPageRaw = Number.parseInt(
    requestUrl.searchParams.get("page") || "1",
    10,
  );
  const requestedPage =
    Number.isSafeInteger(requestedPageRaw) && requestedPageRaw > 0
      ? requestedPageRaw
      : 1;

  const nativeRedirect = (
    value: string,
    target?: string | null,
    reason = "NATIVE_SEARCH",
  ) =>
    wantsJson
      ? Response.json(
          {
            status: "fallback",
            engine: "native",
            reason,
            native_url: nativeSearchUrl(value, target),
          },
          { headers: { "Cache-Control": "no-store" } },
        )
      : nativeRedirectResponse(value, target, reason);

  try {
    const { admin, session } = await authenticate.public.appProxy(request);

    if (!admin || !session) {
      return nativeRedirect(
        query,
        nativeSearchTarget,
        "APP_PROXY_SESSION_MISSING",
      );
    }

    if (wantsJson && requestUrl.searchParams.get("mode") === "theme-map") {
      console.time("[PERF-PROXY] Mode Theme-Map Processing");
      const theme = await getActiveTheme(admin);
      const embed = await getAiSearchAppEmbedStatusForTheme(admin, theme);
      if (embed.enabled !== true)
        return nativeRedirect(
          query,
          nativeSearchTarget,
          "APP_EMBED_DISABLED_ON_ACTIVE_THEME",
        );
      const map = await getActiveThemeMap({
        admin,
        shop: session.shop,
        activeTheme: theme,
      });
      console.timeEnd("[PERF-PROXY] Mode Theme-Map Processing");
      return Response.json(
        { status: "success", theme_map: map },
        { headers: { "Cache-Control": "no-store" } },
      );
    }

    if (!wantsJson)
      return nativeRedirect(query, nativeSearchTarget, "JSON_RUNTIME_REQUIRED");

    const routeDecision = classifySearchRequest({
      query,
      nativeSearchTarget,
      maxQueryChars: MAX_QUERY_CHARS,
      minSemanticQueryChars: MIN_SEMANTIC_QUERY_CHARS,
    });

    if (routeDecision.engine === "NATIVE") {
      return nativeRedirect(query, nativeSearchTarget, routeDecision.reason);
    }

    // Billing Check & Reconciliation
    console.time("[PERF-PROXY] Billing Check & Reconciliation");
    let billingChanged = false;
    try {
      const billing = await refreshShopifyAppPricingIfStale({
        shop: session.shop,
        admin,
      });
      billingChanged = billing.changed;
    } catch (error) {
      console.error("[AI Search] Storefront billing refresh failed:", {
        shop: session.shop,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    if (billingChanged) {
      void reconcileShopCommercialState({
        shop: session.shop,
        forceCatalogRefresh: true,
      }).catch((error) => {
        console.error(
          "[AI Search] Storefront plan reconciliation failed:",
          error,
        );
      });
    }
    console.timeEnd("[PERF-PROXY] Billing Check & Reconciliation");

    console.time("[PERF-PROXY] Entitlement Check");
    const entitlement = await getShopEntitlement(session.shop);
    console.timeEnd("[PERF-PROXY] Entitlement Check");

    const fallback = async (reason: string) => {
      try {
        await recordFallback({
          shop: session.shop,
          periodId: entitlement.usage.id,
          query,
          reason,
        });
      } catch (error) {
        console.error("[AI Search] Fallback usage logging failed:", error);
      }

      return nativeRedirect(query, nativeSearchTarget, reason);
    };

    if (!entitlement.searchAllowed) {
      if (
        entitlement.disabledReason === "CATALOG_STALE_QUOTA" ||
        entitlement.disabledReason === "CATALOG_STALE_SUBSCRIPTION" ||
        entitlement.disabledReason === "PRODUCT_LIMIT_RECONCILIATION_REQUIRED"
      ) {
        void reconcileShopCommercialState({ shop: session.shop }).catch(
          (error) => {
            console.error(
              "[AI Search] Entitlement reconciliation trigger failed:",
              error,
            );
          },
        );
      }

      return fallback(entitlement.disabledReason ?? "AI_SEARCH_UNAVAILABLE");
    }

    if (entitlement.indexedProducts <= 0) {
      return fallback("CATALOG_EMPTY");
    }

    // BƯỚC 1: Theme Preflight Check (In-Memory Cached)
    console.time("[PERF-PROXY] 1. Theme Preflight (Cached)");
    let preflightMap: ThemeMap;
    try {
      const themePreflight = await getCachedThemePreflight(admin, session.shop);

      if (themePreflight.embedEnabled === false) {
        return fallback(
          themePreflight.reason === "APP_EMBED_DISABLED"
            ? "APP_EMBED_DISABLED_ON_ACTIVE_THEME"
            : "APP_EMBED_STATUS_UNKNOWN",
        );
      }

      preflightMap = themePreflight.preflightMap!;

      const clientThemeId = requestUrl.searchParams.get("theme_id");
      const clientFingerprint = requestUrl.searchParams.get("map_fingerprint");

      // Nếu Client gửi Theme ID hoặc Fingerprint khác với dữ liệu hiện tại ở Server
      if (
        clientThemeId &&
        clientFingerprint &&
        (clientThemeId !== preflightMap.theme.id ||
          clientFingerprint !== preflightMap.fingerprint)
      ) {
        themeCache.delete(session.shop);
        // Trả về JSON để Storefront JS tự động làm mới LocalStorage
        return Response.json(
          {
            status: "theme_map_refreshed",
            reason: "STOREFRONT_THEME_MAP_STALE",
            theme_map: preflightMap,
          },
          { headers: { "Cache-Control": "no-store" } },
        );
      }
    } catch (error) {
      return fallback("THEME_MAP_UNAVAILABLE");
    } finally {
      console.timeEnd("[PERF-PROXY] 1. Theme Preflight (Cached)");
    }

    const reservationResult = await reserveSearchUsage({
      shop: session.shop,
      periodId: entitlement.usage.id,
      searchLimit: entitlement.limits.searchLimit,
      query,
    });

    if (!reservationResult.allowed) {
      return fallback("SEARCH_QUOTA_EXCEEDED");
    }

    const reservation: UsageReservation = reservationResult.reservation;
    const startedAt = Date.now();

    try {
      // BƯỚC 2: Semantic Search (Lấy danh sách Top kết quả)
      console.time(
        "[PERF-PROXY] 2. Semantic Search (OpenAI/Vector Cache + Qdrant)",
      );

      const cachedVector = getCachedQueryEmbedding(session.shop, query);
      if (cachedVector) {
        console.log(
          `[AI Search] Cache Hit Vector cho từ khóa: "${query}" - BỎ QUA OpenAI API!`,
        );
      }

      // 1. KẾ THỪA GIỐNG FILE SEARCH.TSX CŨ: Lấy tối đa 1000 candidates từ Qdrant

      const rawSearchResults = await semanticSearch({
        shop: session.shop,
        query,
        vectorOverride: cachedVector ?? undefined,
        limit: SEARCH_LIMIT, // Lấy toàn bộ kết quả phù hợp (up to 1000)
        onEmbeddingCreated: async (vector, metadata) => {
          if (vector && metadata.cacheable) {
            setCachedQueryEmbedding(session.shop, query, vector);
          }
          try {
            await recordQueryEmbeddingConsumed(reservation);
          } catch (usageError) {
            console.error(
              "[AI Search] Query embedding usage logging failed:",
              usageError,
            );
          }
        },
      });
      console.timeEnd(
        "[PERF-PROXY] 2. Semantic Search (OpenAI/Vector Cache + Qdrant)",
      );

      // Lọc trùng ID để có danh sách candidate thực tế
      const seen = new Set<string>();
      const allProducts: CandidateProduct[] = rawSearchResults.flatMap(
        (result) => {
          const id =
            result.productId.match(
              /^(?:gid:\/\/shopify\/Product\/)?(\d+)$/,
            )?.[1] || result.productId;
          if (!id) return [];
          if (seen.has(id)) return [];
          seen.add(id);
          return [{ id, handle: result.handle }];
        },
      );

      // 2. PHÂN TRANG ĐỘNG HOÀN TOÀN:
      // Lấy pageSize từ client gửi lên (nếu có), nếu không có thì lấy mặc định theo cài đặt shop.
      // Không khống chế hay giới hạn tổng số trang nữa!
      const clientPageSize = Number.parseInt(
        requestUrl.searchParams.get("page_size") || "",
        10,
      );
      const pageSize =
        Number.isSafeInteger(clientPageSize) && clientPageSize > 0
          ? clientPageSize
          : entitlement.resultLimit;

      // Kế thừa nguyên vẹn hàm buildShopifyProductQuery từ search.tsx
      // totalProducts = allProducts.length (số sp thực tế)
      // totalPages = Math.ceil(totalProducts / pageSize) (số trang tính động hoàn toàn)
      const pagination = buildShopifyProductQuery(
        allProducts,
        requestedPage,
        pageSize,
      );

      const response = Response.json(
        {
          status: "success",
          engine: "ai-search-v3",
          query,
          theme_id: preflightMap.theme.id,
          map_fingerprint: preflightMap.fingerprint,
          target_ids: pagination.targetIds,
          products: pagination.pageProducts,
          all_products: allProducts, // Trả về toàn bộ danh sách ID tìm được
          pagination: {
            current_page: pagination.currentPage,
            page_size: pagination.pageSize,
            total_products: pagination.totalProducts, // Tổng sản phẩm thực tế
            total_pages: pagination.totalPages, // Tổng số trang tính động hoàn toàn
          },
        },
        { headers: { "Cache-Control": "no-store" } },
      );

      try {
        await markUsageReservationEffectApplied(reservation);
      } catch (usageError) {
        console.error(
          "[AI Search] Search reservation effect marker failed:",
          usageError,
        );
      }

      try {
        await commitSearchUsage(reservation, {
          resultCount: rawSearchResults.length,
          durationMs: Date.now() - startedAt,
          themeId: preflightMap.theme.gid,
          rendererSource: preflightMap.search.searchTemplate ?? "native-search",
        });
      } catch (usageError) {
        console.error(
          "[AI Search] Search usage commit logging failed:",
          usageError,
        );
      }

      return response;
    } catch (error) {
      console.error(
        "[AI Search] AI execution failed; using Shopify native search:",
        {
          shop: session.shop,
          error: error instanceof Error ? error.message : String(error),
        },
      );

      try {
        await rollbackSearchUsage(reservation, error);
      } catch (usageError) {
        console.error("[AI Search] Search usage rollback failed:", usageError);
      }

      return fallback("AI_SEARCH_RUNTIME_ERROR");
    }
  } catch (error) {
    console.error("[AI Search] App Proxy fatal error; native fallback:", {
      error: error instanceof Error ? error.message : String(error),
    });

    return nativeRedirect(query, nativeSearchTarget, "APP_PROXY_FATAL_ERROR");
  } finally {
    console.timeEnd("[PERF-PROXY] TOTAL PROXY REQUEST");
  }
};
