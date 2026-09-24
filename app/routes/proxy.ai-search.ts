import type { LoaderFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";
import {
  semanticSearch,
  type SemanticSearchDiagnostics,
} from "../services/search/semantic-search.server";
import { recordSearchQueryLog } from "../services/search/search-analytics.server";
import { parsePriceConstraint } from "../services/search/query-constraints.server";
import { prepareQueryRewrite } from "../services/search/conditional-query-llm.server";
import { retrieveStructuredCandidates } from "../services/search/structured-candidate-retrieval.server";
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
import { buildQueryPlan } from "../services/search/query-planner.server";
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
  resolveUniqueThemeSearchTransportKeys,
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
import { getEmbeddingModel } from "../services/search/embeddings.server";
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
  return [
    shop,
    getEmbeddingModel(),
    "768",
    EMBEDDING_QUERY_PIPELINE_VERSION,
    query.trim(),
  ].join("\u0000");
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

  return Number.isSafeInteger(value) && value > 0
    ? value
    : fallback;
}

const MAX_QUERY_CHARS = readPositiveInteger(
  "AI_SEARCH_MAX_QUERY_CHARS",
  500,
);

const MIN_SEMANTIC_QUERY_CHARS = readPositiveInteger(
  "AI_SEARCH_MIN_SEMANTIC_QUERY_CHARS",
  3,
);

// ==========================================
// THEME MAP V4 RENDER STRATEGY HELPERS
// ==========================================

function isThemeContextTransportCandidate(
  candidate: ThemeRendererCandidate,
): boolean {
  if (
    candidate.renderStrategy !==
      "THEME_CONTEXT_REQUIRED" ||
    candidate.mount == null ||
    candidate.usesAllProducts
  ) {
    return false;
  }

  /**
   * THEME_CONTEXT_REQUIRED l├á rejection c├│ chß╗º ─æ├¡ch:
   *
   * App Proxy Liquid kh├┤ng c├│ section/block context ─æß╗â replay
   * merchant Theme Blocks.
   *
   * Nhß╗»ng rejection kh├íc vß║½n l├á lß╗ùi thß║¡t v├á kh├┤ng ─æã░ß╗úc ph├®p
   * biß║┐n th├ánh Section Rendering transport.
   */
  return candidate.rejectionReasons.every(
    (reason) =>
      reason ===
      "THEME_CONTEXT_REQUIRED",
  );
}

function getThemeContextTransportCandidate(
  map: ThemeMapV4,
): ThemeRendererCandidate | null {
  return (
    map.rendererCandidates
      .filter(
        isThemeContextTransportCandidate,
      )
      .slice()
      .sort(
        (left, right) =>
          right.score -
            left.score ||
          left.id.localeCompare(
            right.id,
          ),
      )[0] ?? null
  );
}

function themeMapSupportsSearchExecution(
  map: ThemeMapV4,
): boolean {
  /**
   * Classic theme:
   * APP_PROXY_LIQUID candidate ─æ├ú VERIFIED.
   *
   * Modern Theme Blocks:
   * map c├│ thß╗â l├á UNSUPPORTED ─æß╗æi vß╗øi App Proxy replay,
   * nhã░ng vß║½n c├│ source-proven THEME_CONTEXT_REQUIRED candidate.
   * Trã░ß╗Øng hß╗úp ─æ├│ AI search vß║½n ─æã░ß╗úc ph├®p chß║íy v├¼ rendering sß║¢
   * ─æi qua Shopify Section Rendering API ß╗ƒ transport-v4.
   */
  return (
    map.status ===
      "VERIFIED" ||
    getThemeContextTransportCandidate(
      map,
    ) != null
  );
}


type ThemeMapV4TransportProfileRuntime = {
  version?: number;
  nativePageSize?: number | null;
  preferredBatchSize?: number;
  maxEncodedQueryLength?: number;
  paginationMode?:
    | "INFINITE_SCROLL"
    | "PAGINATION"
    | "UNKNOWN";
  mustSuspendNativePagination?: boolean;
  sourceProven?: boolean;
};

function readThemeTransportProfile(
  map: ThemeMapV4,
): ThemeMapV4TransportProfileRuntime | null {
  const raw = (map as ThemeMapV4 & {
    transportProfile?: unknown;
  }).transportProfile;

  if (!raw || typeof raw !== "object") {
    return null;
  }

  const profile =
    raw as ThemeMapV4TransportProfileRuntime;

  const preferredBatchSize =
    Number(profile.preferredBatchSize);

  const maxEncodedQueryLength =
    Number(profile.maxEncodedQueryLength);

  if (
    !Number.isSafeInteger(preferredBatchSize) ||
    preferredBatchSize <= 0 ||
    !Number.isSafeInteger(maxEncodedQueryLength) ||
    maxEncodedQueryLength < 256
  ) {
    return null;
  }

  return profile;
}

function themeTransportPlannerOptions(
  map: ThemeMapV4,
):
  | {
      maxProductsPerBatch: number;
      maxEncodedQueryLength: number;
    }
  | undefined {
  const profile =
    readThemeTransportProfile(map);

  if (!profile) {
    /**
     * Theme Map c┼® chã░a c├│ transportProfile.
     * Omit options ─æß╗â planner giß╗» nguy├¬n fallback
     * production c┼® (8 products / 1400 encoded chars).
     */
    return undefined;
  }

  return {
    maxProductsPerBatch:
      Math.max(
        1,
        Math.min(
          THEME_MAP_V4_DEFAULT_PAGE_SIZE,
          Number(profile.preferredBatchSize),
        ),
      ),

    maxEncodedQueryLength:
      Math.max(
        256,
        Number(profile.maxEncodedQueryLength),
      ),
  };
}

// ==========================================
// THEME MAP V4 ÔÇö STORED ARTIFACT ONLY
// ==========================================

function normalizeStorefrontThemeId(value: string | null | undefined): string {
  return (
    String(value ?? "")
      .trim()
      .match(/^(?:gid:\/\/shopify\/(?:OnlineStore)?Theme\/)?(\d+)$/)?.[1] ??
    String(value ?? "").trim()
  );
}

async function loadSyncedThemeMapForStorefront(args: {
  shop: string;
  themeId: string | null | undefined;
  fingerprint?: string | null;
}): Promise<
  | { ok: true; map: ThemeMapV4 }
  | { ok: false; reason: string }
> {
  const themeId = normalizeStorefrontThemeId(args.themeId);

  /**
   * Storefront runtime KH├öNG gß╗ìi Shopify Admin API ─æß╗â:
   * - t├¼m active theme
   * - check App Embed
   * - validate dependency
   * - rebuild Theme Map
   *
   * Theme Map chß╗ë ─æã░ß╗úc tß║ío khi:
   * 1. app vß╗½a ─æã░ß╗úc c├ái/khß╗ƒi tß║ío;
   * 2. merchant chß╗º ─æß╗Öng bß║Ñm "─Éß╗ông bß╗Ö theme".
   *
   * theme_id ─æß║┐n tß╗½ Liquid cß╗ºa ch├¡nh theme ─æang chß║íy.
   * Nß║┐u theme mß╗øi chã░a tß╗½ng sync th├¼ kh├┤ng c├│ row tã░ãíng ß╗®ng -> native fallback.
   */
  if (!themeId) {
    return {
      ok: false,
      reason: "THEME_SYNC_REQUIRED",
    };
  }

  const stored = await loadStoredThemeMapV4({
    shop: args.shop,
    themeId,
  });

  if (!stored) {
    return {
      ok: false,
      reason: "THEME_SYNC_REQUIRED",
    };
  }

  if (
    args.fingerprint &&
    args.fingerprint !== stored.fingerprint
  ) {
    return {
      ok: false,
      reason: "THEME_SYNC_REQUIRED",
    };
  }

  if (!themeMapSupportsSearchExecution(stored.map)) {
    return {
      ok: false,
      reason:
        `THEME_MAP_V4_UNSUPPORTED:${
          stored.map.unsupportedReason ?? "UNKNOWN"
        }`,
    };
  }

  return {
    ok: true,
    map: stored.map,
  };
}

// ==========================================
// LOGIC PH├éN TRANG ─Éß╗ÿNG
// ==========================================

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

function buildShopifyProductQuery(
  products: CandidateProduct[],
  page: number,
  pageSize: number,
): PaginationResult {
  const totalProducts = products.length;

  const totalPages =
    totalProducts > 0
      ? Math.ceil(
          totalProducts / pageSize,
        )
      : 0;

  const currentPage =
    Number.isInteger(page) &&
    page >= 1
      ? page
      : 1;

  const offset =
    (currentPage - 1) *
    pageSize;

  const pageProducts =
    products.slice(
      offset,
      offset + pageSize,
    );

  return {
    totalProducts,
    totalPages,
    currentPage,
    pageSize,
    pageProducts,
  };
}

