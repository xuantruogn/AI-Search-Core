import type { LoaderFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";
import db from "../db.server";
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
// PERSISTENT SQLITE CACHE FOR THEME PREFLIGHT
// ==========================================

export async function clearShopThemeCache(shop: string) {
  try {
    await db.shopThemeConfig.deleteMany({
      where: { shop },
    });
  } catch (error) {
    console.error(`[AI Search] Clear SQLite theme cache failed for shop ${shop}:`, error);
  }
}

async function getCachedThemePreflight(admin: any, shop: string) {
  // BƯỚC 1: Truy vấn trực tiếp từ SQLite (chỉ mất ~2ms)
  try {
    const existingConfig = await db.shopThemeConfig.findUnique({
      where: { shop },
    });

    if (existingConfig) {
      return {
        activeTheme: JSON.parse(existingConfig.activeThemeJson) as ActiveTheme,
        preflightMap: JSON.parse(existingConfig.themeMapJson) as ThemeMap,
        fromCache: true,
        embedEnabled: existingConfig.appEmbedEnabled,
        reason: existingConfig.appEmbedEnabled ? null : "APP_EMBED_DISABLED",
      };
    }
  } catch (dbError) {
    console.warn("[AI Search] SQLite Theme Cache read miss, fallback to API query:", dbError);
  }

  // BƯỚC 2: Nếu chưa có trong SQLite (Lần đầu tiên/Sau khi Sync Theme), mới gọi Shopify Admin API
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

  // BƯỚC 3: Lưu thẳng kết quả vào SQLite để sử dụng vĩnh viễn cho tất cả lượt tìm kiếm sau
  try {
    await db.shopThemeConfig.upsert({
      where: { shop },
      update: {
        themeId: String(activeTheme.id),
        appEmbedEnabled: true,
        activeThemeJson: JSON.stringify(activeTheme),
        themeMapJson: JSON.stringify(preflightMap),
        updatedAt: new Date(),
      },
      create: {
        shop,
        themeId: String(activeTheme.id),
        appEmbedEnabled: true,
        activeThemeJson: JSON.stringify(activeTheme),
        themeMapJson: JSON.stringify(preflightMap),
      },
    });
  } catch (dbSaveError) {
    console.error("[AI Search] Failed to write theme preflight map to SQLite:", dbSaveError);
  }

  return {
    activeTheme,
    preflightMap,
    fromCache: false,
    embedEnabled: true,
    reason: null,
  };
}

// ==========================================
// LOGIC PHÂN TRANG ĐỘNG
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
  const totalProducts = products.length;

  const totalPages =
    totalProducts > 0
      ? Math.ceil(totalProducts / pageSize)
      : 0;

  const currentPage =
    Number.isInteger(page) && page >= 1
      ? page
      : 1;

  const offset = (currentPage - 1) * pageSize;

  const pageProducts = products.slice(offset, offset + pageSize);

  const productTerms = pageProducts
    .map((product) => product?.id)
    .filter(Boolean)
    .map((id) => `id:${id}`);

  const targetIds =
    productTerms.length > 0
      ? productTerms.join(" OR ")
      : "id:0";

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
  const cachedIdsRaw = requestUrl.searchParams.get("cached_ids"); // Client gửi dữ liệu ID đã lưu từ SessionStorage lên

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
      return nativeRedirect(
        query,
        nativeSearchTarget,
        "JSON_RUNTIME_REQUIRED",
      );

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

    // BƯỚC 1: Theme Preflight Check (Đọc từ SQLite)
    console.time("[PERF-PROXY] 1. Theme Preflight (SQLite)");
    let preflightMap: ThemeMap;
    try {
      const themePreflight = await getCachedThemePreflight(
        admin,
        session.shop,
      );

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

      if (
        clientThemeId && clientFingerprint &&
        (clientThemeId !== preflightMap.theme.id || clientFingerprint !== preflightMap.fingerprint)
      ) {
        await clearShopThemeCache(session.shop);
        return Response.json(
          {
            status: "theme_map_refreshed",
            reason: "STOREFRONT_THEME_MAP_STALE",
            theme_map: preflightMap,
          },
          { headers: { "Cache-Control": "no-store" } }
        );
      }
    } catch (error) {
      return fallback("THEME_MAP_UNAVAILABLE");
    } finally {
      console.timeEnd("[PERF-PROXY] 1. Theme Preflight (SQLite)");
    }

    // Xác định Page Size
    const clientPageSize = Number.parseInt(
      requestUrl.searchParams.get("page_size") || "",
      10,
    );
    const pageSize =
      Number.isSafeInteger(clientPageSize) && clientPageSize > 0
        ? clientPageSize
        : entitlement.resultLimit;

    // =========================================================================
    // TRƯỜNG HỢP 1: CLIENT GỬI CACHED_IDS (NEXT TRANG / BỎ QUA SEARCH ENGINE)
    // =========================================================================
    if (cachedIdsRaw) {
      try {
        const cachedProducts: CandidateProduct[] = JSON.parse(cachedIdsRaw);

        if (Array.isArray(cachedProducts) && cachedProducts.length > 0) {
          console.log(
            `[AI Search] Next trang ${requestedPage} dung Session Cache Client (${cachedProducts.length} items) - SKIP OpenAI & Qdrant!`,
          );

          const pagination = buildShopifyProductQuery(
            cachedProducts,
            requestedPage,
            pageSize,
          );

          return Response.json(
            {
              status: "success",
              engine: "client-session-cache",
              query,
              theme_id: preflightMap.theme.id,
              map_fingerprint: preflightMap.fingerprint,
              target_ids: pagination.targetIds,
              products: pagination.pageProducts,
              all_products: cachedProducts, // Trả lại để Client duy trì bộ nhớ
              pagination: {
                current_page: pagination.currentPage,
                page_size: pagination.pageSize,
                total_products: pagination.totalProducts,
                total_pages: pagination.totalPages,
              },
            },
            { headers: { "Cache-Control": "no-store" } },
          );
        }
      } catch (e) {
        console.warn(
          "[AI Search] Parse cached_ids bị lỗi, tự động chuyển về search mới:",
          e,
        );
      }
    }

    // =========================================================================
    // TRƯỜNG HỢP 2: TÌM TỪ KHÓA MỚI (CHẠY AI / QDRANT)
    // =========================================================================
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
      console.time("[PERF-PROXY] 2. Semantic Search (Qdrant)");

      const rawSearchResults = await semanticSearch({
        shop: session.shop,
        query,
        limit: SEARCH_LIMIT,
        onEmbeddingCreated: async (_vector) => {
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
      console.timeEnd("[PERF-PROXY] 2. Semantic Search (Qdrant)");

      if (rawSearchResults.length === 0) {
        throw new Error("NO_LIVE_AI_RESULTS");
      }

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
          all_products: allProducts, // Mảng full CandidateProduct để Client lưu vào sessionStorage
          pagination: {
            current_page: pagination.currentPage,
            page_size: pagination.pageSize,
            total_products: pagination.totalProducts,
            total_pages: pagination.totalPages,
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
          rendererSource:
            preflightMap.search.searchTemplate ?? "native-search",
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
        console.error(
          "[AI Search] Search usage rollback failed:",
          usageError,
        );
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