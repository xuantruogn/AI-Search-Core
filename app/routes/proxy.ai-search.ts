import type { LoaderFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";
import { getActiveThemeMap } from "../services/theme/theme-map-lifecycle.server";
import type { ThemeMap } from "../services/theme-map.server";
import { semanticSearch } from "../services/search/semantic-search.server";
import { revalidateSearchResults } from "../services/search/search-result-revalidation.server";
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

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const requestUrl = new URL(request.url);
  const query = requestUrl.searchParams.get("q")?.trim() ?? "";
  const nativeSearchTarget =
    requestUrl.searchParams.get("native_search_url") ??
    requestUrl.searchParams.get("native_search_path");

  const wantsJson = requestUrl.searchParams.get("format") === "json";
  const requestedPageRaw = Number.parseInt(requestUrl.searchParams.get("page") || "1", 10);
  const requestedPage = Number.isSafeInteger(requestedPageRaw) && requestedPageRaw > 0 ? requestedPageRaw : 1;
  const nativeRedirect = (value: string, target?: string | null, reason = "NATIVE_SEARCH") => wantsJson
    ? Response.json({status:"fallback",engine:"native",reason,native_url:nativeSearchUrl(value,target)}, {headers:{"Cache-Control":"no-store"}})
    : nativeRedirectResponse(value,target,reason);
  try {
    const { admin, session } = await authenticate.public.appProxy(request);

    // Old App Embed markup can briefly outlive an uninstall/session. Native
    // search is always safer than a storefront 500.
    if (!admin || !session) {
      return nativeRedirect(query, nativeSearchTarget, "APP_PROXY_SESSION_MISSING");
    }

    if (wantsJson && requestUrl.searchParams.get("mode") === "theme-map") {
      const theme = await getActiveTheme(admin);
      const embed = await getAiSearchAppEmbedStatusForTheme(admin, theme);
      if (embed.enabled !== true) return nativeRedirect(query,nativeSearchTarget,"APP_EMBED_DISABLED_ON_ACTIVE_THEME");
      const map = await getActiveThemeMap({admin,shop:session.shop,activeTheme:theme});
      return Response.json({status:"success",theme_map:map}, {headers:{"Cache-Control":"no-store"}});
    }
    // HTML navigations from an old embed use native search until the new
    // storefront asset is deployed. AI's new contract is JSON only.
    if (!wantsJson) return nativeRedirect(query,nativeSearchTarget,"JSON_RUNTIME_REQUIRED");

    // First gate: pure request semantics. This runs before billing, DB quota,
    // theme discovery, OpenAI or Qdrant. Exact/SKU/barcode searches, mixed
    // resource searches, filters, pagination and unsupported sorts stay on
    // Shopify Search and consume zero AI tokens.
    const routeDecision = classifySearchRequest({
      query,
      nativeSearchTarget,
      maxQueryChars: MAX_QUERY_CHARS,
      minSemanticQueryChars: MIN_SEMANTIC_QUERY_CHARS,
    });

    if (routeDecision.engine === "NATIVE") {
      console.log("[AI Search] Pre-AI router chose Shopify native search:", {
        shop: session.shop,
        reason: routeDecision.reason,
        queryLength: query.length,
        resourceTypes: routeDecision.resourceTypes,
      });
      return nativeRedirect(query, nativeSearchTarget, routeDecision.reason);
    }

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
        console.error("[AI Search] Storefront plan reconciliation failed:", error);
      });
    }

    const entitlement = await getShopEntitlement(session.shop);

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
            console.error("[AI Search] Entitlement reconciliation trigger failed:", error);
          },
        );
      }

      return fallback(entitlement.disabledReason ?? "AI_SEARCH_UNAVAILABLE");
    }

    if (entitlement.indexedProducts <= 0) {
      return fallback("CATALOG_EMPTY");
    }

    // Second gate: theme capability preflight. This intentionally runs BEFORE
    // search quota reservation and before semanticSearch() creates an OpenAI
    // embedding. Every request validates the live MAIN theme id + updatedAt;
    // a theme publish/edit invalidates stale Theme Map state before AI.
    let activeTheme: ActiveTheme;
    let preflightMap: ThemeMap;
    try {
      activeTheme = await getActiveTheme(admin);
      const appEmbed = await getAiSearchAppEmbedStatusForTheme(
        admin,
        activeTheme,
      );

      // A direct/stale App Proxy request can outlive a theme publish. Never
      // spend an embedding when the current MAIN theme doesn't actually have
      // the App Embed enabled.
      if (appEmbed.enabled !== true) {
        console.warn("[AI Search] Active theme App Embed unavailable; native search selected:", {
          shop: session.shop,
          themeId: activeTheme.id,
          themeName: activeTheme.name,
          reason: appEmbed.reason,
        });
        return fallback(
          appEmbed.enabled === false
            ? "APP_EMBED_DISABLED_ON_ACTIVE_THEME"
            : "APP_EMBED_STATUS_UNKNOWN",
        );
      }

      // App Embed settings are read from a theme file. A publish can complete
      // during that request, so confirm the MAIN identity again before
      // mapping/reserving. Never combine embed state from theme A with a
      // map from theme B.
      const confirmedTheme = await getActiveTheme(admin);
      if (confirmedTheme.versionKey !== activeTheme.versionKey) {
        return fallback("ACTIVE_THEME_CHANGED_DURING_PREFLIGHT");
      }
      activeTheme = confirmedTheme;

      preflightMap = await getActiveThemeMap({
        admin,
        shop: session.shop,
        activeTheme,
      });

      if (preflightMap.theme.versionKey !== activeTheme.versionKey) {
        return fallback("THEME_MAP_SNAPSHOT_MISMATCH");
      }
      if (requestUrl.searchParams.get("theme_id") !== preflightMap.theme.id || requestUrl.searchParams.get("map_fingerprint") !== preflightMap.fingerprint) {
        return fallback("STOREFRONT_THEME_MAP_STALE");
      }

    } catch (error) {
      console.warn("[AI Search] Theme preflight failed; native search selected:", {
        shop: session.shop,
        error: error instanceof Error ? error.message : String(error),
      });
      return fallback("THEME_MAP_UNAVAILABLE");
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
      // Oversample Qdrant candidates so stale/unpublished entries can be
      // removed without unnecessarily shrinking the visible result set.
      const rawSearchResults = await semanticSearch({
        shop: session.shop,
        query,
        limit: Math.min(60, Math.max(entitlement.resultLimit, entitlement.resultLimit * 3)),
        onEmbeddingCreated: async () => {
          try {
            await recordQueryEmbeddingConsumed(reservation);
          } catch (usageError) {
            console.error("[AI Search] Query embedding usage logging failed:", usageError);
          }
        },
      });

      const revalidated = await revalidateSearchResults({
        admin,
        shop: session.shop,
        results: rawSearchResults,
        // Validate the ranked pool before pagination so total_pages remains correct.
        limit: rawSearchResults.length,
      });
      const searchResults = revalidated.results;

      // Qdrant can be briefly ahead of Shopify after an unpublish/delete. If
      // every ranked candidate is rejected by the live Shopify check, do not
      // render a misleading empty AI page. The outer execution handler rolls
      // back the search reservation (while preserving real embedding usage)
      // and sends the customer to Shopify native search.
      if (searchResults.length === 0) {
        throw new Error("NO_LIVE_AI_RESULTS_AFTER_REVALIDATION");
      }


      if (revalidated.staleProductIds.length > 0 || revalidated.repairedMetadata > 0) {
        console.log("[AI Search] Search candidates reconciled with Shopify:", {
          shop: session.shop,
          staleRemoved: revalidated.staleProductIds.length,
          metadataRepaired: revalidated.repairedMetadata,
          validResults: searchResults.length,
        });
      }
      // Theme rendering happens on Shopify's /search page, never in this
      // backend. Fence the JSON ranking against a mid-query theme change.
      const finalTheme = await getActiveTheme(admin);
      if (finalTheme.versionKey !== activeTheme.versionKey || finalTheme.processing || finalTheme.processingFailed) throw new Error("ACTIVE_THEME_CHANGED_DURING_SEARCH");
      const finalEmbed = await getAiSearchAppEmbedStatusForTheme(admin, finalTheme);
      if (finalEmbed.enabled !== true) throw new Error("APP_EMBED_CHANGED_DURING_SEARCH");
      const finalMap = await getActiveThemeMap({admin,shop:session.shop,activeTheme:finalTheme});
      if (finalMap.fingerprint !== preflightMap.fingerprint) throw new Error("THEME_MAP_CHANGED_DURING_SEARCH");
      const seen = new Set<string>();
      const products = searchResults.flatMap((result) => {
        const id = result.productId.match(/^(?:gid:\/\/shopify\/Product\/)?(\d+)$/)?.[1];
        if (!id) throw new Error("INVALID_SHOPIFY_PRODUCT_ID");
        if (seen.has(id)) return [];
        seen.add(id);
        return [{id,handle:result.handle}];
      });
      const pageSize = Math.max(1, entitlement.resultLimit);
      const totalProducts = products.length;
      const totalPages = Math.max(1, Math.ceil(totalProducts / pageSize));
      const currentPage = Math.min(requestedPage, totalPages);
      const pageStart = (currentPage - 1) * pageSize;
      const pageProducts = products.slice(pageStart, pageStart + pageSize);

      const response = Response.json({
        status:"success",engine:"ai-search-v3",query,
        theme_id:finalMap.theme.id,map_fingerprint:finalMap.fingerprint,
        target_ids:pageProducts.map((product)=>`id:${product.id}`).join(" OR "),
        products:pageProducts,
        pagination:{current_page:currentPage,page_size:pageSize,total_products:totalProducts,total_pages:totalPages},
      }, {headers:{"Cache-Control":"no-store"}});

      try {
        await markUsageReservationEffectApplied(reservation);
      } catch (usageError) {
        console.error("[AI Search] Search reservation effect marker failed:", usageError);
      }

      try {
        await commitSearchUsage(reservation, {
          resultCount: searchResults.length,
          durationMs: Date.now() - startedAt,
          themeId: finalMap.theme.gid,
          rendererSource: finalMap.search.searchTemplate ?? "native-search",
        });
      } catch (usageError) {
        console.error("[AI Search] Search usage commit logging failed:", usageError);
      }

      return response;
    } catch (error) {
      console.error("[AI Search] AI execution failed; using Shopify native search:", {
        shop: session.shop,
        error: error instanceof Error ? error.message : String(error),
      });

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
  }
};