// ==========================================
// LOADER
// ==========================================

export const loader = async ({
  request,
}: LoaderFunctionArgs) => {
  console.time(
    "[PERF-PROXY] TOTAL PROXY REQUEST",
  );

  const proxyStartedAt =
    Date.now();

  const normalizeStartedAt =
    Date.now();

  const requestUrl =
    new URL(request.url);

  const query =
    requestUrl.searchParams
      .get("q")
      ?.trim() ?? "";

  const receiptRaw =
    requestUrl.searchParams
      .get("receipt")
      ?.trim() ||
    null;

  const nativeSearchTarget =
    requestUrl.searchParams.get(
      "native_search_url",
    ) ??
    requestUrl.searchParams.get(
      "native_search_path",
    );

  const wantsJson =
    requestUrl.searchParams.get(
      "format",
    ) === "json";

  const requestedPageRaw =
    Number.parseInt(
      requestUrl.searchParams.get(
        "page",
      ) || "1",
      10,
    );

  const requestedPage =
    Number.isSafeInteger(
      requestedPageRaw,
    ) &&
    requestedPageRaw > 0
      ? requestedPageRaw
      : 1;

  const normalizeMs =
    Date.now() -
    normalizeStartedAt;

const resultCacheMs = 0;

const resultCacheStatus = "MISS" as const;

  let authMs = 0;
  let requestRoutingCodeMs = 0;
  let billingRefreshMs = 0;
  let entitlementDbMs = 0;
  let themeMapLookupMs = 0;
  let usageReservationDbMs = 0;

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

            native_url:
              nativeSearchUrl(
                value,
                target,
              ),
          },
          {
            headers: {
              "Cache-Control":
                "no-store",
            },
          },
        )
      : nativeRedirectResponse(
          value,
          target,
          reason,
        );

  try {
    const authStartedAt =
      Date.now();

    const {
      admin,
      session,
      liquid,
    } =
      await authenticate.public
        .appProxy(request);

    authMs =
      Date.now() -
      authStartedAt;

    if (!admin || !session) {
      if (
        requestUrl.searchParams.get(
          "mode",
        ) === "runtime-config"
      ) {
        return Response.json(
          {
            status: "fallback",
            engine: "v4",
            reason: "APP_PROXY_SESSION_MISSING",
          },
          {
            headers: {
              "Cache-Control": "no-store",
            },
          },
        );
      }

      return nativeRedirect(
        query,
        nativeSearchTarget,
        "APP_PROXY_SESSION_MISSING",
      );
    }

    if (
      requestUrl.searchParams.get(
        "mode",
      ) === "runtime-config"
    ) {
      const shopSettings =
        await getShopSettings(
          session.shop,
        );

      const isCustomDataMode =
        Boolean(
          shopSettings
            .customDataModeEnabled,
        );

      let themeMapBootstrap:
        | {
            theme_id: string;
            map_fingerprint: string;
            mount: ThemeRendererCandidate["mount"];
          }
        | null = null;

      if (!isCustomDataMode) {
        const syncedMap =
          await loadSyncedThemeMapForStorefront({
            shop: session.shop,
            themeId:
              requestUrl.searchParams.get("theme_id"),
          });

        if (syncedMap.ok) {
          const bootstrapCandidate =
            getThemeResultRendererCandidates(syncedMap.map)[0] ??
            getThemeContextTransportCandidate(syncedMap.map);

          if (bootstrapCandidate?.mount) {
            themeMapBootstrap = {
              theme_id: syncedMap.map.theme.id,
              map_fingerprint: syncedMap.map.fingerprint,
              mount: bootstrapCandidate.mount,
            };
          }
        }
      }

      return Response.json(
        {
          status: "success",
          engine:
            isCustomDataMode
              ? "v3"
              : "v4",
          customDataModeEnabled:
            isCustomDataMode,
          themeMapBootstrap,
        },
        {
          headers: {
            "Cache-Control":
              "no-store",
          },
        },
      );
    }

    // =========================================================================
    // THEME CONTEXT TRANSPORT V4
    //
    // IMPORTANT:
    // - receipt/page only
    // - no billing reservation
    // - no GPT/query rewrite
    // - no embedding
    // - no Qdrant
    //
    // This endpoint DOES NOT render product cards.
    //
    // It converts the already-ranked AI product IDs for one receipt page into
    // safe Shopify storefront-search clauses. The storefront will later use
    // those clauses with Shopify Section Rendering API so merchant Theme Blocks
    // execute inside their real search section/block context.
    // =========================================================================

    if (
      requestUrl.searchParams.get(
        "mode",
      ) === "transport-v4"
    ) {
      if (
        process.env
          .AI_SEARCH_THEME_MAP_V4 !==
        "true"
      ) {
        return Response.json(
          {
            status:
              "disabled",

            feature:
              "theme-context-transport-v4",

            reason:
              "THEME_MAP_V4_DISABLED",
          },
          {
            status: 404,

            headers: {
              "Cache-Control":
                "no-store",
            },
          },
        );
      }

      const receiptId =
        receiptRaw ?? "";

      if (
        !/^srch_[A-Za-z0-9_-]+$/.test(
          receiptId,
        )
      ) {
        return Response.json(
          {
            status:
              "error",

            reason:
              "INVALID_SEARCH_RECEIPT",
          },
          {
            status: 400,

            headers: {
              "Cache-Control":
                "no-store",
            },
          },
        );
      }

      const cachedPage =
        await getSearchResultPage({
          shop:
            session.shop,

          receiptId,

          page:
            requestedPage,

          pageSize:
            THEME_MAP_V4_DEFAULT_PAGE_SIZE,
        });

      if (!cachedPage) {
        return Response.json(
          {
            status:
              "error",

            reason:
              "SEARCH_RECEIPT_EXPIRED_OR_INVALID",
          },
          {
            status: 410,

            headers: {
              "Cache-Control":
                "no-store",
            },
          },
        );
      }

      const clientThemeId =
        requestUrl.searchParams.get(
          "theme_id",
        );

      const clientFingerprint =
        requestUrl.searchParams.get(
          "map_fingerprint",
        );

      const storedTheme =
        await loadSyncedThemeMapForStorefront({
          shop:
            session.shop,

          themeId:
            clientThemeId,

          fingerprint:
            clientFingerprint,
        });

      if (storedTheme.ok === false) {
        return Response.json(
          {
            status:
              "sync_required",

            reason:
              storedTheme.reason,
          },
          {
            status: 409,

            headers: {
              "Cache-Control":
                "no-store",
            },
          },
        );
      }

      const map =
        storedTheme.map;

      const candidate =
        getThemeContextTransportCandidate(
          map,
        );

      if (
        !candidate ||
        !candidate.mount
      ) {
        return Response.json(
          {
            status:
              "unsupported",

            reason:
              "THEME_CONTEXT_TRANSPORT_CANDIDATE_NOT_FOUND",

            theme_id:
              map.theme.id,

            map_status:
              map.status,

            map_fingerprint:
              map.fingerprint,
          },
          {
            status: 409,

            headers: {
              "Cache-Control":
                "no-store",
            },
          },
        );
      }

      // Resolve transport keys against the already-cached ranked list, then
      // paginate the renderable subset. This backfills an unrenderable rank
      // from the next ranked product without re-running GPT, embedding or
      // Qdrant, and keeps page boundaries stable across page navigation.
      const fullTransportResolution =
        await resolveUniqueThemeSearchTransportKeys({
          shop: session.shop,
          productIds: cachedPage.result.rankedProducts.map(
            (product) => product.productId,
          ),
        });
      const renderableIds = fullTransportResolution.resolved.map(
        (item) => item.productId,
      );
      const renderableTotalPages = Math.max(
        1,
        Math.ceil(renderableIds.length / cachedPage.pageSize),
      );
      const renderablePage = Math.min(cachedPage.page, renderableTotalPages);
      const renderableStart = (renderablePage - 1) * cachedPage.pageSize;
      const targetProductIds = renderableIds.slice(
        renderableStart,
        renderableStart + cachedPage.pageSize,
      );

      const transportPlannerOptions =
        themeTransportPlannerOptions(
          map,
        );

      const transportPlan =
        await planThemeSearchTransportFromStoredKeys(
          {
            shop:
              session.shop,

            productIds:
              targetProductIds,

            options:
              transportPlannerOptions,
          },
        );

      if (
        !transportPlan.safeToRender
      ) {
        console.warn(
          "[AI Search][Theme Context Transport V4] unsafe plan:",
          {
            shop:
              session.shop,

            receiptId,

            page:
              cachedPage.page,

            targetCount:
              transportPlan
                .targetProductIds
                .length,

            unresolved:
              transportPlan
                .unresolved,

            render_unresolved_count:
              fullTransportResolution.unresolved.length,
          },
        );

        return Response.json(
          {
            status:
              "unsafe",

            engine:
              "theme-context-transport-v4",

            render_strategy:
              "THEME_CONTEXT_REQUIRED",

            reason:
              "TRANSPORT_PLAN_UNSAFE",

            theme_id:
              map.theme.id,

            map_fingerprint:
              map.fingerprint,

            candidate_id:
              candidate.id,

            mount:
              candidate.mount,

            target_product_ids:
              transportPlan
                .targetProductIds,

            unresolved:
              transportPlan
                .unresolved,

            batches:
              transportPlan
                .batches,

            pagination: {
              current_page:
                renderablePage,

              page_size:
                cachedPage.pageSize,

              total_products:
                renderableIds.length,

              total_pages:
                renderableTotalPages,
            },
          },
          {
            status: 409,

            headers: {
              "Cache-Control":
                "no-store",
            },
          },
        );
      }

      console.log(
        "[AI Search][Theme Context Transport V4] plan ready:",
        {
          shop:
            session.shop,

          receiptId,

          page:
            cachedPage.page,

          candidateId:
            candidate.id,

          targetCount:
            transportPlan
              .targetProductIds
              .length,

          batchCount:
            transportPlan
              .batches
              .length,

          maxProductsPerBatch:
            transportPlannerOptions
              ?.maxProductsPerBatch ??
            8,

          maxEncodedQueryLength:
            transportPlannerOptions
              ?.maxEncodedQueryLength ??
            1400,
        },
      );

      return Response.json(
        {
          status:
            "success",

          engine:
            "theme-context-transport-v4",

          render_strategy:
            "THEME_CONTEXT_REQUIRED",

          theme_id:
            map.theme.id,

          map_fingerprint:
            map.fingerprint,

          transport_profile:
            readThemeTransportProfile(
              map,
            ),

          receipt:
            cachedPage.result
              .receiptId,

          search_log_id:
            cachedPage.result
              .searchLogId,

          candidate: {
            id:
              candidate.id,

            type:
              candidate.type,

            source_file:
              candidate.sourceFile,
          },

          mount:
            candidate.mount,

          search_section: {
            template_file:
              map.search
                .templateFile,

            template_type:
              map.search
                .templateType,

            section_key:
              map.search
                .sectionKey ??
              null,

            section_type:
              map.search
                .sectionType ??
              null,

            section_file:
              map.search
                .sectionFile ??
              null,
          },

          safeToRender:
            true,

          targetProductIds:
            transportPlan
              .targetProductIds,

          resolved:
            transportPlan
              .resolved,

          unresolved:
            transportPlan
              .unresolved,

          render_unresolved_count:
            fullTransportResolution.unresolved.length,

          batches:
            transportPlan
              .batches,

          pagination: {
            current_page:
              renderablePage,

            page_size:
              cachedPage.pageSize,

            total_products:
              renderableIds.length,

            total_pages:
              renderableTotalPages,
          },
        },
        {
          headers: {
            "Cache-Control":
              "no-store",
          },
        },
      );
    }

    // =========================================================================
    // THEME MAP V4 RENDER ENDPOINT
    //
    // IMPORTANT:
    // - receipt/page only
    // - no billing reservation
    // - no GPT/query rewrite
    // - no embedding
    // - no Qdrant
    //
    // Shopify app proxy renders the returned Liquid in the active theme
    // context because authenticate.public.appProxy() exposes liquid().
    // =========================================================================

    if (
      requestUrl.searchParams.get(
        "mode",
      ) === "render-v4"
    ) {
      const renderV4StartedAt =
        Date.now();

      let receiptCacheMs = 0;
      let pageSliceMs = 0;
      let themeMapLoadMs = 0;
      let buildLiquidMs = 0;
      let liquidCallMs = 0;

      const logRenderV4Timing = (
        outcome: string,
      ) => {
        console.log(
          "[AI Search][RENDER V4 TIMING]",
          {
            shop:
              session.shop,

            receiptId:
              receiptRaw ?? null,

            page:
              requestedPage,

            outcome,

            authMs,

            receiptCacheMs,

            pageSliceMs,

            themeMapLoadMs,

            buildLiquidMs,

            liquidCallMs,

            totalRenderV4Ms:
              Date.now() -
              renderV4StartedAt,

            totalProxyMs:
              Date.now() -
              proxyStartedAt,
          },
        );
      };

      if (
        process.env
          .AI_SEARCH_THEME_MAP_V4 !==
        "true"
      ) {
        logRenderV4Timing(
          "THEME_MAP_V4_DISABLED",
        );

        return new Response(
          "THEME_MAP_V4_DISABLED",
          {
            status: 404,
            headers: {
              "Cache-Control":
                "no-store",
            },
          },
        );
      }

      const receiptId =
        receiptRaw ?? "";

      if (
        !/^srch_[A-Za-z0-9_-]+$/.test(
          receiptId,
        )
      ) {
        logRenderV4Timing(
          "INVALID_SEARCH_RECEIPT",
        );

        return new Response(
          "INVALID_SEARCH_RECEIPT",
          {
            status: 400,
            headers: {
              "Cache-Control":
                "no-store",
            },
          },
        );
      }

      const candidateId =
        requestUrl.searchParams
          .get("candidate_id")
          ?.trim() ||
        undefined;

      /*
       * FAST PATH V4
       *
       * Receipt ─æ├ú chß╗®a ranked product IDs/handles theo ─æ├║ng thß╗® tß╗▒ AI.
       * getSearchResultPage() tß╗▒ slice ─æ├║ng pageSize n├¬n render-v4 kh├┤ng
       * cß║ºn gß╗ìi Shopify Admin API ─æß╗â revalidate/backfill th├¬m lß║ºn nß╗»a.
       *
       * Search core vß║½n giß╗» nguy├¬n. ─É├óy chß╗ë tß╗æi ã░u ─æã░ß╗Øng render receipt.
       */
      const receiptCacheStartedAt =
        Date.now();

      const cachedPage =
        await getSearchResultPage({
          shop: session.shop,
          receiptId,
          page: requestedPage,
          pageSize:
            THEME_MAP_V4_DEFAULT_PAGE_SIZE,
        });

      receiptCacheMs =
        Date.now() -
        receiptCacheStartedAt;

      if (!cachedPage) {
        logRenderV4Timing(
          "SEARCH_RECEIPT_EXPIRED_OR_INVALID",
        );

        return new Response(
          "SEARCH_RECEIPT_EXPIRED_OR_INVALID",
          {
            status: 410,
            headers: {
              "Cache-Control":
                "no-store",
            },
          },
        );
      }

      const pageSliceStartedAt =
        Date.now();

      const pageProducts =
        cachedPage.products.map(
          (product) => ({
            productId:
              product.productId,

            handle:
              product.handle,
          }),
        );

      pageSliceMs =
        Date.now() -
        pageSliceStartedAt;

      /*
       * Theme Map l├á artifact ─æ├ú ─æß╗ông bß╗Ö sß║Án.
       *
       * Render path chß╗ë ─æß╗ìc SQLite theo theme_id m├á storefront gß╗¡i l├¬n.
       * Kh├┤ng gß╗ìi Admin API, kh├┤ng check App Embed, kh├┤ng tß╗▒ rebuild.
       */
      const themeMapLoadStartedAt =
        Date.now();

      const clientThemeId =
        requestUrl.searchParams.get(
          "theme_id",
        );

      const clientFingerprint =
        requestUrl.searchParams.get(
          "map_fingerprint",
        );

      const storedTheme =
        await loadSyncedThemeMapForStorefront({
          shop:
            session.shop,

          themeId:
            clientThemeId,

          fingerprint:
            clientFingerprint,
        });

      themeMapLoadMs =
        Date.now() -
        themeMapLoadStartedAt;

      if (storedTheme.ok === false) {
        logRenderV4Timing(
          storedTheme.reason,
        );

        return new Response(
          storedTheme.reason,
          {
            status: 409,

            headers: {
              "Cache-Control":
                "no-store",
            },
          },
        );
      }

      const map =
        storedTheme.map;

      if (
        map.status !==
        "VERIFIED"
      ) {
        const reason =
          `THEME_MAP_UNSUPPORTED:${map.unsupportedReason}`;

        logRenderV4Timing(
          reason,
        );

        return new Response(
          reason,
          {
            status: 409,

            headers: {
              "Cache-Control":
                "no-store",
            },
          },
        );
      }

      try {
        const buildLiquidStartedAt =
          Date.now();

        const renderPlan =
          buildThemeResultLiquid({
            map,

            products:
              pageProducts,

            candidateId,
          });

        if (process.env.NODE_ENV !== "production") {
          console.log("[AI Search][Theme Map V4] generated APP_PROXY_LIQUID", {
            shop: session.shop,
            receiptId: cachedPage.result.receiptId,
            page: cachedPage.page,
            candidateId: renderPlan.candidateId,
            sourceFile: renderPlan.candidate.sourceFile,
            snippet: renderPlan.candidate.snippet ?? null,
            productBinding: renderPlan.candidate.productBinding,
            arguments: renderPlan.candidate.arguments,
            liquid: renderPlan.liquid,
          });
        }

        buildLiquidMs =
          Date.now() -
          buildLiquidStartedAt;

        const renderMeta =
          encodeURIComponent(
            JSON.stringify({
              version: 4,

              themeId:
                map.theme.id,

              fingerprint:
                map.fingerprint,

              receipt:
                cachedPage.result
                  .receiptId,

              searchLogId:
                cachedPage.result
                  .searchLogId,

              page:
                cachedPage.page,

              pageSize:
                cachedPage.pageSize,

              totalProducts:
                cachedPage.totalProducts,

              totalPages:
                cachedPage.totalPages,

              candidateId:
                renderPlan.candidateId,

              runtimeMode:
                renderPlan.candidate
                  .runtime.mode,

              mount:
                renderPlan.mount,

              candidateIds:
                getThemeResultRendererCandidates(
                  map,
                ).map(
                  (candidate) =>
                    candidate.id,
                ),

              products:
                pageProducts,
            }),
          );

        /*
         * App Proxy c├│ thß╗â kh├┤ng forward custom response headers
         * ra browser storefront.
         *
         * V├¼ vß║¡y metadata V4 ─æã░ß╗úc gß╗¡i bß║▒ng 2 ─æã░ß╗Øng:
         *
         * 1. Header ÔÇö giß╗» compatibility/debug.
         * 2. HTML body ÔÇö contract ─æ├íng tin cß║¡y cho storefront V4.
         *
         * Script type=application/json l├á inert. N├│ kh├┤ng chß║íy JavaScript.
         * Frontend sß║¢ ─æß╗ìc + remove node n├áy trã░ß╗øc khi mount card HTML.
         */
        const renderLiquid = [
          `<script type="application/json" data-ai-search-render-meta>${renderMeta}</script>`,
          renderPlan.liquid,
        ].join("\n");

        const liquidCallStartedAt =
          Date.now();

        const response =
          liquid(
            renderLiquid,
            {
              layout: false,

              headers: {
                "Cache-Control":
                  "no-store",

                "X-AI-Search-Render-Version":
                  "4",

                "X-AI-Search-Render-Meta":
                  renderMeta,
              },
            },
          );

        liquidCallMs =
          Date.now() -
          liquidCallStartedAt;

        logRenderV4Timing(
          "SUCCESS",
        );

        return response;
      } catch (error) {
        logRenderV4Timing(
          "THEME_RENDER_V4_FAILED",
        );

        console.error(
          "[AI Search][Theme Map V4] render failed:",
          {
            shop:
              session.shop,

            receiptId,

            page:
              requestedPage,

            candidateId:
              candidateId ??
              null,

            error:
              error instanceof Error
                ? error.message
                : String(error),
          },
        );

        return new Response(
          error instanceof Error
            ? error.message
            : "THEME_RENDER_V4_FAILED",
          {
            status: 422,

            headers: {
              "Cache-Control":
                "no-store",
            },
          },
        );
      }
    }

    if (
      wantsJson &&
      requestUrl.searchParams.get(
        "mode",
      ) === "theme-map-v4"
    ) {
      if (
        process.env
          .AI_SEARCH_THEME_MAP_V4 !==
        "true"
      ) {
        return Response.json(
          {
            status:
              "disabled",

            feature:
              "theme-map-v4",
          },
          {
            status: 404,

            headers: {
              "Cache-Control":
                "no-store",
            },
          },
        );
      }

      const storedTheme =
        await loadSyncedThemeMapForStorefront({
          shop:
            session.shop,

          themeId:
            requestUrl.searchParams.get(
              "theme_id",
            ),

          fingerprint:
            requestUrl.searchParams.get(
              "map_fingerprint",
            ),
        });

      if (storedTheme.ok === false) {
        return Response.json(
          {
            status:
              "sync_required",

            reason:
              storedTheme.reason,
          },
          {
            status: 409,

            headers: {
              "Cache-Control":
                "no-store",
            },
          },
        );
      }

      const map =
        storedTheme.map;

      return Response.json(
        {
          status: "success",
          theme_map: map,
        },
        {
          headers: {
            "Cache-Control":
              "no-store",
          },
        },
      );
    }

    const shopSettings =
      await getShopSettings(
        session.shop,
      );

    const isCustomDataMode =
      Boolean(
        shopSettings
          .customDataModeEnabled,
      );

    if (isCustomDataMode) {
      const hasSectionId =
        requestUrl.searchParams.has(
          "section_id",
        ) ||
        requestUrl.searchParams.has(
          "sections",
        );

      const isPredictive =
        requestUrl.pathname.includes(
          "predictive",
        ) ||
        requestUrl.searchParams.has(
          "predictive",
        );

      if (
        hasSectionId ||
        isPredictive
      ) {
        if (wantsJson) {
          return Response.json(
            {},
            {
              status: 200,
              headers: {
                "Cache-Control":
                  "no-store",
              },
            },
          );
        }

        return new Response(
          "",
          {
            status: 200,
            headers: {
              "Content-Type":
                "application/liquid; charset=utf-8",
              "Cache-Control":
                "no-store",
            },
          },
        );
      }

      const idsParam =
        requestUrl.searchParams.get(
          "ids",
        );

      if (
        wantsJson &&
        idsParam
      ) {
        const rawIds =
          idsParam
            .split(",")
            .map((id) =>
              id.trim(),
            )
            .filter(Boolean);

        try {
          const gids =
            rawIds.map((id) =>
              id.startsWith(
                "gid://",
              )
                ? id
                : `gid://shopify/Product/${id}`,
            );

          const products =
            await fetchAppSelfRenderProductsByGids(
              admin,
              gids,
            );

          return Response.json(
            {
              status: "success",
              products,
            },
            {
              headers: {
                "Cache-Control":
                  "no-store",
              },
            },
          );
        } catch (error) {
          console.error(
            "[AI Search][Custom Data Mode] product hydration failed:",
            error,
          );

          return Response.json(
            {
              status: "error",
              products: [],
            },
            {
              status: 200,
              headers: {
                "Cache-Control":
                  "no-store",
              },
            },
          );
        }
      }
    }

    if (!isCustomDataMode) {
      if (!wantsJson) {
        return nativeRedirect(
          query,
          nativeSearchTarget,
          "JSON_RUNTIME_REQUIRED",
        );
      }

      const routingStartedAt =
        Date.now();

      const routeDecision =
        classifySearchRequest({
          query,
          nativeSearchTarget,
          maxQueryChars:
            MAX_QUERY_CHARS,
          minSemanticQueryChars:
            MIN_SEMANTIC_QUERY_CHARS,
        });

      requestRoutingCodeMs =
        Date.now() -
        routingStartedAt;

      if (
        routeDecision.engine ===
        "NATIVE"
      ) {
        console.warn(
          "[AI Search] Request routed to native search",
          {
            shop:
              session.shop,

            query,

            reason:
              routeDecision.reason,

            nativeSearchTarget,

            resourceTypes:
              routeDecision.resourceTypes,
          },
        );

        return nativeRedirect(
          query,
          nativeSearchTarget,
          routeDecision.reason,
        );
      }
    }

    // Billing Check & Reconciliation

    let billingChanged =
      false;

    const billingStartedAt =
      Date.now();

    try {
      const billing =
        await refreshShopifyAppPricingIfStale(
          {
            shop:
              session.shop,

            admin,
          },
        );

      billingChanged =
        billing.changed;
    } catch (error) {
      console.error(
        "[AI Search] Storefront billing refresh failed:",
        error,
      );
    }

    billingRefreshMs =
      Date.now() -
      billingStartedAt;

    if (billingChanged) {
      // Billing changes must be applied before this request evaluates search
      // eligibility; otherwise an old active-product set can temporarily sit
      // above the new product limit.
      await reconcileShopCommercialState({
        shop: session.shop,
        forceCatalogRefresh: true,
      });
    }

    const entitlementStartedAt =
      Date.now();

    let entitlement =
      await getShopEntitlement(
        session.shop,
      );

    // Safety net for any out-of-band limit reduction (for example an expired
    // product grant or support override). Reconcile synchronously once before
    // deciding whether AI Search is allowed.
    if (entitlement.productLimitExceeded) {
      await reconcileShopCommercialState({
        shop: session.shop,
      });
      entitlement = await getShopEntitlement(session.shop);
    }

    entitlementDbMs =
      Date.now() -
      entitlementStartedAt;

    const fallback =
      async (
        reason: string,
      ) => {
        try {
          await recordFallback({
            shop:
              session.shop,

            periodId:
              entitlement.usage.id,

            query,

            reason,
          });
        } catch (error) {
          console.error(
            "[AI Search] Fallback usage logging failed:",
            error,
          );
        }

        return nativeRedirect(
          query,
          nativeSearchTarget,
          reason,
        );
      };

    if (
      !entitlement.searchAllowed
    ) {
      return fallback(
        entitlement.disabledReason ??
          "AI_SEARCH_UNAVAILABLE",
      );
    }

    if (
      entitlement.indexedProducts <=
      0
    ) {
      return fallback(
        "CATALOG_EMPTY",
      );
    }

    // ============================================================
    // STORED THEME MAP LOOKUP
    //
    // V4 needs a stored Theme Map. Custom Data Mode renders through
    // the app-owned dedicated renderer and skips this lookup.
    // ============================================================

    let syncedThemeMap:
      | ThemeMapV4
      | null =
      null;

    let preflightMap:
      | {
          theme: {
            id: string;
            gid: string;
          };
          fingerprint: string;
          search: {
            searchTemplate: string;
          };
        }
      | null =
      null;

    if (!isCustomDataMode) {
      const themeMapLookupStartedAt =
        Date.now();

      const clientThemeId =
        requestUrl.searchParams.get(
          "theme_id",
        );

      const clientFingerprint =
        requestUrl.searchParams.get(
          "map_fingerprint",
        );

      const storedTheme =
        await loadSyncedThemeMapForStorefront({
          shop:
            session.shop,

          themeId:
            clientThemeId,

          fingerprint:
            clientFingerprint,
        });

      themeMapLookupMs =
        Date.now() -
        themeMapLookupStartedAt;

      if (storedTheme.ok === false) {
        return fallback(
          storedTheme.reason,
        );
      }

      syncedThemeMap =
        storedTheme.map;

      preflightMap = {
        theme: {
          id:
            syncedThemeMap.theme.id,

          gid:
            `gid://shopify/Theme/${syncedThemeMap.theme.id}`,
        },

        fingerprint:
          syncedThemeMap.fingerprint,

        search: {
          searchTemplate:
            syncedThemeMap.search
              .templateFile,
        },
      };
    }

    const pageSize =
      THEME_MAP_V4_DEFAULT_PAGE_SIZE;

    // =========================================================================
    // TRã»ß╗£NG Hß╗óP 2: T├îM Tß╗¬ KH├ôA Mß╗ÜI
    // =========================================================================

    const reservationStartedAt =
      Date.now();

    const reservationResult =
      await reserveSearchUsage({
        shop:
          session.shop,

        periodId:
          entitlement.usage.id,

        searchLimit:
          entitlement.limits
            .searchLimit,

        query,
      });

    usageReservationDbMs =
      Date.now() -
      reservationStartedAt;

    if (
      !reservationResult.allowed
    ) {
      return fallback(
        "SEARCH_QUOTA_EXCEEDED",
      );
    }

    const reservation:
      UsageReservation =
      reservationResult.reservation;

    const startedAt =
      Date.now();

    let executionPhase:
      | "rewrite"
      | "semanticSearch"
      | "genderFilter"
      | "priceFilter"
      | "resultMapping"
      | "analytics"
      | "saveSearchResult"
      | "responseBuild" =
      "rewrite";

    try {
      console.time(
        "[PERF-PROXY] 2. Semantic Search (OpenAI/Vector Cache + Qdrant)",
      );

      const rewriteStartedAt =
        Date.now();

      const queryRouterEnabled = !["0", "false", "off", "no"].includes(
        process.env.AI_SEARCH_QUERY_ROUTER_ENABLED?.trim().toLowerCase() ?? "",
      );
      const queryPlanStartedAt = Date.now();
      const queryPlan = queryRouterEnabled
        ? await buildQueryPlan(session.shop, query)
        : null;

      executionPhase =
        "rewrite";

      const interpretedQuery = queryPlan
        ? await prepareQueryRewrite({ shop: session.shop, query, plan: queryPlan })
        : await import("../services/search/query-rewriter.server").then(({ rewriteSearchQuery }) =>
            rewriteSearchQuery({ shop: session.shop, query }),
          );

      if (queryPlan) {
        console.log("[AI Search][QUERY PLAN]", {
          shop: session.shop,
          query,
          route: queryPlan.route,
          resolvedSegments: queryPlan.resolvedSegments,
          unresolvedSegments: queryPlan.unresolvedSegments,
          semanticQuery: queryPlan.semanticQuery,
          semanticResolution: interpretedQuery.planning?.semanticResolution,
          semanticResolutionConfidence:
            interpretedQuery.planning?.semanticResolutionConfidence,
          routerReason: queryPlan.routerReason,
          llmCalled: interpretedQuery.timing?.llmCallCount === 1,
          embeddingExpected: queryPlan.route !== "STRUCTURED_ONLY",
          planAndLlmMs: Date.now() - queryPlanStartedAt,
          versions: queryPlan.versions,
        });
      }

      const preparedRewrite =
        await applyShopContextToQuery(
          {
            shop:
              session.shop,

            originalQuery:
              query,

            rewrite:
              interpretedQuery,
          },
        );

      const rewriteMs =
        Date.now() -
        rewriteStartedAt;

      const sortIntent =
        preparedRewrite.analysis
          .sortIntent;

      const embeddingCacheStartedAt =
        Date.now();

      const cachedVector =
        preparedRewrite.catalogRelevant
          ? getCachedQueryEmbedding(
              session.shop,
              preparedRewrite.query,
            )
          : null;

      const embeddingCacheMs =
        Date.now() -
        embeddingCacheStartedAt;

      let queryVectorForAnalytics:
        | number[]
        | null =
        cachedVector;

      let searchDiagnostics:
        | SemanticSearchDiagnostics
        | null =
        null;

      executionPhase =
        "semanticSearch";

      let rawSearchResults;
      if (queryPlan?.route === "STRUCTURED_ONLY") {
        const structuredStartedAt = Date.now();
        rawSearchResults = await retrieveStructuredCandidates({
          shop: session.shop,
          plan: queryPlan,
          limit: SEARCH_LIMIT,
        });
        console.log("[AI Search][STRUCTURED RETRIEVAL]", {
          shop: session.shop,
          route: queryPlan.route,
          resultCount: rawSearchResults.length,
          durationMs: Date.now() - structuredStartedAt,
          llmCalled: false,
          embeddingCalled: false,
          qdrantCalled: false,
        });
      }

      if (!rawSearchResults || rawSearchResults.length === 0) {
        if (queryPlan?.route === "STRUCTURED_ONLY") {
          console.log("[AI Search][ROUTE FALLBACK]", {
            shop: session.shop,
            from: "STRUCTURED_ONLY",
            to: "VECTOR_SEMANTIC",
            reason: "NO_STRUCTURED_CANDIDATES",
          });
        }
        rawSearchResults = await semanticSearch({
          preparedRewrite,

          shop:
            session.shop,

          query,

          vectorOverride:
            cachedVector ??
            undefined,

          limit:
            SEARCH_LIMIT,

          onEmbeddingCreated:
            async (
              vector,
              metadata,
            ) => {
              queryVectorForAnalytics =
                vector;

              if (
                vector &&
                metadata.cacheable
              ) {
                setCachedQueryEmbedding(
                  session.shop,
                  preparedRewrite.query,
                  vector,
                );
              }

              try {
                await recordQueryEmbeddingConsumed(
                  reservation,
                );
              } catch (
                usageError
              ) {
                console.error(
                  "[AI Search] Query embedding usage logging failed:",
                  usageError,
                );
              }
            },

          onDiagnostics:
            (diagnostics) => {
              searchDiagnostics =
                diagnostics;
            },
        });
      }

      console.timeEnd(
        "[PERF-PROXY] 2. Semantic Search (OpenAI/Vector Cache + Qdrant)",
      );

      let genderDiagnostics:
        | ExplicitGenderFilterDiagnostics
        | null =
        null;

      executionPhase =
        "genderFilter";

      const genderFilteredResults =
        await filterResultsByExplicitGender(
          {
            shop:
              session.shop,

            originalQuery:
              query,

            rewrite:
              preparedRewrite,

            results:
              rawSearchResults,

            onDiagnostics:
              (diagnostics) => {
                genderDiagnostics =
                  diagnostics;
              },
          },
        );

      const priceConstraintStartedAt =
        Date.now();

      const priceConstraint =
        parsePriceConstraint(
          query,
        );

      const priceConstraintParseCodeMs =
        Date.now() -
        priceConstraintStartedAt;

      let searchResults =
        genderFilteredResults;

      const preferenceStartedAt =
        Date.now();

      let priceDiagnostics:
        | SearchPriceFilterDiagnostics
        | null =
        null;

      executionPhase =
        "priceFilter";

      if (
        priceConstraint ||
        sortIntent !==
          "RELEVANCE"
      ) {
        try {
          searchResults =
            await filterSearchResultsByPrice(
              {
                admin,

                shop:
                  session.shop,

                results:
                  genderFilteredResults,

                constraint:
                  priceConstraint,

                sortIntent,

                onDiagnostics:
                  (
                    diagnostics,
                  ) => {
                    priceDiagnostics =
                      diagnostics;
                  },
              },
            );
        } catch (error) {
          searchResults =
            priceConstraint
              ? []
              : genderFilteredResults;

          console.error(
            "[AI Search] Hard price filter failed closed",
            {
              shop:
                session.shop,

              priceConstraint,

              error:
                error instanceof Error
                  ? error.message
                  : String(error),
            },
          );
        }
      }

      const preferenceMs =
        Date.now() -
        preferenceStartedAt;

      executionPhase =
        "resultMapping";

      const resultMappingStartedAt =
        Date.now();

      const seen =
        new Set<string>();

      const allProducts:
        CandidateProduct[] =
        searchResults.flatMap(
          (result) => {
            const id =
              result.productId.match(
                /^(?:gid:\/\/shopify\/Product\/)?(\d+)$/,
              )?.[1] ||
              result.productId;

            if (!id) {
              return [];
            }

            if (
              seen.has(id)
            ) {
              return [];
            }

            seen.add(id);

            return [
              {
                id,

                handle:
                  result.handle,

                rank:
                  seen.size,

                score:
                  result.score,
              },
            ];
          },
        );

      const resultMappingCodeMs =
        Date.now() -
        resultMappingStartedAt;

      let searchLogId:
        | string
        | null =
        null;

      const searchLogStartedAt =
        Date.now();

      let analyticsSerializationCodeMs =
        0;

      let analyticsDbWriteMs =
        0;

      executionPhase =
        "analytics";

      if (
        requestedPage === 1 &&
        searchDiagnostics
      ) {
        try {
          searchLogId =
            await recordSearchQueryLog(
              {
                shop:
                  session.shop,

                query,

                analyzedQuery:
                  preparedRewrite.query,

                llmAnalysis:
                  preparedRewrite.analysis,

                selectedContext:
                  preparedRewrite
                    .context
                    .selectedTerms,

                queryVector:
                  allProducts.length ===
                  0
                    ? queryVectorForAnalytics
                    : null,

                rankedProducts:
                  allProducts.map(
                    (product) => ({
                      productId:
                        product.id,

                      handle:
                        product.handle,

                      rank:
                        product.rank,

                      score:
                        product.score,
                    }),
                  ),

                diagnostics:
                  searchDiagnostics,

                totalDurationMs:
                  Date.now() -
                  startedAt,

                onDiagnostics:
                  (
                    diagnostics,
                  ) => {
                    analyticsSerializationCodeMs =
                      diagnostics.serializationCodeMs;

                    analyticsDbWriteMs =
                      diagnostics.dbWriteMs;
                  },
              },
            );
        } catch (
          analyticsError
        ) {
          console.error(
            "[AI Search] Search analytics log failed:",
            {
              shop:
                session.shop,

              error:
                analyticsError instanceof
                Error
                  ? analyticsError.message
                  : String(
                      analyticsError,
                    ),
            },
          );
        }
      }

      const searchLogMs =
        Date.now() -
        searchLogStartedAt;

      const semanticTiming =
        searchDiagnostics as
          | SemanticSearchDiagnostics
          | null;

      const priceTiming =
        priceDiagnostics as
          | SearchPriceFilterDiagnostics
          | null;

      const measuredPureCodeMs =
        normalizeMs +
        requestRoutingCodeMs +
        (preparedRewrite.timing
          ?.normalizeCodeMs ??
          0) +
        (preparedRewrite.timing
          ?.cacheLookupCodeMs ??
          0) +
        (preparedRewrite.timing
          ?.responseParseCodeMs ??
          0) +
        (preparedRewrite.timing
          ?.cacheWriteCodeMs ??
          0) +
        preparedRewrite.context
          .aggregateCodeMs +
        preparedRewrite.context
          .signalBuildCodeMs +
        preparedRewrite.context
          .scoreCodeMs +
        preparedRewrite.context
          .sortSelectCodeMs +
        preparedRewrite.context
          .composeCodeMs +
        ((genderDiagnostics as
          | ExplicitGenderFilterDiagnostics
          | null)
          ?.filterCodeMs ??
          0) +
        (semanticTiming
          ?.embeddingPreparationCodeMs ??
          0) +
        (semanticTiming
          ?.qdrantResponseMappingCodeMs ??
          0) +
        (semanticTiming
          ?.thresholdFilterCodeMs ??
          0) +
        (semanticTiming
          ?.resultMappingCodeMs ??
          0) +
        priceConstraintParseCodeMs +
        (priceTiming
          ?.normalizeIdsCodeMs ??
          0) +
        (priceTiming
          ?.filterCodeMs ??
          0) +
        (priceTiming
          ?.sortCodeMs ??
          0) +
        resultMappingCodeMs +
        analyticsSerializationCodeMs;

      const measuredDbMs =
        entitlementDbMs +
        usageReservationDbMs +
        (preparedRewrite.timing
          ?.settingsDbMs ??
          0) +
        preparedRewrite.context
          .dbReadMs +
        ((genderDiagnostics as
          | ExplicitGenderFilterDiagnostics
          | null)
          ?.dbReadMs ??
          0) +
        analyticsDbWriteMs;

      console.log(
        "[AI Search][TIMING]",
        {
          shop:
            session.shop,

          queryLength:
            query.length,

          normalizeMs,

          authMs,

          requestRoutingCodeMs,

          billingRefreshMs,

          entitlementDbMs,

          themeMapLookupMs,
          themeMapLookupMode: "STORED_DB_ONLY",

          usageReservationDbMs,

          resultCacheMs,

          resultCacheStatus,

          rewriteCacheStatus:
            preparedRewrite.timing
              ?.cacheStatus ??
            "BYPASS",

          rewriteComplexityRoute:
            preparedRewrite.timing
              ?.complexityRoute ??
            "SIMPLE",

          rewriteTimeoutBudgetMs:
            preparedRewrite.timing
              ?.timeoutBudgetMs ??
            0,

          rewriteMs,

          queryNormalizeCodeMs:
            preparedRewrite.timing
              ?.normalizeCodeMs ??
            0,

          querySettingsDbMs:
            preparedRewrite.timing
              ?.settingsDbMs ??
            0,

          rewriteCacheLookupCodeMs:
            preparedRewrite.timing
              ?.cacheLookupCodeMs ??
            0,

          rewritePendingWaitMs:
            preparedRewrite.timing
              ?.pendingWaitMs ??
            0,

          llmResponseParseCodeMs:
            preparedRewrite.timing
              ?.responseParseCodeMs ??
            0,

          rewriteCacheWriteCodeMs:
            preparedRewrite.timing
              ?.cacheWriteCodeMs ??
            0,

          rewriteOtherCodeMs:
            preparedRewrite.timing
              ?.otherCodeMs ??
            0,

          shopContextLoadMs:
            preparedRewrite.context
              .loadMs,

          shopContextFilterMs:
            preparedRewrite.context
              .filterMs,

          shopContextTerms:
            preparedRewrite.context
              .selectedTerms.length,

          shopContextCacheStatus:
            preparedRewrite.context
              .cacheStatus,

          shopContextDbReadMs:
            preparedRewrite.context
              .dbReadMs,

          shopContextAggregateCodeMs:
            preparedRewrite.context
              .aggregateCodeMs,

          shopContextSignalBuildCodeMs:
            preparedRewrite.context
              .signalBuildCodeMs,

          shopContextScoreCodeMs:
            preparedRewrite.context
              .scoreCodeMs,

          shopContextSortSelectCodeMs:
            preparedRewrite.context
              .sortSelectCodeMs,

          shopContextComposeCodeMs:
            preparedRewrite.context
              .composeCodeMs,

          requestedGender:
            (genderDiagnostics as
              | ExplicitGenderFilterDiagnostics
              | null)
              ?.requestedGender ??
            null,

          genderFilterDbMs:
            (genderDiagnostics as
              | ExplicitGenderFilterDiagnostics
              | null)
              ?.dbReadMs ??
            0,

          genderFilterCodeMs:
            (genderDiagnostics as
              | ExplicitGenderFilterDiagnostics
              | null)
              ?.filterCodeMs ??
            0,

          genderFilteredCount:
            (genderDiagnostics as
              | ExplicitGenderFilterDiagnostics
              | null)
              ?.genderFilteredCount ??
            0,

          identityFilteredCount:
            (genderDiagnostics as
              | ExplicitGenderFilterDiagnostics
              | null)
              ?.identityFilteredCount ??
            0,

          colorFilteredCount:
            (genderDiagnostics as
              | ExplicitGenderFilterDiagnostics
              | null)
              ?.colorFilteredCount ??
            0,

          negativeFilteredCount:
            (genderDiagnostics as
              | ExplicitGenderFilterDiagnostics
              | null)
              ?.negativeFilteredCount ??
            0,

          contextRerankedCount:
            (genderDiagnostics as
              | ExplicitGenderFilterDiagnostics
              | null)
              ?.rerankedCount ??
            0,

          exactConstraintFilteredCount:
            (genderDiagnostics as
              | ExplicitGenderFilterDiagnostics
              | null)
              ?.exactConstraintFilteredCount ??
            0,

          openAiLlmMs:
            preparedRewrite.timing
              ?.llmMs ??
            0,

          llmCalls:
            preparedRewrite.timing
              ?.llmCallCount ??
            0,

          llmInputTokens:
            preparedRewrite.timing
              ?.inputTokens ??
            null,

          llmOutputTokens:
            preparedRewrite.timing
              ?.outputTokens ??
            null,

          embeddingCacheMs,

          embeddingCacheStatus:
            cachedVector
              ? "HIT"
              : "MISS",

          openAiEmbeddingMs:
            (searchDiagnostics as
              | SemanticSearchDiagnostics
              | null)
              ?.embeddingMs ??
            0,

          openAiEmbeddingProcessingMs:
            (searchDiagnostics as
              | SemanticSearchDiagnostics
              | null)
              ?.embeddingOpenAiProcessingMs ??
            null,

          embeddingNetworkAndSdkMs:
            (searchDiagnostics as
              | SemanticSearchDiagnostics
              | null)
              ?.embeddingNetworkAndSdkMs ??
            null,

          embeddingRequestId:
            (searchDiagnostics as
              | SemanticSearchDiagnostics
              | null)
              ?.embeddingRequestId ??
            null,

          embeddingClientRequestId:
            (searchDiagnostics as
              | SemanticSearchDiagnostics
              | null)
              ?.embeddingClientRequestId ??
            null,

          embeddingMaxRetries:
            (searchDiagnostics as
              | SemanticSearchDiagnostics
              | null)
              ?.embeddingMaxRetries ??
            0,

          embeddingCalls:
            (searchDiagnostics as
              | SemanticSearchDiagnostics
              | null)
              ?.embeddingCallCount ??
            0,

          qdrantEnsureMs:
            (searchDiagnostics as
              | SemanticSearchDiagnostics
              | null)
              ?.ensureCollectionMs ??
            0,

          qdrantMs:
            (searchDiagnostics as
              | SemanticSearchDiagnostics
              | null)
              ?.qdrantMs ??
            0,

          usageLoggingMs:
            (searchDiagnostics as
              | SemanticSearchDiagnostics
              | null)
              ?.usageLoggingMs ??
            0,

          qdrantCollectionWaitMs:
            (searchDiagnostics as
              | SemanticSearchDiagnostics
              | null)
              ?.collectionWaitMs ??
            0,

          embeddingPreparationCodeMs:
            (searchDiagnostics as
              | SemanticSearchDiagnostics
              | null)
              ?.embeddingPreparationCodeMs ??
            0,

          qdrantRequestMs:
            (searchDiagnostics as
              | SemanticSearchDiagnostics
              | null)
              ?.qdrantRequestMs ??
            0,

          qdrantResponseMappingCodeMs:
            (searchDiagnostics as
              | SemanticSearchDiagnostics
              | null)
              ?.qdrantResponseMappingCodeMs ??
            0,

          qdrantPassCount:
            (searchDiagnostics as
              | SemanticSearchDiagnostics
              | null)
              ?.qdrantPassCount ??
            0,

          qdrantFinalCandidateWindow:
            (searchDiagnostics as
              | SemanticSearchDiagnostics
              | null)
              ?.qdrantFinalCandidateWindow ??
            0,

          thresholdFilterCodeMs:
            (searchDiagnostics as
              | SemanticSearchDiagnostics
              | null)
              ?.thresholdFilterCodeMs ??
            0,

          semanticResultMappingCodeMs:
            (searchDiagnostics as
              | SemanticSearchDiagnostics
              | null)
              ?.resultMappingCodeMs ??
            0,

          semanticOtherCodeMs:
            (searchDiagnostics as
              | SemanticSearchDiagnostics
              | null)
              ?.otherCodeMs ??
            0,

          preferenceMs,

          priceConstraintParseCodeMs,

          priceNormalizeIdsCodeMs:
            (priceDiagnostics as
              | SearchPriceFilterDiagnostics
              | null)
              ?.normalizeIdsCodeMs ??
            0,

          shopifyPriceApiMs:
            (priceDiagnostics as
              | SearchPriceFilterDiagnostics
              | null)
              ?.shopifyApiMs ??
            0,

          pricePayloadHits:
            (priceDiagnostics as
              | SearchPriceFilterDiagnostics
              | null)
              ?.payloadPriceHits ??
            0,

          priceShopifyMisses:
            (priceDiagnostics as
              | SearchPriceFilterDiagnostics
              | null)
              ?.shopifyPriceMisses ??
            0,

          priceFilterCodeMs:
            (priceDiagnostics as
              | SearchPriceFilterDiagnostics
              | null)
              ?.filterCodeMs ??
            0,

          priceSortCodeMs:
            (priceDiagnostics as
              | SearchPriceFilterDiagnostics
              | null)
              ?.sortCodeMs ??
            0,

          resultMappingCodeMs,

          searchLogMs,

          analyticsSerializationCodeMs,

          analyticsDbWriteMs,

          measuredPureCodeMs,

          measuredDbMs,

          measuredModelApiMs:
            (preparedRewrite.timing
              ?.llmMs ??
              0) +
            (semanticTiming
              ?.embeddingMs ??
              0),

          measuredQdrantApiMs:
            semanticTiming
              ?.qdrantRequestMs ??
            0,

          measuredShopifyPriceApiMs:
            priceTiming
              ?.shopifyApiMs ??
            0,

          aiBackendMs:
            Date.now() -
            startedAt,

          totalProxyMs:
            Date.now() -
            proxyStartedAt,
        },
      );

      if (isCustomDataMode) {
        const allIds =
          allProducts.map(
            (product) =>
              product.id,
          );

        const dynamicPageSize =
          entitlement.resultLimit &&
          entitlement.resultLimit > 0
            ? entitlement.resultLimit
            : 5;

        const appSelfRenderPage =
          await renderAppSelfSearchPage({
            admin,
            query,
            productIds:
              allIds,
            pageSize:
              dynamicPageSize,
          });

        try {
          await markUsageReservationEffectApplied(
            reservation,
          );
        } catch (usageError) {
          console.error(
            "[AI Search][Custom Data Mode] search reservation effect marker failed:",
            usageError,
          );
        }

        try {
          await commitSearchUsage(
            reservation,
            {
              resultCount:
                allProducts.length,

              durationMs:
                Date.now() -
                startedAt,

              rendererSource:
                "custom-dedicated-page",
            },
          );
        } catch (usageError) {
          console.error(
            "[AI Search][Custom Data Mode] search usage commit logging failed:",
            usageError,
          );
        }

        return liquid(
          appSelfRenderPage.html,
          {
            layout: true,
            headers: {
              "Cache-Control":
                "no-store",
            },
          },
        );
      }

      if (
        !syncedThemeMap ||
        !preflightMap
      ) {
        throw new Error(
          "THEME_MAP_MISSING_AFTER_PREFLIGHT",
        );
      }

      // V4 migration state:
      // persist ranked list once.
      // Pagination/render reuses receipt.

      executionPhase =
        "saveSearchResult";

      const cachedSearch =
        await saveSearchResult({
          shop:
            session.shop,

          query,

          searchLogId,

          rankedProducts:
            allProducts.map(
              (product) => ({
                productId:
                  `gid://shopify/Product/${product.id}`,

                handle:
                  product.handle,

                score:
                  product.score,
              }),
            ),
        });

      const paginationStartedAt =
        Date.now();

      const pagination =
        buildShopifyProductQuery(
          allProducts,
          requestedPage,
          pageSize,
        );

      const paginationCodeMs =
        Date.now() -
        paginationStartedAt;

      /**
       * FAST PATH ÔÇö THEME CONTEXT PAGE 1/CURRENT PAGE
       *
       * Semantic search ─æ├ú c├│ ranked product IDs v├á Theme Map ─æ├ú ─æã░ß╗úc
       * load ß╗ƒ ─æß║ºu request. Nß║┐u candidate cß║ºn Shopify Section Rendering,
       * build lu├┤n transport plan trong response search ─æß║ºu ti├¬n ─æß╗â browser
       * kh├┤ng phß║úi gß╗ìi th├¬m transport-v4 trã░ß╗øc khi render.
       *
       * ─É├óy l├á best-effort optimization. Lß╗ùi build plan KH├öNG ─æã░ß╗úc ph├®p
       * l├ám hß╗Ång semantic search; client vß║½n c├│ thß╗â gß╗ìi transport-v4 nhã░
       * ─æã░ß╗Øng c┼®.
       */
      let initialTransportPlan:
        | Record<string, unknown>
        | null =
        null;

      let initialTransportPlanMs =
        0;

      const themeContextCandidate =
        getThemeContextTransportCandidate(
          syncedThemeMap,
        );

      if (
        themeContextCandidate?.mount &&
        pagination.pageProducts.length > 0
      ) {
        const initialTransportStartedAt =
          Date.now();

        try {
          const targetProductIds =
            pagination.pageProducts.map(
              (product) =>
                `gid://shopify/Product/${product.id}`,
            );

          const transportPlannerOptions =
            themeTransportPlannerOptions(
              syncedThemeMap,
            );

          const transportPlan =
            await planThemeSearchTransportFromStoredKeys(
              {
                shop:
                  session.shop,

                productIds:
                  targetProductIds,

                options:
                  transportPlannerOptions,
              },
            );

          if (transportPlan.safeToRender) {
            initialTransportPlan = {
              status:
                "success",

              engine:
                "theme-context-transport-v4",

              render_strategy:
                "THEME_CONTEXT_REQUIRED",

              theme_id:
                syncedThemeMap.theme.id,

              map_fingerprint:
                syncedThemeMap.fingerprint,

              transport_profile:
                readThemeTransportProfile(
                  syncedThemeMap,
                ),

              receipt:
                cachedSearch.receiptId,

              search_log_id:
                searchLogId,

              candidate: {
                id:
                  themeContextCandidate.id,

                type:
                  themeContextCandidate.type,

                source_file:
                  themeContextCandidate.sourceFile,
              },

              mount:
                themeContextCandidate.mount,

              search_section: {
                template_file:
                  syncedThemeMap.search
                    .templateFile,

                template_type:
                  syncedThemeMap.search
                    .templateType,

                section_key:
                  syncedThemeMap.search
                    .sectionKey ??
                  null,

                section_type:
                  syncedThemeMap.search
                    .sectionType ??
                  null,

                section_file:
                  syncedThemeMap.search
                    .sectionFile ??
                  null,
              },

              safeToRender:
                true,

              targetProductIds:
                transportPlan
                  .targetProductIds,

              resolved:
                transportPlan.resolved,

              unresolved:
                transportPlan.unresolved,

              batches:
                transportPlan.batches,

              pagination: {
                current_page:
                  pagination.currentPage,

                page_size:
                  pagination.pageSize,

                total_products:
                  pagination.totalProducts,

                total_pages:
                  pagination.totalPages,
              },
            };
          } else {
            console.warn(
              "[AI Search][Initial Theme Context Transport V4] unsafe plan; keeping legacy transport-v4 fallback",
              {
                shop:
                  session.shop,

                receiptId:
                  cachedSearch.receiptId,

                page:
                  pagination.currentPage,

                targetCount:
                  transportPlan
                    .targetProductIds
                    .length,

                unresolved:
                  transportPlan.unresolved,
              },
            );
          }
        } catch (transportError) {
          console.warn(
            "[AI Search][Initial Theme Context Transport V4] build failed; keeping legacy transport-v4 fallback",
            {
              shop:
                session.shop,

              receiptId:
                cachedSearch.receiptId,

              page:
                pagination.currentPage,

              error:
                transportError instanceof Error
                  ? transportError.message
                  : String(transportError),
            },
          );
        } finally {
          initialTransportPlanMs =
            Date.now() -
            initialTransportStartedAt;
        }
      }

      executionPhase =
        "responseBuild";

      const responseBuildStartedAt =
        Date.now();

      const response =
        Response.json(
          {
            status:
              "success",

            engine:
              "ai-search-v4",

            query,

            theme_id:
              preflightMap.theme.id,

            map_fingerprint:
              preflightMap.fingerprint,

            render_receipt: {
              id:
                cachedSearch.receiptId,

              expires_at:
                new Date(
                  cachedSearch.expiresAt,
                ).toISOString(),

              total_products:
                cachedSearch.total,
            },

            initial_transport_plan:
              initialTransportPlan,

            applied_filters: {
              sort_intent:
                sortIntent,

              price:
                priceConstraint,
            },

            search_log_id:
              searchLogId,

            pagination: {
              current_page:
                pagination.currentPage,

              page_size:
                pagination.pageSize,

              total_products:
                pagination.totalProducts,

              total_pages:
                pagination.totalPages,
            },
          },
          {
            headers: {
              "Cache-Control":
                "no-store",
            },
          },
        );

      const responseBuildCodeMs =
        Date.now() -
        responseBuildStartedAt;

      const usageCommitStartedAt =
        Date.now();

      try {
        await markUsageReservationEffectApplied(
          reservation,
        );
      } catch (usageError) {
        console.error(
          "[AI Search] Search reservation effect marker failed:",
          usageError,
        );
      }

      try {
        await commitSearchUsage(
          reservation,
          {
            resultCount:
              allProducts.length,

            durationMs:
              Date.now() -
              startedAt,

            themeId:
              preflightMap.theme
                .gid,

            rendererSource:
              preflightMap.search
                ?.searchTemplate ??
              "native-search",
          },
        );
      } catch (usageError) {
        console.error(
          "[AI Search] Search usage commit logging failed:",
          usageError,
        );
      }

      const usageCommitDbMs =
        Date.now() -
        usageCommitStartedAt;

      console.log(
        "[AI Search][REQUEST COMPLETE]",
        {
          shop:
            session.shop,

          paginationCodeMs,

          initialTransportPlanMs,

          initialTransportPlanStatus:
            initialTransportPlan
              ? "READY"
              : "NOT_READY",

          responseBuildCodeMs,

          usageCommitDbMs,

          aiBackendMs:
            Date.now() -
            startedAt,

          totalProxyMs:
            Date.now() -
            proxyStartedAt,
        },
      );

      return response;
    } catch (error) {
      console.error(
        "[AI Search] AI execution failed",
        {
          shop:
            session.shop,

          query,

          phase:
            executionPhase,

          error:
            error instanceof Error
              ? {
                  name:
                    error.name,

                  message:
                    error.message,

                  stack:
                    error.stack,
                }
              : String(error),
        },
      );

      try {
        await rollbackSearchUsage(
          reservation,
          error,
        );
      } catch (usageError) {
        console.error(
          "[AI Search] Search usage rollback failed:",
          usageError,
        );
      }

      return fallback(
        "AI_SEARCH_RUNTIME_ERROR",
      );
    }
  } catch (error) {
    return nativeRedirect(
      query,
      nativeSearchTarget,
      "APP_PROXY_FATAL_ERROR",
    );
  } finally {
    console.timeEnd(
      "[PERF-PROXY] TOTAL PROXY REQUEST",
    );
  }
};
