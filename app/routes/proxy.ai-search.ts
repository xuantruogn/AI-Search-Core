import type { LoaderFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";
import {
  semanticSearch,
  type SemanticSearchDiagnostics,
} from "../services/search/semantic-search.server";
import { recordSearchQueryLog } from "../services/search/search-analytics.server";
import { parsePriceConstraint } from "../services/search/query-constraints.server";
import { rewriteSearchQuery } from "../services/search/query-rewriter.server";
import {
  applyShopContextToQuery,
  filterResultsByExplicitGender,
  type ExplicitGenderFilterDiagnostics,
} from "../services/search/shop-context-index.server";
import {
  filterSearchResultsByPrice,
  type SearchPriceFilterDiagnostics,
} from "../services/search/search-price-filter.server";
import { classifySearchRequest } from "../services/search/search-request-router.server";
import {
  getSearchResultPage,
  saveSearchResult,
} from "../services/search/search-result-cache.server";
import {
  buildThemeResultLiquid,
  getThemeResultRendererCandidates,
} from "../services/renderer/theme-result-renderer.server";
import {
  THEME_MAP_V4_DEFAULT_PAGE_SIZE,
  type ThemeMapV4,
  type ThemeRendererCandidate,
} from "../services/theme/theme-map-v4.types";
import {
  planThemeSearchTransportFromStoredKeys,
} from "../services/theme/theme-search-transport-key.server";
import { loadStoredThemeMapV4 } from "../services/theme/theme-map-v4-store.server";
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

import { getShopSettings } from "../services/commerce/shop-registry.server";
import {
  fetchProductsByGids as fetchAppSelfRenderProductsByGids,
  renderAppSelfSearchPage,
} from "../services/renderer/app-self-render-v3.server";

const NATIVE_BYPASS_PARAM = "_ai_search_bypass";
const SEARCH_LIMIT = 1000;

const queryEmbeddingCache = new Map<
  string,
  { embedding: number[]; timestamp: number }
>();
const EMBEDDING_CACHE_TTL = 24 * 60 * 60 * 1000;
const EMBEDDING_QUERY_PIPELINE_VERSION = "semantic-expansion-v6-general-commerce";

function buildEmbeddingCacheKey(shop: string, query: string) {
  return `${EMBEDDING_QUERY_PIPELINE_VERSION}:${shop}:${query.toLowerCase().trim()}`;
}

function getCachedQueryEmbedding(
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

function setCachedQueryEmbedding(
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
    } catch {}
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
const MIN_SEMANTIC_QUERY_CHARS = readPositiveInteger("AI_SEARCH_MIN_SEMANTIC_QUERY_CHARS", 3);

function isThemeContextTransportCandidate(candidate: ThemeRendererCandidate): boolean {
  if (candidate.renderStrategy !== "THEME_CONTEXT_REQUIRED" || candidate.mount == null || candidate.usesAllProducts) {
    return false;
  }
  return candidate.rejectionReasons.every((reason) => reason === "THEME_CONTEXT_REQUIRED");
}

function getThemeContextTransportCandidate(map: ThemeMapV4): ThemeRendererCandidate | null {
  return (
    map.rendererCandidates
      .filter(isThemeContextTransportCandidate)
      .slice()
      .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))[0] ?? null
  );
}

function themeMapSupportsSearchExecution(map: ThemeMapV4): boolean {
  return map.status === "VERIFIED" || getThemeContextTransportCandidate(map) != null;
}

function normalizeStorefrontThemeId(value: string | null | undefined): string {
  return (
    String(value ?? "").trim().match(/^(?:gid:\/\/shopify\/(?:OnlineStore)?Theme\/)?(\d+)$/)?.[1] ??
    String(value ?? "").trim()
  );
}

async function loadSyncedThemeMapForStorefront(args: {
  shop: string;
  themeId: string | null | undefined;
  fingerprint?: string | null;
}): Promise<{ ok: true; map: ThemeMapV4 } | { ok: false; reason: string }> {
  const themeId = normalizeStorefrontThemeId(args.themeId);
  if (!themeId) return { ok: false, reason: "THEME_SYNC_REQUIRED" };

  const stored = await loadStoredThemeMapV4({ shop: args.shop, themeId });
  if (!stored) return { ok: false, reason: "THEME_SYNC_REQUIRED" };

  if (args.fingerprint && args.fingerprint !== stored.fingerprint) {
    return { ok: false, reason: "THEME_SYNC_REQUIRED" };
  }

  if (!themeMapSupportsSearchExecution(stored.map)) {
    return { ok: false, reason: `THEME_MAP_V4_UNSUPPORTED:${stored.map.unsupportedReason ?? "UNKNOWN"}` };
  }

  return { ok: true, map: stored.map };
}

type CandidateProduct = {
  id: string;
  handle: string;
  rank: number;
  score: number;
};

type PaginationResult = {
  totalProducts: number;
  totalPages: number;
  currentPage: number;
  pageSize: number;
  pageProducts: CandidateProduct[];
};

function buildShopifyProductQuery(products: CandidateProduct[], page: number, pageSize: number): PaginationResult {
  const totalProducts = products.length;
  const totalPages = totalProducts > 0 ? Math.ceil(totalProducts / pageSize) : 0;
  const currentPage = Number.isInteger(page) && page >= 1 ? page : 1;
  const offset = (currentPage - 1) * pageSize;
  const pageProducts = products.slice(offset, offset + pageSize);

  return { totalProducts, totalPages, currentPage, pageSize, pageProducts };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  console.time("[PERF-PROXY] TOTAL PROXY REQUEST");
  const proxyStartedAt = Date.now();
  const requestUrl = new URL(request.url);

  const query = requestUrl.searchParams.get("q")?.trim() ?? "";
  const receiptRaw = requestUrl.searchParams.get("receipt")?.trim() || null;
  const nativeSearchTarget =
    requestUrl.searchParams.get("native_search_url") ??
    requestUrl.searchParams.get("native_search_path");

  const wantsJson = requestUrl.searchParams.get("format") === "json";
  const requestedPageRaw = Number.parseInt(requestUrl.searchParams.get("page") || "1", 10);
  const requestedPage = Number.isSafeInteger(requestedPageRaw) && requestedPageRaw > 0 ? requestedPageRaw : 1;

  const nativeRedirect = (value: string, target?: string | null, reason = "NATIVE_SEARCH") =>
    wantsJson
      ? Response.json({ status: "fallback", engine: "native", reason, native_url: nativeSearchUrl(value, target) }, { headers: { "Cache-Control": "no-store" } })
      : nativeRedirectResponse(value, target, reason);

  try {
    const { admin, session, liquid } = await authenticate.public.appProxy(request);

    if (!admin || !session) {
      // Runtime config is consumed by the storefront bridge. If the app-proxy
      // session is unavailable, fail open to the existing V4 engine.
      if (requestUrl.searchParams.get("mode") === "runtime-config") {
        return Response.json(
          { status: "fallback", engine: "v4", reason: "APP_PROXY_SESSION_MISSING" },
          { headers: { "Cache-Control": "no-store" } },
        );
      }

      return nativeRedirect(query, nativeSearchTarget, "APP_PROXY_SESSION_MISSING");
    }

    // ĐỌC CẤU HÌNH DASHBOARD DỰ ÁN
    const shopSettings = await getShopSettings(session.shop);
    const isCustomDataMode = Boolean(shopSettings.customDataModeEnabled);

    // =====================================================================
    // STOREFRONT ENGINE BOOTSTRAP
    // Chỉ đọc cờ Dashboard. Không chạy Search, Qdrant hay Theme Map V4.
    // Bridge dùng endpoint này để quyết định nạp V3 hay V4.
    // =====================================================================
    if (requestUrl.searchParams.get("mode") === "runtime-config") {
      return Response.json(
        {
          status: "success",
          engine: isCustomDataMode ? "v3" : "v4",
          customDataModeEnabled: isCustomDataMode,
        },
        {
          headers: {
            "Cache-Control": "no-store",
          },
        },
      );
    }

    // === LỌC REQUEST PHỤ & PHÂN TRANG AJAX KHI Ở DEDICATED MODE ===
    if (isCustomDataMode) {
      const hasSectionId = requestUrl.searchParams.has("section_id") || requestUrl.searchParams.has("sections");
      const isPredictive = requestUrl.pathname.includes("predictive") || requestUrl.searchParams.has("predictive");

      if (hasSectionId || isPredictive) {
        if (wantsJson) return Response.json({}, { status: 200, headers: { "Cache-Control": "no-store" } });
        return new Response("", { status: 200, headers: { "Content-Type": "application/liquid; charset=utf-8" } });
      }

      const idsParam = requestUrl.searchParams.get("ids");
      if (wantsJson && idsParam) {
        const rawIds = idsParam.split(",").map((i) => i.trim()).filter(Boolean);
        try {
          const gids = rawIds.map((id) => (id.startsWith("gid://") ? id : `gid://shopify/Product/${id}`));
          const products = await fetchAppSelfRenderProductsByGids(admin, gids);
          return Response.json({ status: "success", products }, { headers: { "Cache-Control": "no-store" } });
        } catch (e) {
          return Response.json({ status: "error", products: [] }, { status: 200 });
        }
      }
    }

    // === CÁC MODE CỦA THEME SYNC V4 CŨ ===
    if (requestUrl.searchParams.get("mode") === "transport-v4") {
      if (process.env.AI_SEARCH_THEME_MAP_V4 !== "true") {
        return Response.json({ status: "disabled", feature: "theme-context-transport-v4", reason: "THEME_MAP_V4_DISABLED" }, { status: 404, headers: { "Cache-Control": "no-store" } });
      }
      const receiptId = receiptRaw ?? "";
      if (!/^srch_[A-Za-z0-9_-]+$/.test(receiptId)) {
        return Response.json({ status: "error", reason: "INVALID_SEARCH_RECEIPT" }, { status: 400, headers: { "Cache-Control": "no-store" } });
      }
      const cachedPage = await getSearchResultPage({ shop: session.shop, receiptId, page: requestedPage, pageSize: THEME_MAP_V4_DEFAULT_PAGE_SIZE });
      if (!cachedPage) {
        return Response.json({ status: "error", reason: "SEARCH_RECEIPT_EXPIRED_OR_INVALID" }, { status: 410, headers: { "Cache-Control": "no-store" } });
      }
      const storedTheme = await loadSyncedThemeMapForStorefront({ shop: session.shop, themeId: requestUrl.searchParams.get("theme_id"), fingerprint: requestUrl.searchParams.get("map_fingerprint") });
      if (storedTheme.ok === false) {
        return Response.json({ status: "sync_required", reason: storedTheme.reason }, { status: 409, headers: { "Cache-Control": "no-store" } });
      }
      const map = storedTheme.map;
      const candidate = getThemeContextTransportCandidate(map);
      if (!candidate || !candidate.mount) {
        return Response.json({ status: "unsupported", reason: "THEME_CONTEXT_TRANSPORT_CANDIDATE_NOT_FOUND", theme_id: map.theme.id, map_status: map.status, map_fingerprint: map.fingerprint }, { status: 409, headers: { "Cache-Control": "no-store" } });
      }
      const targetProductIds = cachedPage.products.map((product) => product.productId);
      const transportPlan = await planThemeSearchTransportFromStoredKeys({ shop: session.shop, productIds: targetProductIds });
      if (!transportPlan.safeToRender) {
        return Response.json({ status: "unsafe", engine: "theme-context-transport-v4", render_strategy: "THEME_CONTEXT_REQUIRED", reason: "TRANSPORT_PLAN_UNSAFE", theme_id: map.theme.id, map_fingerprint: map.fingerprint, candidate_id: candidate.id, mount: candidate.mount, target_product_ids: transportPlan.targetProductIds, unresolved: transportPlan.unresolved, batches: transportPlan.batches, pagination: { current_page: cachedPage.page, page_size: cachedPage.pageSize, total_products: cachedPage.totalProducts, total_pages: cachedPage.totalPages } }, { status: 409, headers: { "Cache-Control": "no-store" } });
      }
      return Response.json({ status: "success", engine: "theme-context-transport-v4", render_strategy: "THEME_CONTEXT_REQUIRED", theme_id: map.theme.id, map_fingerprint: map.fingerprint, receipt: cachedPage.result.receiptId, search_log_id: cachedPage.result.searchLogId, candidate: { id: candidate.id, type: candidate.type, source_file: candidate.sourceFile }, mount: candidate.mount, search_section: { template_file: map.search.templateFile, template_type: map.search.templateType, section_key: map.search.sectionKey ?? null, section_type: map.search.sectionType ?? null, section_file: map.search.sectionFile ?? null }, safeToRender: true, targetProductIds: transportPlan.targetProductIds, resolved: transportPlan.resolved, unresolved: transportPlan.unresolved, batches: transportPlan.batches, pagination: { current_page: cachedPage.page, page_size: cachedPage.pageSize, total_products: cachedPage.totalProducts, total_pages: cachedPage.totalPages } }, { headers: { "Cache-Control": "no-store" } });
    }

    if (requestUrl.searchParams.get("mode") === "render-v4") {
      const receiptId = receiptRaw ?? "";
      if (!/^srch_[A-Za-z0-9_-]+$/.test(receiptId)) return new Response("INVALID_SEARCH_RECEIPT", { status: 400, headers: { "Cache-Control": "no-store" } });
      const candidateId = requestUrl.searchParams.get("candidate_id")?.trim() || undefined;
      const cachedPage = await getSearchResultPage({ shop: session.shop, receiptId, page: requestedPage, pageSize: THEME_MAP_V4_DEFAULT_PAGE_SIZE });
      if (!cachedPage) return new Response("SEARCH_RECEIPT_EXPIRED_OR_INVALID", { status: 410, headers: { "Cache-Control": "no-store" } });
      const pageProducts = cachedPage.products.map((product) => ({ productId: product.productId, handle: product.handle }));
      const storedTheme = await loadSyncedThemeMapForStorefront({ shop: session.shop, themeId: requestUrl.searchParams.get("theme_id"), fingerprint: requestUrl.searchParams.get("map_fingerprint") });
      if (storedTheme.ok === false) return new Response(storedTheme.reason, { status: 409, headers: { "Cache-Control": "no-store" } });
      const map = storedTheme.map;
      if (map.status !== "VERIFIED") return new Response(`THEME_MAP_UNSUPPORTED:${map.unsupportedReason}`, { status: 409, headers: { "Cache-Control": "no-store" } });

      try {
        const renderPlan = buildThemeResultLiquid({ map, products: pageProducts, candidateId });
        const renderMeta = encodeURIComponent(JSON.stringify({ version: 4, themeId: map.theme.id, fingerprint: map.fingerprint, receipt: cachedPage.result.receiptId, searchLogId: cachedPage.result.searchLogId, page: cachedPage.page, pageSize: cachedPage.pageSize, totalProducts: cachedPage.totalProducts, totalPages: cachedPage.totalPages, candidateId: renderPlan.candidateId, runtimeMode: renderPlan.candidate.runtime.mode, mount: renderPlan.mount, candidateIds: getThemeResultRendererCandidates(map).map((c) => c.id), products: pageProducts }));
        const renderLiquid = [`<script type="application/json" data-ai-search-render-meta>${renderMeta}</script>`, renderPlan.liquid].join("\n");
        return liquid(renderLiquid, { layout: false, headers: { "Cache-Control": "no-store", "X-AI-Search-Render-Version": "4", "X-AI-Search-Render-Meta": renderMeta } });
      } catch (error) {
        return new Response("THEME_RENDER_V4_FAILED", { status: 422, headers: { "Cache-Control": "no-store" } });
      }
    }

    if (wantsJson && requestUrl.searchParams.get("mode") === "theme-map-v4") {
      const storedTheme = await loadSyncedThemeMapForStorefront({ shop: session.shop, themeId: requestUrl.searchParams.get("theme_id"), fingerprint: requestUrl.searchParams.get("map_fingerprint") });
      if (storedTheme.ok === false) return Response.json({ status: "sync_required", reason: storedTheme.reason }, { status: 409, headers: { "Cache-Control": "no-store" } });
      return Response.json({ status: "success", theme_map: storedTheme.map }, { headers: { "Cache-Control": "no-store" } });
    }

    // === CHỈ CHẠY ROUTE NATIVE / FORMAT JSON CHO LUỒNG V4 CŨ ===
    if (!isCustomDataMode) {
      if (!wantsJson) {
        return nativeRedirect(query, nativeSearchTarget, "JSON_RUNTIME_REQUIRED");
      }

      const routeDecision = classifySearchRequest({ query, nativeSearchTarget, maxQueryChars: MAX_QUERY_CHARS, minSemanticQueryChars: MIN_SEMANTIC_QUERY_CHARS });
      if (routeDecision.engine === "NATIVE") {
        return nativeRedirect(query, nativeSearchTarget, routeDecision.reason);
      }
    }

    // BILLING & ENTITLEMENT CHECK
    try {
      const billing = await refreshShopifyAppPricingIfStale({ shop: session.shop, admin });
      if (billing.changed) {
        void reconcileShopCommercialState({ shop: session.shop, forceCatalogRefresh: true }).catch(() => {});
      }
    } catch (error) {}

    const entitlement = await getShopEntitlement(session.shop);

    const fallback = async (reason: string) => {
      try {
        await recordFallback({ shop: session.shop, periodId: entitlement.usage.id, query, reason });
      } catch (error) {}
      return nativeRedirect(query, nativeSearchTarget, reason);
    };

    if (!entitlement.searchAllowed) {
      return fallback(entitlement.disabledReason ?? "AI_SEARCH_UNAVAILABLE");
    }

    if (entitlement.indexedProducts <= 0) {
      return fallback("CATALOG_EMPTY");
    }

    let preflightMap = {
      theme: { id: "custom_mode", gid: "gid://shopify/Theme/custom_mode" },
      fingerprint: "custom_mode",
      search: { searchTemplate: "custom-data-api" },
    };

    if (!isCustomDataMode) {
      const storedTheme = await loadSyncedThemeMapForStorefront({ shop: session.shop, themeId: requestUrl.searchParams.get("theme_id"), fingerprint: requestUrl.searchParams.get("map_fingerprint") });
      if (storedTheme.ok === false) {
        return fallback(storedTheme.reason);
      }
      const syncedThemeMap = storedTheme.map;
      preflightMap = {
        theme: { id: syncedThemeMap.theme.id, gid: `gid://shopify/Theme/${syncedThemeMap.theme.id}` },
        fingerprint: syncedThemeMap.fingerprint,
        search: { searchTemplate: syncedThemeMap.search.templateFile },
      };
    }

    const pageSize = THEME_MAP_V4_DEFAULT_PAGE_SIZE;

    // === CHẠY AI PIPELINE DÙNG CHUNG ===
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
    let executionPhase: "rewrite" | "semanticSearch" | "genderFilter" | "priceFilter" | "resultMapping" | "analytics" | "saveSearchResult" | "responseBuild" = "rewrite";

    try {
      const interpretedQuery = await rewriteSearchQuery({ shop: session.shop, query });
      const preparedRewrite = await applyShopContextToQuery({ shop: session.shop, originalQuery: query, rewrite: interpretedQuery });
      const sortIntent = preparedRewrite.analysis.sortIntent;

      const cachedVector = preparedRewrite.catalogRelevant ? getCachedQueryEmbedding(session.shop, preparedRewrite.query) : null;
      let queryVectorForAnalytics: number[] | null = cachedVector;
      let searchDiagnostics: SemanticSearchDiagnostics | null = null;

      executionPhase = "semanticSearch";
      const rawSearchResults = await semanticSearch({
        preparedRewrite,
        shop: session.shop,
        query,
        vectorOverride: cachedVector ?? undefined,
        limit: SEARCH_LIMIT,
        onEmbeddingCreated: async (vector, metadata) => {
          queryVectorForAnalytics = vector;
          if (vector && metadata.cacheable) {
            setCachedQueryEmbedding(session.shop, preparedRewrite.query, vector);
          }
          try { await recordQueryEmbeddingConsumed(reservation); } catch (e) {}
        },
        onDiagnostics: (diagnostics) => { searchDiagnostics = diagnostics; },
      });

      executionPhase = "genderFilter";
      const genderFilteredResults = await filterResultsByExplicitGender({
        shop: session.shop,
        originalQuery: query,
        rewrite: preparedRewrite,
        results: rawSearchResults,
        onDiagnostics: () => {},
      });

      const priceConstraint = parsePriceConstraint(query);
      let searchResults = genderFilteredResults;

      executionPhase = "priceFilter";
      if (priceConstraint || sortIntent !== "RELEVANCE") {
        try {
          searchResults = await filterSearchResultsByPrice({
            admin,
            shop: session.shop,
            results: genderFilteredResults,
            constraint: priceConstraint,
            sortIntent,
            onDiagnostics: () => {},
          });
        } catch (error) {
          searchResults = priceConstraint ? [] : genderFilteredResults;
        }
      }

      executionPhase = "resultMapping";
      const seen = new Set<string>();
      const allProducts: CandidateProduct[] = searchResults.flatMap((result) => {
        const id = result.productId.match(/^(?:gid:\/\/shopify\/Product\/)?(\d+)$/)?.[1] || result.productId;
        if (!id || seen.has(id)) return [];
        seen.add(id);
        return [{ id, handle: result.handle, rank: seen.size, score: result.score }];
      });

      executionPhase = "analytics";
      let searchLogId: string | null = null;
      if (requestedPage === 1 && searchDiagnostics) {
        try {
          searchLogId = await recordSearchQueryLog({
            shop: session.shop,
            query,
            analyzedQuery: preparedRewrite.query,
            llmAnalysis: preparedRewrite.analysis,
            selectedContext: preparedRewrite.context.selectedTerms,
            queryVector: allProducts.length === 0 ? queryVectorForAnalytics : null,
            rankedProducts: allProducts.map((p) => ({ productId: p.id, handle: p.handle, rank: p.rank, score: p.score })),
            diagnostics: searchDiagnostics,
            totalDurationMs: Date.now() - startedAt,
            onDiagnostics: () => {},
          });
        } catch (e) {}
      }

      // =========================================================================
      // [ĐIỂM RẼ NHÁNH XUẤT HTML DEDICATED SEARCH PAGE]
      // =========================================================================
      if (isCustomDataMode) {
        const allIds = allProducts.map((p) => p.id);
        const dynamicPageSize =
          entitlement.resultLimit && entitlement.resultLimit > 0
            ? entitlement.resultLimit
            : 5;

        const appSelfRenderPage = await renderAppSelfSearchPage({
          admin,
          query,
          productIds: allIds,
          pageSize: dynamicPageSize,
        });

        try {
          await markUsageReservationEffectApplied(reservation);
          await commitSearchUsage(reservation, {
            resultCount: allProducts.length,
            durationMs: Date.now() - startedAt,
            rendererSource: "custom-dedicated-page",
          });
        } catch (e) {}

        return liquid(appSelfRenderPage.html, {
          layout: true,
          headers: {
            "Cache-Control": "no-store",
          },
        });
      }

      // === NẾU TẮT CỜ: CHẠY TIẾP XUỐNG LUỒNG THEME MAP V4 CỦ ===
      executionPhase = "saveSearchResult";
      const cachedSearch = await saveSearchResult({
        shop: session.shop,
        query,
        searchLogId,
        rankedProducts: allProducts.map((p) => ({ productId: `gid://shopify/Product/${p.id}`, handle: p.handle, score: p.score })),
      });

      const pagination = buildShopifyProductQuery(allProducts, requestedPage, pageSize);
      executionPhase = "responseBuild";

      const response = Response.json({
        status: "success",
        engine: "ai-search-v4",
        query,
        theme_id: preflightMap.theme.id,
        map_fingerprint: preflightMap.fingerprint,
        render_receipt: { id: cachedSearch.receiptId, expires_at: new Date(cachedSearch.expiresAt).toISOString(), total_products: cachedSearch.total },
        applied_filters: { sort_intent: sortIntent, price: priceConstraint },
        search_log_id: searchLogId,
        pagination: { current_page: pagination.currentPage, page_size: pagination.pageSize, total_products: pagination.totalProducts, total_pages: pagination.totalPages },
      }, { headers: { "Cache-Control": "no-store" } });

      try {
        await markUsageReservationEffectApplied(reservation);
        await commitSearchUsage(reservation, {
          resultCount: allProducts.length,
          durationMs: Date.now() - startedAt,
          themeId: preflightMap.theme.gid,
          rendererSource: preflightMap.search?.searchTemplate ?? "native-search",
        });
      } catch (e) {}

      return response;
    } catch (error) {
      try { await rollbackSearchUsage(reservation, error); } catch (e) {}
      return fallback("AI_SEARCH_RUNTIME_ERROR");
    }
  } catch (error) {
    return nativeRedirect(query, nativeSearchTarget, "APP_PROXY_FATAL_ERROR");
  } finally {
    console.timeEnd("[PERF-PROXY] TOTAL PROXY REQUEST");
  }
};