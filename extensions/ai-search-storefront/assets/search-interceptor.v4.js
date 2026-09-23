(function () {
  "use strict";

  if (window.AI_SEARCH_ENGINE !== "v4") return;

  if (window.__aiSearchV4Installed) return;
  window.__aiSearchV4Installed = true;

  const config = window.AI_SEARCH_CONFIG || {};
  const endpoint = config.search_endpoint || "/apps/ai-search";
  const clickEndpoint = endpoint.replace(/\/+$/, "") + "/click";
  const stateKey = "aiSearchV4";
  const receiptPattern = /^srch_[A-Za-z0-9_-]+$/;
  const logPrefix = "[AI SEARCH V4]";
  const mountCacheKey = `ai_search_v4_mount_${String(
    config.theme_id || window.Shopify?.theme?.id || "unknown",
  )}`;
  let concealedMount = null;
  let loadingSkeleton = null;
  let activeMount = null;
  const UI_STATE = Object.freeze({
    IDLE: "IDLE",
    INITIAL_SEARCH_LOADING: "INITIAL_SEARCH_LOADING",
    IN_PLACE_SEARCH_LOADING: "IN_PLACE_SEARCH_LOADING",
    PAGINATION_LOADING: "PAGINATION_LOADING",
    AI_READY: "AI_READY",
    NATIVE_FALLBACK: "NATIVE_FALLBACK",
  });
  let uiState = UI_STATE.IDLE;

  function validateLoadingMount(recipe) {
    if (!recipe?.selector) return null;

    let matches;

    try {
      matches = document.querySelectorAll(recipe.selector);
    } catch {
      return null;
    }

    if (matches.length !== 1) return null;

    const mount = matches[0];
    const expectedTag = recipe.verification?.expectedTag;

    if (
      expectedTag &&
      mount.tagName.toLowerCase() !== String(expectedTag).toLowerCase()
    ) {
      return null;
    }

    return mount;
  }

  function rememberLoadingMount(recipe) {
    try {
      sessionStorage.setItem(mountCacheKey, JSON.stringify(recipe));
    } catch {
      // Search vẫn hoạt động nếu sessionStorage bị chặn.
    }
  }

  function concealNativeResults(recipe) {
    const mount = validateLoadingMount(recipe);

    if (!mount) return;

    if (concealedMount && concealedMount !== mount) {
      concealedMount.removeAttribute("data-ai-search-v4-concealed");
      concealedMount.removeAttribute("aria-busy");
    }

    concealedMount = mount;
    mount.setAttribute("data-ai-search-v4-concealed", "true");
    mount.setAttribute("aria-busy", "true");

    if (!loadingSkeleton?.isConnected) {
      loadingSkeleton = document.createElement("div");
      loadingSkeleton.dataset.aiSearchV4Skeleton = "";
      loadingSkeleton.setAttribute("role", "status");
      loadingSkeleton.setAttribute("aria-label", "Loading search results");
      loadingSkeleton.innerHTML = Array.from(
        { length: window.innerWidth < 750 ? 4 : 10 },
        function () {
          return '<span data-ai-search-v4-skeleton-card aria-hidden="true"><span></span><i></i><b></b></span>';
        },
      ).join("");
      mount.insertAdjacentElement("beforebegin", loadingSkeleton);
    }

    const fallbackSpinner = document.querySelector(
      "[data-ai-search-v4-loading]",
    );
    if (fallbackSpinner) fallbackSpinner.dataset.active = "false";
  }

  function concealCachedNativeResults() {
    const bootstrapRecipe = config.theme_map_bootstrap?.mount;

    if (bootstrapRecipe) {
      rememberLoadingMount(bootstrapRecipe);
      concealNativeResults(bootstrapRecipe);
      if (concealedMount) return;
    }

    try {
      const cached = JSON.parse(sessionStorage.getItem(mountCacheKey) || "null");
      concealNativeResults(cached);
    } catch {
      // Cache cũ/không hợp lệ không được phép chặn native storefront.
    }
  }

  let controller = null;
  let requestNumber = 0;
  let activeSearchLogId = null;
  let activeProducts = [];

  const renderedPageCache = new Map();
  const pagePrefetches = new Map();
  const PAGE_CACHE_LIMIT = 12;

  function isSearchPath(pathname) {
    return /\/search\/?$/.test(pathname || location.pathname);
  }

  function searchUrl(query, page = 1) {
    const url = new URL(config.search_url || "/search", location.origin);
    url.searchParams.set("q", query);
    url.searchParams.set("type", "product");

    if (page > 1) {
      url.searchParams.set("page", String(page));
    }

    return url;
  }

  function ensureLoadingUi() {
    if (!document.getElementById("ai-search-v4-loading-style")) {
      const style = document.createElement("style");
      style.id = "ai-search-v4-loading-style";
      style.textContent = `
        [data-ai-search-v4-loading] {
          position: fixed;
          inset: 0;
          z-index: 2147483000;
          display: none;
          align-items: center;
          justify-content: center;
          min-height: 100dvh;
          padding: 2rem;
          background: Canvas;
          color: CanvasText;
          pointer-events: auto;
          text-align: center;
        }

        [data-ai-search-v4-concealed="true"] {
          display: none !important;
        }

        [data-ai-search-v4-skeleton] {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(min(180px, 45%), 1fr));
          gap: 1.5rem;
          width: 100%;
          margin-block: 1rem;
        }

        [data-ai-search-v4-skeleton-card] {
          display: grid;
          gap: 0.75rem;
          min-width: 0;
        }

        [data-ai-search-v4-skeleton-card] > span,
        [data-ai-search-v4-skeleton-card] > i,
        [data-ai-search-v4-skeleton-card] > b {
          display: block;
          border-radius: 0.35rem;
          background: linear-gradient(90deg, Canvas 20%, color-mix(in srgb, CanvasText 10%, Canvas) 38%, Canvas 56%);
          background-size: 220% 100%;
          animation: ai-search-v4-shimmer 1.25s ease-in-out infinite;
        }

        [data-ai-search-v4-skeleton-card] > span {
          aspect-ratio: 4 / 5;
        }

        [data-ai-search-v4-skeleton-card] > i {
          width: 88%;
          height: 1rem;
        }

        [data-ai-search-v4-skeleton-card] > b {
          width: 42%;
          height: 0.85rem;
        }

        [data-ai-search-v4-reveal="true"] {
          animation: ai-search-v4-reveal 160ms ease-out both;
        }

        [data-ai-search-v4-busy="in-place"],
        [data-ai-search-v4-busy="pagination"] {
          opacity: 0.42;
          pointer-events: none !important;
          transition: opacity 140ms ease;
        }

        [data-ai-search-v4-busy="in-place"] {
          filter: grayscale(0.2);
        }

        @keyframes ai-search-v4-shimmer {
          to { background-position: -220% 0; }
        }

        @keyframes ai-search-v4-reveal {
          from { opacity: 0; transform: translateY(3px); }
          to { opacity: 1; transform: translateY(0); }
        }

        @media (prefers-reduced-motion: reduce) {
          [data-ai-search-v4-skeleton-card] > span,
          [data-ai-search-v4-skeleton-card] > i,
          [data-ai-search-v4-skeleton-card] > b,
          [data-ai-search-v4-reveal="true"] {
            animation: none;
          }
        }

        [data-ai-search-v4-loading][data-active="true"] {
          display: flex;
        }

        [data-ai-search-v4-spinner] {
          width: 36px;
          height: 36px;
          border: 3px solid currentColor;
          border-right-color: transparent;
          border-radius: 999px;
          animation: ai-search-v4-spin 0.8s linear infinite;
        }

        @keyframes ai-search-v4-spin {
          to { transform: rotate(360deg); }
        }
      `;

      (document.head || document.documentElement).appendChild(style);
    }

    let loading = document.querySelector("[data-ai-search-v4-loading]");

    if (!loading) {
      loading = document.createElement("div");
      loading.dataset.aiSearchV4Loading = "";
      loading.setAttribute("role", "status");
      loading.setAttribute("aria-live", "polite");
      loading.setAttribute("aria-label", "Loading search results");
      loading.innerHTML =
        '<span data-ai-search-v4-spinner aria-hidden="true"></span>' +
        '<strong style="display:block;margin-inline-start:1rem">Finding the best matches…</strong>';

      (document.body || document.documentElement).appendChild(loading);
    }

    return loading;
  }

  function showLoading() {
    const loading = ensureLoadingUi();
    concealCachedNativeResults();
    loading.dataset.active = concealedMount ? "false" : "true";
    document.documentElement.setAttribute("aria-busy", "true");
  }

  function setMountBusy(mount, kind) {
    if (!(mount instanceof Element)) return;
    activeMount = mount;
    mount.setAttribute("aria-busy", "true");
    mount.setAttribute("data-ai-search-v4-busy", kind);
    mount.inert = true;
  }

  function clearMountBusy() {
    if (!(activeMount instanceof Element)) return;
    activeMount.removeAttribute("aria-busy");
    activeMount.removeAttribute("data-ai-search-v4-busy");
    activeMount.inert = false;
  }

  function transitionUi(nextState, options) {
    const mount = options?.mount || activeMount;
    uiState = nextState;
    if (nextState === UI_STATE.INITIAL_SEARCH_LOADING) {
      clearMountBusy();
      showLoading();
      return;
    }
    if (nextState === UI_STATE.IN_PLACE_SEARCH_LOADING) {
      const loading = ensureLoadingUi();
      loading.dataset.active = "false";
      setMountBusy(mount, "in-place");
      document.documentElement.setAttribute("aria-busy", "true");
      return;
    }
    if (nextState === UI_STATE.PAGINATION_LOADING) {
      const loading = ensureLoadingUi();
      loading.dataset.active = "false";
      setMountBusy(mount, "pagination");
      document.documentElement.setAttribute("aria-busy", "true");
      return;
    }
    clearMountBusy();
    hideLoading();
  }

  function hideLoading() {
    const loading = document.querySelector("[data-ai-search-v4-loading]");

    if (loading) {
      loading.dataset.active = "false";
    }

    if (concealedMount) {
      const revealedMount = concealedMount;
      revealedMount.removeAttribute("data-ai-search-v4-concealed");
      revealedMount.removeAttribute("aria-busy");
      revealedMount.setAttribute("data-ai-search-v4-reveal", "true");
      window.setTimeout(function () {
        revealedMount.removeAttribute("data-ai-search-v4-reveal");
      }, 180);
      concealedMount = null;
    }

    loadingSkeleton?.remove();
    loadingSkeleton = null;

    document.documentElement.removeAttribute("aria-busy");
    document.documentElement.removeAttribute(
      "data-ai-search-v4-early-boot",
    );
    document.querySelector("[data-ai-search-v4-early-shell]")?.remove();
  }

  function clonePlainValue(value) {
    if (value == null) return value;

    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      return value;
    }
  }

  function currentThemeIdentity() {
    const themeId =
      config.theme_id ||
      history.state?.themeId ||
      window.Shopify?.theme?.id ||
      "";

    const fingerprint =
      config.map_fingerprint ||
      config.theme_map_fingerprint ||
      history.state?.fingerprint ||
      "";

    return {
      themeId: String(themeId || ""),
      fingerprint: String(fingerprint || ""),
    };
  }

  function renderedPageCacheKey(receipt, page, fingerprint, themeId) {
    const normalizedPage = Number.parseInt(String(page || "1"), 10);
    const normalizedThemeId = numericThemeId(themeId);
    const normalizedFingerprint = String(fingerprint || "").trim();

    if (
      !receiptPattern.test(String(receipt || "")) ||
      !Number.isSafeInteger(normalizedPage) ||
      normalizedPage <= 0 ||
      !normalizedThemeId ||
      !normalizedFingerprint
    ) {
      return "";
    }

    return [
      String(receipt),
      normalizedThemeId,
      normalizedFingerprint,
      String(normalizedPage),
    ].join(":");
  }

  function trimRenderedPageCache() {
    while (renderedPageCache.size > PAGE_CACHE_LIMIT) {
      const oldestKey = renderedPageCache.keys().next().value;

      if (!oldestKey) break;

      renderedPageCache.delete(oldestKey);
    }
  }

  function cacheRenderedElements(elements, metadata, products) {
    const key = renderedPageCacheKey(
      metadata?.receipt,
      metadata?.page,
      metadata?.fingerprint,
      metadata?.themeId,
    );

    if (!key) return;

    const html = Array.from(elements || [])
      .map(function (element) {
        return element instanceof Element ? element.outerHTML : "";
      })
      .join("");

    if (!html) return;

    renderedPageCache.delete(key);
    renderedPageCache.set(key, {
      html,
      metadata: clonePlainValue(metadata),
      products: clonePlainValue(products || []),
      cachedAt: Date.now(),
    });

    trimRenderedPageCache();
  }

  function cacheRenderedMount(mount, metadata) {
    cacheRenderedElements(
      Array.from(mount?.children || []),
      metadata,
      Array.isArray(metadata?.products) ? metadata.products : activeProducts,
    );
  }

  function restoreRenderedPageFromCache(
    receipt,
    page,
    fingerprint,
    themeId,
  ) {
    const key = renderedPageCacheKey(
      receipt,
      page,
      fingerprint,
      themeId,
    );

    if (!key) return null;

    const cached = renderedPageCache.get(key);

    if (!cached) return null;

    const metadata = clonePlainValue(cached.metadata);
    const mount = verifyMount(metadata, receipt);
    const template = document.createElement("template");

    template.innerHTML = cached.html;

    const nodes = Array.from(template.content.children);

    if (nodes.length === 0) {
      renderedPageCache.delete(key);
      return null;
    }

    suspendNativePaginationRuntime(mount, metadata.page);
    mount.replaceChildren(...nodes);

    activeProducts = Array.isArray(cached.products)
      ? clonePlainValue(cached.products)
      : [];

    metadata.products = activeProducts;

    activateRuntime(mount, metadata);

    renderedPageCache.delete(key);
    renderedPageCache.set(key, cached);

    console.info(logPrefix, "rendered page cache hit", {
      receipt,
      page: metadata.page,
      productCount: activeProducts.length,
    });

    return {
      mount,
      metadata,
    };
  }

  function fallback(query) {
    hideLoading();

    const url = searchUrl(query, 1);
    url.searchParams.set("_ai_search_bypass", "1");

    console.warn(logPrefix, "fallbackToNative", {
      query,
      target: url.pathname + url.search,
    });

    location.assign(url.href);
  }

  function publicState() {
    const params = new URLSearchParams(location.search);
    const page = Number.parseInt(params.get("page") || "1", 10);

    return {
      query: (params.get("q") || "").trim(),
      page: Number.isSafeInteger(page) && page > 0 ? page : 1,
      bypass: params.get("_ai_search_bypass") === "1",
      isSearchPage: isSearchPath(location.pathname),
      legacyReceipt: receiptPattern.test(params.get("receipt") || "")
        ? params.get("receipt") || ""
        : "",
    };
  }

  function runtimeStateFor(query, page) {
    const state = history.state;

    if (!state || state[stateKey] !== true) {
      return null;
    }

    if (state.query !== query || Number(state.page) !== Number(page)) {
      return null;
    }

    if (!receiptPattern.test(state.receipt || "")) {
      return null;
    }

    return state;
  }

  function writeUrl({
    query,
    page,
    receipt,
    replace,
    searchLogId,
    fingerprint,
    themeId,
  }) {
    const url = searchUrl(query, page);

    const state = {
      [stateKey]: true,
      query,
      page,
      receipt,
      searchLogId: searchLogId || null,
      fingerprint: fingerprint || null,
      themeId: themeId || null,
      pending: false,
    };

    history[replace ? "replaceState" : "pushState"](
      state,
      "",
      url.pathname + url.search,
    );
  }

  function writePendingUrl(query, replace) {
    const url = searchUrl(query, 1);
    history[replace ? "replaceState" : "pushState"](
      {
        [stateKey]: true,
        query,
        page: 1,
        pending: true,
      },
      "",
      url.pathname + url.search,
    );
  }

  function appendSyncedThemeIdentity(url) {
    const themeId =
      config.theme_id ||
      window.Shopify?.theme?.id ||
      "";

    const historyThemeId =
      history.state?.themeId ||
      "";

    const historyFingerprint =
      historyThemeId &&
      numericThemeId(historyThemeId) === numericThemeId(themeId)
        ? history.state?.fingerprint || ""
        : "";

    const fingerprint =
      config.map_fingerprint ||
      config.theme_map_fingerprint ||
      historyFingerprint ||
      "";

    if (themeId) {
      url.searchParams.set(
        "theme_id",
        String(themeId),
      );
    }

    if (fingerprint) {
      url.searchParams.set(
        "map_fingerprint",
        String(fingerprint),
      );
    }
  }

  function backendUrl(query) {
    const url = new URL(endpoint, location.origin);

    url.searchParams.set("q", query);
    url.searchParams.set("format", "json");
    url.searchParams.set("page", "1");

    const nativeUrl = searchUrl(query, 1);
    url.searchParams.set(
      "native_search_url",
      nativeUrl.pathname + nativeUrl.search,
    );

    appendSyncedThemeIdentity(url);

    return url.pathname + url.search;
  }

  function renderUrl(receipt, page, candidateId) {
    const url = new URL(endpoint, location.origin);

    url.searchParams.set("mode", "render-v4");
    url.searchParams.set("receipt", receipt);
    url.searchParams.set("page", String(page));

    if (candidateId) {
      url.searchParams.set("candidate_id", candidateId);
    }

    appendSyncedThemeIdentity(url);

    return url.pathname + url.search;
  }

  function transportUrl(receipt, page) {
    const url = new URL(endpoint, location.origin);

    url.searchParams.set("mode", "transport-v4");
    url.searchParams.set("format", "json");
    url.searchParams.set("receipt", receipt);
    url.searchParams.set("page", String(page));

    appendSyncedThemeIdentity(url);

    return url.pathname + url.search;
  }

  function isUsableThemeContextPlan(plan, receipt, page) {
    if (
      plan?.status !== "success" ||
      plan?.render_strategy !== "THEME_CONTEXT_REQUIRED" ||
      plan?.safeToRender !== true ||
      !plan.mount?.selector ||
      !Array.isArray(plan.targetProductIds) ||
      plan.targetProductIds.length === 0 ||
      !Array.isArray(plan.batches) ||
      plan.batches.length === 0
    ) {
      return false;
    }

    if (
      plan.receipt &&
      String(plan.receipt) !== String(receipt)
    ) {
      return false;
    }

    const planPage = Number(
      plan.pagination?.current_page || page,
    );

    return Number(planPage) === Number(page);
  }

  function parseRenderMetadata(encodedValue) {
    if (!encodedValue) {
      throw new Error("THEME_RENDER_METADATA_MISSING");
    }

    let metadata;

    try {
      metadata = JSON.parse(decodeURIComponent(encodedValue));
    } catch {
      throw new Error("THEME_RENDER_METADATA_INVALID");
    }

    if (metadata?.version !== 4 || !metadata.mount?.selector) {
      throw new Error("THEME_RENDER_METADATA_INVALID");
    }

    return metadata;
  }

  function decodeMetadata(response, template) {
    const headerValue = response.headers.get("X-AI-Search-Render-Meta");

    if (headerValue) {
      return parseRenderMetadata(headerValue);
    }

    const metadataNode = template.content.querySelector(
      'script[type="application/json"][data-ai-search-render-meta]',
    );

    if (!metadataNode) {
      throw new Error("THEME_RENDER_METADATA_MISSING");
    }

    const encodedValue = (metadataNode.textContent || "").trim();
    metadataNode.remove();

    return parseRenderMetadata(encodedValue);
  }

  function numericThemeId(value) {
    return String(value || "").replace(
      /^gid:\/\/shopify\/(?:OnlineStore)?Theme\//,
      "",
    );
  }

  function verifyMount(metadata, receipt) {
    const liveThemeId = numericThemeId(
      config.theme_id || window.Shopify?.theme?.id,
    );

    if (
      liveThemeId &&
      numericThemeId(metadata.themeId) !== liveThemeId
    ) {
      throw new Error("THEME_RENDER_ACTIVE_THEME_MISMATCH");
    }

    const fingerprintKey = `ai_search_v4_fp_${receipt}`;
    const previousFingerprint = sessionStorage.getItem(fingerprintKey);

    if (
      previousFingerprint &&
      previousFingerprint !== metadata.fingerprint
    ) {
      throw new Error("THEME_RENDER_FINGERPRINT_CHANGED");
    }

    const strategies = new Set([
      "ELEMENT_ID",
      "DATA_ATTRIBUTE",
      "SOURCE_PROVEN_SELECTOR",
    ]);

    if (!strategies.has(metadata.mount.strategy)) {
      throw new Error("THEME_RENDER_MOUNT_STRATEGY_INVALID");
    }

    if (
      metadata.mount.strategy === "ELEMENT_ID" &&
      !/^#[A-Za-z][A-Za-z0-9_:.-]*$/.test(metadata.mount.selector)
    ) {
      throw new Error("THEME_RENDER_ELEMENT_ID_INVALID");
    }

    if (
      metadata.mount.strategy === "DATA_ATTRIBUTE" &&
      !/^\[data-[A-Za-z0-9_.:-]+(?:=(?:"[^"\r\n]*"|'[^'\r\n]*'))?\]$/.test(
        metadata.mount.selector,
      )
    ) {
      throw new Error("THEME_RENDER_DATA_ATTRIBUTE_INVALID");
    }

    let matches;

    try {
      matches = document.querySelectorAll(metadata.mount.selector);
    } catch {
      throw new Error("THEME_RENDER_MOUNT_SELECTOR_INVALID");
    }

    if (matches.length !== 1) {
      throw new Error("THEME_RENDER_MOUNT_NOT_UNIQUE");
    }

    const mount = matches[0];
    const expectedTag = metadata.mount.verification?.expectedTag;

    if (
      expectedTag &&
      mount.tagName.toLowerCase() !== String(expectedTag).toLowerCase()
    ) {
      throw new Error("THEME_RENDER_MOUNT_TAG_MISMATCH");
    }

    sessionStorage.setItem(fingerprintKey, metadata.fingerprint);
    rememberLoadingMount(metadata.mount);

    if (
      document.querySelector("[data-ai-search-v4-loading]")?.dataset.active ===
      "true"
    ) {
      concealNativeResults(metadata.mount);
    }

    return mount;
  }

  function suspendNativePaginationRuntime(mount, page = 1) {
    const parsedPage = Number.parseInt(String(page || "1"), 10);

    const safePage =
      Number.isSafeInteger(parsedPage) && parsedPage > 0
        ? parsedPage
        : 1;

    let host = null;

    if (mount instanceof Element) {
      host = mount.closest("results-list");
    }

    if (!host) {
      const candidates = Array.from(
        document.querySelectorAll("results-list[infinite-scroll]"),
      );

      if (candidates.length === 1) {
        host = candidates[0];
      } else {
        host =
          candidates.find(function (candidate) {
            return Boolean(
              candidate.querySelector(
                '[data-testid="product-grid"], [data-product-grid], #product-grid',
              ),
            );
          }) || null;
      }
    }

    if (!host) {
      return;
    }

    const firstSuspend =
      host.dataset.aiSearchV4NativePaginationSuspended !== "true";

    host.dataset.aiSearchV4NativePaginationSuspended = "true";

    host.removeAttribute("infinite-scroll");

    try {
      if ("infiniteScroll" in host) {
        host.infiniteScroll = false;
      }
    } catch {
      // custom element có thể expose property read-only
    }

    host
      .querySelectorAll(
        '[ref="viewMoreNext"], [ref="viewMorePrevious"]',
      )
      .forEach(function (sentinel) {
        sentinel.remove();
      });

    const grid =
      mount instanceof Element
        ? mount
        : host.querySelector(
            '[data-testid="product-grid"], [data-product-grid], #product-grid',
          );

    if (grid?.hasAttribute("data-last-page")) {
      grid.setAttribute(
        "data-last-page",
        String(safePage),
      );
    }

    if (firstSuspend) {
      console.info(
        logPrefix,
        "native pagination suspended",
        {
          page: safePage,
          host: host.tagName.toLowerCase(),
          mountSelector:
            mount instanceof Element
              ? mount.getAttribute("data-testid") ||
                mount.id ||
                null
              : null,
        },
      );
    }
  }

  function activateRuntime(mount, metadata) {
    mount
      .querySelectorAll("img[data-src]")
      .forEach(function (image) {
        if (!image.getAttribute("src")) {
          image.src = image.dataset.src;
        }
      });

    document.documentElement.dataset.aiSearchV4Receipt =
      metadata.receipt || "";

    document.documentElement.dataset.aiSearchV4Page =
      String(metadata.page || 1);

    document.dispatchEvent(
      new CustomEvent("ai-search:rendered", {
        detail: {
          receipt: metadata.receipt,
          page: metadata.page,
          candidateId: metadata.candidateId,
          runtimeMode: metadata.runtimeMode,
        },
      }),
    );
  }

  async function renderAppProxy(receipt, page, signal) {
    let candidateId = "";
    const rejected = new Set();

    for (;;) {
      const response = await fetch(
        renderUrl(receipt, page, candidateId),
        {
          credentials: "same-origin",
          signal,
          headers: {
            Accept: "text/html",
          },
        },
      );

      if (!response.ok) {
        throw new Error(
          `THEME_RENDER_HTTP_${response.status}`,
        );
      }

      const html = await response.text();

      const template =
        document.createElement("template");

      template.innerHTML = html;

      const metadata =
        decodeMetadata(response, template);

      try {
        const mount =
          verifyMount(metadata, receipt);

        suspendNativePaginationRuntime(
          mount,
          metadata.page,
        );

        mount.replaceChildren(
          template.content,
        );

        activeProducts =
          Array.isArray(metadata.products)
            ? metadata.products
            : [];

        activateRuntime(
          mount,
          metadata,
        );

        return {
          mount,
          metadata,
        };
      } catch (error) {
        rejected.add(
          metadata.candidateId,
        );

        candidateId =
          (metadata.candidateIds || []).find(
            function (id) {
              return !rejected.has(id);
            },
          ) || "";

        if (!candidateId) {
          throw error;
        }
      }
    }
  }
    function normalizeProductGid(value) {
    const raw =
      String(value || "").trim();

    if (!raw) {
      return "";
    }

    if (
      /^gid:\/\/shopify\/Product\/\d+$/.test(
        raw,
      )
    ) {
      return raw;
    }

    if (/^\d+$/.test(raw)) {
      return `gid://shopify/Product/${raw}`;
    }

    return "";
  }

  function validateRenderedMount(
    root,
    mountRecipe,
  ) {
    if (!mountRecipe?.selector) {
      throw new Error(
        "THEME_CONTEXT_MOUNT_MISSING",
      );
    }

    let matches;

    try {
      matches =
        root.querySelectorAll(
          mountRecipe.selector,
        );
    } catch {
      throw new Error(
        "THEME_CONTEXT_MOUNT_SELECTOR_INVALID",
      );
    }

    if (matches.length !== 1) {
      throw new Error(
        "THEME_CONTEXT_RENDERED_MOUNT_NOT_UNIQUE",
      );
    }

    const mount = matches[0];

    const expectedTag =
      mountRecipe.verification
        ?.expectedTag;

    if (
      expectedTag &&
      mount.tagName.toLowerCase() !==
        String(expectedTag).toLowerCase()
    ) {
      throw new Error(
        "THEME_CONTEXT_RENDERED_MOUNT_TAG_MISMATCH",
      );
    }

    return mount;
  }

  function getSectionIdForMount(mount) {
    const wrapper =
      mount.closest(
        '[id^="shopify-section-"]',
      );

    if (!wrapper?.id) {
      throw new Error(
        "THEME_CONTEXT_SECTION_WRAPPER_NOT_FOUND",
      );
    }

    const sectionId =
      wrapper.id
        .replace(
          /^shopify-section-/,
          "",
        )
        .trim();

    if (!sectionId) {
      throw new Error(
        "THEME_CONTEXT_SECTION_ID_INVALID",
      );
    }

    return sectionId;
  }

  async function fetchTransportPlan(
    receipt,
    page,
    signal,
  ) {
    const requestUrl =
      transportUrl(
        receipt,
        page,
      );

    const startedAt =
      performance.now();

    console.info(
      logPrefix,
      "fetchTransportPlan",
      {
        receipt,
        page,
        url: requestUrl,
      },
    );

    const response =
      await fetch(
        requestUrl,
        {
          credentials: "same-origin",
          signal,
          headers: {
            Accept: "application/json",
          },
        },
      );

    let data = null;

    try {
      data =
        await response.json();
    } catch {
      data = null;
    }

    /*
     * Theme classic không có
     * THEME_CONTEXT_REQUIRED candidate.
     *
     * Khi đó giữ App Proxy Liquid path.
     */
    if (
      response.status === 409 &&
      data?.reason ===
        "THEME_CONTEXT_TRANSPORT_CANDIDATE_NOT_FOUND"
    ) {
      return null;
    }

    if (!response.ok) {
      if (
        response.status === 410 ||
        data?.reason ===
          "SEARCH_RECEIPT_EXPIRED_OR_INVALID"
      ) {
        throw new Error(
          "THEME_RENDER_HTTP_410",
        );
      }

      if (
        response.status === 400 &&
        data?.reason ===
          "INVALID_SEARCH_RECEIPT"
      ) {
        throw new Error(
          "SEARCH_RECEIPT_INVALID",
        );
      }

      throw new Error(
        data?.reason ||
          `THEME_TRANSPORT_HTTP_${response.status}`,
      );
    }

    if (
      !isUsableThemeContextPlan(
        data,
        receipt,
        page,
      )
    ) {
      throw new Error(
        data?.reason ||
          "THEME_TRANSPORT_PLAN_INVALID",
      );
    }

    console.info(
      logPrefix,
      "fetchTransportPlan complete",
      {
        receipt,
        page,
        batchCount:
          data.batches.length,
        durationMs:
          Math.round(
            performance.now() -
              startedAt,
          ),
      },
    );

    return data;
  }

  async function fetchThemeContextBatch({
    batch,
    sectionId,
    mountRecipe,
    signal,
  }) {
    const startedAt =
      performance.now();

    const url =
      new URL(
        config.search_url ||
          "/search",
        location.origin,
      );

    url.searchParams.set(
      "q",
      batch.query,
    );

    url.searchParams.set(
      "type",
      "product",
    );

    url.searchParams.set(
      "sections",
      sectionId,
    );

    url.searchParams.delete(
      "page",
    );

    url.searchParams.delete(
      "_ai_search_bypass",
    );

    const response =
      await fetch(
        url.pathname +
          url.search,
        {
          credentials: "same-origin",
          signal,
          headers: {
            Accept:
              "application/json",
          },
        },
      );

    if (!response.ok) {
      throw new Error(
        `THEME_CONTEXT_SECTION_HTTP_${response.status}`,
      );
    }

    const payload =
      await response.json();

    const html =
      payload?.[sectionId];

    if (
      typeof html !== "string" ||
      !html.trim()
    ) {
      throw new Error(
        "THEME_CONTEXT_SECTION_HTML_MISSING",
      );
    }

    const template =
      document.createElement(
        "template",
      );

    template.innerHTML = html;

    const renderedMount =
      validateRenderedMount(
        template.content,
        mountRecipe,
      );

    const cards =
      new Map();

    for (
      const child of
      Array.from(
        renderedMount.children,
      )
    ) {
      const productId =
        normalizeProductGid(
          child.getAttribute(
            "data-product-id",
          ),
        );

      if (!productId) {
        continue;
      }

      if (
        cards.has(productId)
      ) {
        throw new Error(
          "THEME_CONTEXT_DUPLICATE_PRODUCT_CARD",
        );
      }

      cards.set(
        productId,
        child,
      );
    }

    const expectedIds =
      Array.from(
        new Set(
          (
            batch.productIds ||
            []
          )
            .map(
              normalizeProductGid,
            )
            .filter(Boolean),
        ),
      );

    const selectedCards =
      new Map();

    const missingIds =
      [];

    for (
      const productId of
      expectedIds
    ) {
      const card =
        cards.get(productId);

      if (!card) {
        missingIds.push(
          productId,
        );

        continue;
      }

      selectedCards.set(
        productId,
        card,
      );
    }

    const durationMs =
      Math.round(
        performance.now() -
          startedAt,
      );

    console.info(
      logPrefix,
      "section batch rendered",
      {
        sectionId,
        expectedCount:
          expectedIds.length,
        renderedDirectCards:
          cards.size,
        matchedCount:
          selectedCards.size,
        missingCount:
          missingIds.length,
        discardedExtras:
          Math.max(
            0,
            cards.size -
              selectedCards.size,
          ),
        encodedQueryLength:
          batch.encodedQueryLength,
        durationMs,
      },
    );

    return {
      selectedCards,
      missingIds,
      durationMs,
    };
  }

  function transportClauseMap(plan) {
    const result =
      new Map();

    for (
      const entry of
      Array.isArray(plan?.resolved)
        ? plan.resolved
        : []
    ) {
      const productId =
        normalizeProductGid(
          entry?.productId,
        );

      const clause =
        String(
          entry?.clause ||
          "",
        ).trim();

      if (
        productId &&
        clause
      ) {
        result.set(
          productId,
          clause,
        );
      }
    }

    return result;
  }

  function buildRetryTransportBatch(
    productIds,
    clauseByProductId,
  ) {
    const normalizedIds =
      productIds
        .map(
          normalizeProductGid,
        )
        .filter(Boolean);

    const clauses =
      normalizedIds.map(
        function (productId) {
          const clause =
            clauseByProductId.get(
              productId,
            );

          if (!clause) {
            throw new Error(
              `THEME_CONTEXT_TRANSPORT_CLAUSE_MISSING:${productId}`,
            );
          }

          return clause;
        },
      );

    const query =
      clauses.join(" OR ");

    return {
      productIds:
        normalizedIds,
      query,
      encodedQueryLength:
        encodeURIComponent(
          query,
        ).length,
    };
  }

  function mergeCardMaps(
    target,
    source,
  ) {
    for (
      const [
        productId,
        card,
      ] of source
    ) {
      if (
        target.has(productId)
      ) {
        throw new Error(
          "THEME_CONTEXT_DUPLICATE_TARGET_ACROSS_BATCHES",
        );
      }

      target.set(
        productId,
        card,
      );
    }
  }

  async function fetchThemeContextBatchAdaptive({
    batch,
    sectionId,
    mountRecipe,
    signal,
    clauseByProductId,
    depth = 0,
  }) {
    const result =
      await fetchThemeContextBatch({
        batch,
        sectionId,
        mountRecipe,
        signal,
      });

    if (
      result.missingIds.length ===
      0
    ) {
      return result.selectedCards;
    }

    if (
      depth >= 8
    ) {
      throw new Error(
        `THEME_CONTEXT_TARGET_MISSING:${result.missingIds[0]}`,
      );
    }

    let retryGroups;

    if (
      result.selectedCards.size > 0
    ) {
      /**
       * Shopify đã render được một phần batch.
       * Retry đúng phần còn thiếu trước; thường đây là
       * trường hợp native page capacity nhỏ hơn batch AI.
       */
      retryGroups = [
        result.missingIds,
      ];
    } else if (
      result.missingIds.length > 1
    ) {
      /**
       * 0/N target được trả về: chia đôi để tránh
       * một query lớn/parser behavior làm fail toàn batch.
       */
      const middle =
        Math.ceil(
          result.missingIds.length /
            2,
        );

      retryGroups = [
        result.missingIds.slice(
          0,
          middle,
        ),
        result.missingIds.slice(
          middle,
        ),
      ].filter(
        (group) =>
          group.length > 0,
      );
    } else {
      throw new Error(
        `THEME_CONTEXT_TARGET_MISSING:${result.missingIds[0]}`,
      );
    }

    console.info(
      logPrefix,
      "adaptive section batch retry",
      {
        depth,
        originalCount:
          Array.isArray(
            batch.productIds,
          )
            ? batch.productIds.length
            : 0,
        matchedCount:
          result.selectedCards.size,
        missingCount:
          result.missingIds.length,
        nextCounts:
          retryGroups.map(
            (group) =>
              group.length,
          ),
      },
    );

    const retryMaps =
      await Promise.all(
        retryGroups.map(
          function (group) {
            return fetchThemeContextBatchAdaptive({
              batch:
                buildRetryTransportBatch(
                  group,
                  clauseByProductId,
                ),
              sectionId,
              mountRecipe,
              signal,
              clauseByProductId,
              depth:
                depth + 1,
            });
          },
        ),
      );

    const merged =
      new Map(
        result.selectedCards,
      );

    for (
      const retryMap of
      retryMaps
    ) {
      mergeCardMaps(
        merged,
        retryMap,
      );
    }

    return merged;
  }

  function productHandleFromCard(
    card,
  ) {
    const anchor =
      card.querySelector(
        'a[href*="/products/"]',
      );

    if (!anchor) {
      return "";
    }

    try {
      return (
        new URL(
          anchor.href,
          location.origin,
        )
          .pathname
          .match(
            /\/products\/([^/?#]+)/,
          )?.[1] || ""
      );
    } catch {
      return "";
    }
  }

  function buildThemeContextMetadata(
    receipt,
    page,
    plan,
  ) {
    return {
      version: 4,

      themeId:
        plan.theme_id,

      fingerprint:
        plan.map_fingerprint,

      receipt:
        plan.receipt ||
        receipt,

      searchLogId:
        plan.search_log_id ||
        null,

      page:
        Number(
          plan.pagination
            ?.current_page ||
            page,
        ),

      pageSize:
        Number(
          plan.pagination
            ?.page_size ||
            20,
        ),

      totalProducts:
        Number(
          plan.pagination
            ?.total_products ||
            0,
        ),

      totalPages:
        Number(
          plan.pagination
            ?.total_pages ||
            0,
        ),

      candidateId:
        plan.candidate?.id ||
        null,

      runtimeMode:
        "THEME_CONTEXT",

      mount:
        plan.mount,

      candidateIds:
        plan.candidate?.id
          ? [plan.candidate.id]
          : [],

      products: [],
    };
  }

  async function prepareThemeContextPage(
    receipt,
    page,
    plan,
    signal,
  ) {
    const totalStartedAt =
      performance.now();

    if (
      !isUsableThemeContextPlan(
        plan,
        receipt,
        page,
      )
    ) {
      throw new Error(
        "THEME_TRANSPORT_PLAN_INVALID",
      );
    }

    const metadata =
      buildThemeContextMetadata(
        receipt,
        page,
        plan,
      );

    if (
      metadata.receipt !==
      receipt
    ) {
      throw new Error(
        "THEME_CONTEXT_RECEIPT_MISMATCH",
      );
    }

    const mount =
      verifyMount(
        metadata,
        receipt,
      );

    const sectionId =
      getSectionIdForMount(
        mount,
      );

    const targetProductIds =
      plan.targetProductIds.map(
        normalizeProductGid,
      );

    if (
      targetProductIds.some(
        (productId) =>
          !productId,
      ) ||
      new Set(
        targetProductIds,
      ).size !==
        targetProductIds.length
    ) {
      throw new Error(
        "THEME_CONTEXT_TARGET_IDS_INVALID",
      );
    }

    const clauseByProductId =
      transportClauseMap(plan);

    const sectionStartedAt =
      performance.now();

    const batchMaps =
      await Promise.all(
        plan.batches.map(
          function (batch) {
            return fetchThemeContextBatchAdaptive({
              batch,
              sectionId,
              mountRecipe:
                plan.mount,
              signal,
              clauseByProductId,
            });
          },
        ),
      );

    const sectionRenderMs =
      Math.round(
        performance.now() -
          sectionStartedAt,
      );

    const cardsByProductId =
      new Map();

    for (
      const batchCards of
      batchMaps
    ) {
      mergeCardMaps(
        cardsByProductId,
        batchCards,
      );
    }

    const orderedCards =
      targetProductIds.map(
        function (productId) {
          const card =
            cardsByProductId.get(
              productId,
            );

          if (!card) {
            throw new Error(
              `THEME_CONTEXT_TARGET_MISSING:${productId}`,
            );
          }

          if (
            card.hasAttribute(
              "data-page",
            )
          ) {
            card.setAttribute(
              "data-page",
              String(
                metadata.page,
              ),
            );
          }

          return card;
        },
      );

    const products =
      orderedCards.map(
        function (
          card,
          index,
        ) {
          return {
            productId:
              targetProductIds[
                index
              ],

            handle:
              productHandleFromCard(
                card,
              ),
          };
        },
      );

    metadata.products =
      products;

    return {
      mount,
      metadata,
      sectionId,
      orderedCards,
      products,
      batchCount:
        plan.batches.length,
      sectionRenderMs,
      totalRenderMs:
        Math.round(
          performance.now() -
            totalStartedAt,
        ),
    };
  }

  function applyPreparedThemeContextPage(
    prepared,
  ) {
    const {
      mount,
      metadata,
      orderedCards,
      products,
      sectionId,
      batchCount,
      sectionRenderMs,
      totalRenderMs,
    } = prepared;

    /*
     * V4 quản lý pagination.
     * Không để native infinite-scroll append
     * Shopify-native pages vào AI result grid.
     */
    suspendNativePaginationRuntime(
      mount,
      metadata.page,
    );

    mount.replaceChildren(
      ...orderedCards,
    );

    activeProducts =
      products;

    activateRuntime(
      mount,
      metadata,
    );

    cacheRenderedMount(
      mount,
      metadata,
    );

    console.info(
      logPrefix,
      "theme-context render complete",
      {
        receipt:
          metadata.receipt,
        page:
          metadata.page,
        sectionId,
        targetCount:
          products.length,
        batchCount,
        mountSelector:
          metadata.mount?.selector ||
          null,
        sectionRenderMs,
        totalRenderMs,
      },
    );

    return {
      mount,
      metadata,
    };
  }

  async function renderThemeContext(
    receipt,
    page,
    plan,
    signal,
  ) {
    const prepared =
      await prepareThemeContextPage(
        receipt,
        page,
        plan,
        signal,
      );

    return applyPreparedThemeContextPage(
      prepared,
    );
  }

  function throwIfAborted(signal) {
    if (!signal?.aborted) return;

    const error =
      new Error("Aborted");

    error.name =
      "AbortError";

    throw error;
  }
  async function renderReceipt(
    receipt,
    page,
    signal,
    initialTransportPlan = null,
  ) {
    throwIfAborted(signal);

    const planIdentity = {
      themeId:
        initialTransportPlan?.theme_id ||
        currentThemeIdentity().themeId,
      fingerprint:
        initialTransportPlan?.map_fingerprint ||
        currentThemeIdentity().fingerprint,
    };

    const cached =
      restoreRenderedPageFromCache(
        receipt,
        page,
        planIdentity.fingerprint,
        planIdentity.themeId,
      );

    if (cached) {
      return cached;
    }

    const cacheKey =
      renderedPageCacheKey(
        receipt,
        page,
        planIdentity.fingerprint,
        planIdentity.themeId,
      );

    const prefetchPromise =
      cacheKey
        ? pagePrefetches.get(
            cacheKey,
          )
        : null;

    if (prefetchPromise) {
      try {
        await prefetchPromise;

        throwIfAborted(signal);

        const prefetched =
          restoreRenderedPageFromCache(
            receipt,
            page,
            planIdentity.fingerprint,
            planIdentity.themeId,
          );

        if (prefetched) {
          console.info(
            logPrefix,
            "awaited prefetched page",
            {
              receipt,
              page,
            },
          );

          return prefetched;
        }
      } catch (error) {
        console.info(
          logPrefix,
          "prefetch unavailable; using foreground render",
          {
            receipt,
            page,
            reason:
              error instanceof Error
                ? error.message
                : String(error),
          },
        );
      }
    }

    throwIfAborted(signal);

    let transportPlan = null;

    if (
      isUsableThemeContextPlan(
        initialTransportPlan,
        receipt,
        page,
      )
    ) {
      transportPlan =
        initialTransportPlan;

      console.info(
        logPrefix,
        "using initial transport plan",
        {
          receipt,
          page,
          batchCount:
            transportPlan.batches.length,
          targetCount:
            transportPlan.targetProductIds.length,
        },
      );
    } else {
      transportPlan =
        await fetchTransportPlan(
          receipt,
          page,
          signal,
        );
    }

    if (transportPlan) {
      return renderThemeContext(
        receipt,
        page,
        transportPlan,
        signal,
      );
    }

    const rendered =
      await renderAppProxy(
        receipt,
        page,
        signal,
      );

    cacheRenderedMount(
      rendered.mount,
      rendered.metadata,
    );

    return rendered;
  }

  function scheduleAdjacentPrefetch(
    receipt,
    metadata,
  ) {
    const currentPage =
      Number(metadata?.page || 1);

    const totalPages =
      Number(
        metadata?.totalPages ||
        0,
      );

    if (
      !receiptPattern.test(
        String(receipt || ""),
      ) ||
      !Number.isSafeInteger(
        currentPage,
      ) ||
      !Number.isSafeInteger(
        totalPages,
      ) ||
      currentPage < 1 ||
      currentPage >= totalPages
    ) {
      return;
    }

    const nextPage =
      currentPage + 1;

    const key =
      renderedPageCacheKey(
        receipt,
        nextPage,
        metadata.fingerprint,
        metadata.themeId,
      );

    if (
      !key ||
      renderedPageCache.has(key) ||
      pagePrefetches.has(key)
    ) {
      return;
    }

    const promise =
      Promise.resolve()
        .then(
          async function () {
            const plan =
              await fetchTransportPlan(
                receipt,
                nextPage,
                undefined,
              );

            /**
             * Classic APP_PROXY_LIQUID path chưa cần background prefetch.
             * Fast Path này tập trung vào Theme Context Section Rendering.
             */
            if (!plan) {
              return;
            }

            const prepared =
              await prepareThemeContextPage(
                receipt,
                nextPage,
                plan,
                undefined,
              );

            cacheRenderedElements(
              prepared.orderedCards,
              prepared.metadata,
              prepared.products,
            );

            console.info(
              logPrefix,
              "adjacent page prefetched",
              {
                receipt,
                page:
                  nextPage,
                productCount:
                  prepared.products.length,
                sectionRenderMs:
                  prepared.sectionRenderMs,
              },
            );
          },
        )
        .finally(
          function () {
            pagePrefetches.delete(
              key,
            );
          },
        );

    pagePrefetches.set(
      key,
      promise,
    );
  }

  function updateResultCount(
    mount,
    metadata,
  ) {
    const totalProducts =
      Number(
        metadata.totalProducts,
      );

    if (
      !Number.isSafeInteger(
        totalProducts,
      ) ||
      totalProducts < 0
    ) {
      return;
    }

    const scopes = [
      mount.closest(
        "section",
      ),

      mount.closest(
        '[id^="shopify-section-"]',
      ),

      mount.closest(
        "main",
      ),
    ].filter(Boolean);

    let statusElement =
      null;

    for (
      const scope of scopes
    ) {
      const candidates =
        Array.from(
          scope.querySelectorAll(
            '[role="status"]',
          ),
        ).filter(
          function (
            element,
          ) {
            if (
              mount.contains(
                element,
              )
            ) {
              return false;
            }

            if (
              element.getAttribute(
                "aria-hidden",
              ) === "true"
            ) {
              return false;
            }

            if (
              !(
                element.textContent ||
                ""
              ).trim()
            ) {
              return false;
            }

            return true;
          },
        );

      if (
        candidates.length ===
        1
      ) {
        statusElement =
          candidates[0];

        break;
      }
    }

    if (!statusElement) {
      console.info(
        logPrefix,
        "resultCount skipped",
        {
          reason:
            "RESULT_COUNT_STATUS_NOT_UNIQUE",

          totalProducts,
        },
      );

      return;
    }

    const currentText =
      statusElement.textContent ||
      "";

    const countToken =
      currentText.match(
        /\d(?:[\d.,\u00A0\u202F ]*\d)?/,
      );

    if (
      !countToken ||
      typeof countToken.index !==
        "number"
    ) {
      console.info(
        logPrefix,
        "resultCount skipped",
        {
          reason:
            "RESULT_COUNT_NUMBER_NOT_FOUND",

          totalProducts,
          currentText,
        },
      );

      return;
    }

    statusElement.textContent =
      currentText.slice(
        0,
        countToken.index,
      ) +
      String(
        totalProducts,
      ) +
      currentText.slice(
        countToken.index +
          countToken[0].length,
      );

    console.info(
      logPrefix,
      "resultCount updated",
      {
        totalProducts,
        previousText:
          currentText,
        updatedText:
          statusElement.textContent,
      },
    );
  }

  function removePagination() {
    document
      .querySelector(
        "[data-ai-search-v4-pagination]",
      )
      ?.remove();
  }

  function ensurePaginationStyle() {
    if (document.getElementById("ai-search-v4-pagination-style")) return;
    const style = document.createElement("style");
    style.id = "ai-search-v4-pagination-style";
    style.textContent = `
      [data-ai-search-v4-pagination] { display:grid; gap:1rem; justify-items:center; margin-block:2rem; font:inherit; color:currentColor; }
      [data-ai-search-v4-pagination-controls] { display:flex; align-items:center; justify-content:center; gap:.4rem; flex-wrap:wrap; }
      [data-ai-search-v4-pagination] button { min-width:42px; min-height:42px; padding:.55rem .8rem; border:1px solid color-mix(in srgb, currentColor 28%, transparent); border-radius:.45rem; background:Canvas; color:CanvasText; font:inherit; cursor:pointer; }
      [data-ai-search-v4-pagination] button:hover:not(:disabled) { background:color-mix(in srgb, CanvasText 8%, Canvas); }
      [data-ai-search-v4-pagination] button:focus-visible { outline:2px solid currentColor; outline-offset:2px; }
      [data-ai-search-v4-pagination] button[aria-current="page"] { border-color:currentColor; font-weight:700; cursor:default; }
      [data-ai-search-v4-pagination] button:disabled:not([aria-current]) { opacity:.42; cursor:not-allowed; }
      [data-ai-search-v4-ellipsis] { min-width:1.5rem; text-align:center; }
      [data-ai-search-v4-mobile-page] { display:none; }
      @media (max-width: 749px) {
        [data-ai-search-v4-desktop-page] { display:none; }
        [data-ai-search-v4-mobile-page] { display:inline; padding-inline:.5rem; }
        [data-ai-search-v4-pagination] button { min-width:40px; min-height:40px; }
      }
      @media (prefers-reduced-motion: reduce) { [data-ai-search-v4-pagination] * { scroll-behavior:auto !important; transition:none !important; } }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function formatResultRange(metadata) {
    const total = Math.max(0, Number(metadata.totalProducts) || 0);
    const page = Math.max(1, Number(metadata.page) || 1);
    const pageSize = Math.max(1, Number(metadata.pageSize) || 1);
    const start = total === 0 ? 0 : (page - 1) * pageSize + 1;
    const end = Math.min(page * pageSize, total);
    return `Showing ${start}–${end} of ${total} results`;
  }

  function paginationModel(page, totalPages) {
    const pages = new Set([1, totalPages, page - 1, page, page + 1]);
    const sorted = [...pages]
      .filter((value) => value >= 1 && value <= totalPages)
      .sort((a, b) => a - b);
    const model = [];
    for (const value of sorted) {
      const previous = model.at(-1);
      if (typeof previous === "number" && value - previous > 1) model.push("ELLIPSIS");
      model.push(value);
    }
    return model;
  }

  function paginationButton(
    label,
    page,
    current,
    onPage,
  ) {
    const button =
      document.createElement(
        "button",
      );

    button.type =
      "button";

    button.textContent =
      label;

    button.disabled =
      current;

    if (current) {
      button.setAttribute(
        "aria-current",
        "page",
      );
    }

    button.addEventListener(
      "click",
      function () {
        onPage(page);
      },
    );

    return button;
  }

  function mountPagination(
    mount,
    metadata,
    onPage,
  ) {
    removePagination();

    if (
      metadata.totalPages <=
      1
    ) {
      return;
    }

    ensurePaginationStyle();

    const nav =
      document.createElement(
        "nav",
      );

    nav.dataset.aiSearchV4Pagination =
      "";

    nav.setAttribute(
      "aria-label",
      "Search result pages",
    );

    const summary = document.createElement("div");
    summary.textContent = formatResultRange(metadata);
    nav.appendChild(summary);

    const controls = document.createElement("div");
    controls.dataset.aiSearchV4PaginationControls = "";
    const previous = paginationButton("← Previous", metadata.page - 1, false, onPage);
    previous.disabled = metadata.page <= 1;
    previous.setAttribute("aria-label", "Previous search results page");
    controls.appendChild(previous);

    for (const item of paginationModel(metadata.page, metadata.totalPages)) {
      if (item === "ELLIPSIS") {
        const ellipsis = document.createElement("span");
        ellipsis.dataset.aiSearchV4Ellipsis = "";
        ellipsis.setAttribute("aria-hidden", "true");
        ellipsis.textContent = "…";
        controls.appendChild(ellipsis);
      } else {
        const button = paginationButton(String(item), item, item === metadata.page, onPage);
        button.dataset.aiSearchV4DesktopPage = "";
        button.setAttribute("aria-label", `Search results page ${item}`);
        controls.appendChild(button);
      }
    }

    const mobile = document.createElement("span");
    mobile.dataset.aiSearchV4MobilePage = "";
    mobile.textContent = `Page ${metadata.page} of ${metadata.totalPages}`;
    controls.appendChild(mobile);

    const next = paginationButton("Next →", metadata.page + 1, false, onPage);
    next.disabled = metadata.page >= metadata.totalPages;
    next.setAttribute("aria-label", "Next search results page");
    controls.appendChild(next);
    nav.appendChild(controls);

    const live = document.createElement("span");
    live.setAttribute("aria-live", "polite");
    live.style.position = "absolute";
    live.style.inlineSize = "1px";
    live.style.blockSize = "1px";
    live.style.overflow = "hidden";
    live.textContent = `Page ${metadata.page} of ${metadata.totalPages} loaded`;
    nav.appendChild(live);

    mount.insertAdjacentElement(
      "afterend",
      nav,
    );
  }

  function isRecoverableReceiptError(
    error,
  ) {
    const message =
      error instanceof Error
        ? error.message
        : String(error);

    return (
      message ===
        "THEME_RENDER_HTTP_404" ||
      message ===
        "THEME_RENDER_HTTP_410" ||
      message ===
        "THEME_TRANSPORT_HTTP_410" ||
      message ===
        "SEARCH_RECEIPT_EXPIRED_OR_INVALID" ||
      message ===
        "SEARCH_RECEIPT_INVALID" ||
      message ===
        "SEARCH_RECEIPT_REQUIRED"
    );
  }

  async function fetchFreshReceipt(
    query,
    signal,
  ) {
    const requestUrl =
      backendUrl(query);

    console.info(
      logPrefix,
      "fetchAiResults",
      {
        query,
        page: 1,
        url: requestUrl,
      },
    );

    const response =
      await fetch(
        requestUrl,
        {
          credentials:
            "same-origin",

          signal,

          headers: {
            Accept:
              "application/json",
          },
        },
      );

    if (!response.ok) {
      throw new Error(
        `AI_SEARCH_HTTP_${response.status}`,
      );
    }

    const data =
      await response.json();

    if (
      data.status !==
      "success"
    ) {
      console.warn(
        logPrefix,
        "backend fallback response",
        {
          status:
            data.status,

          reason:
            data.reason ||
            "AI_SEARCH_FAILED",

          nativeUrl:
            data.native_url ||
            null,
        },
      );

      throw new Error(
        data.reason ||
          "AI_SEARCH_FAILED",
      );
    }

    const receipt =
      data.render_receipt?.id ||
      "";

    if (
      !receiptPattern.test(
        receipt,
      )
    ) {
      throw new Error(
        "SEARCH_RECEIPT_INVALID",
      );
    }

    if (data.theme_id) {
      config.theme_id =
        String(
          data.theme_id,
        );
    }

    if (
      data.map_fingerprint
    ) {
      config.map_fingerprint =
        String(
          data.map_fingerprint,
        );
    }

    return {
      receipt,

      searchLogId:
        data.search_log_id ||
        null,

      themeId:
        data.theme_id ||
        null,

      fingerprint:
        data.map_fingerprint ||
        null,

      initialTransportPlan:
        data.initial_transport_plan ||
        null,
    };
  }

  async function execute(
    query,
    page,
    receipt,
    replaceUrl,
    requestedUiState,
  ) {
    controller?.abort();

    controller =
      new AbortController();

    const signal =
      controller.signal;

    const requestId =
      ++requestNumber;

    const hadExistingReceipt =
      Boolean(receipt);

    const executionUiState = requestedUiState ||
      (hadExistingReceipt
        ? UI_STATE.PAGINATION_LOADING
        : UI_STATE.INITIAL_SEARCH_LOADING);
    transitionUi(executionUiState, { mount: activeMount });

    /*
     * FIX QUAN TRỌNG:
     *
     * Chặn native infinite-scroll
     * NGAY TRƯỚC khi gọi backend.
     *
     * Search AI có thể mất vài giây.
     * Nếu đợi render xong mới chặn
     * thì Horizon có thể đã tự tải
     * page 2, 3, 4... vào grid.
     */
    suspendNativePaginationRuntime(
      null,
      page,
    );

    try {
      let activeReceipt =
        receipt;

      let renderPage =
        page;

      let usedExistingReceipt =
        Boolean(
          activeReceipt,
        );

      let initialTransportPlan =
        null;

      if (!activeReceipt) {
        const fresh =
          await fetchFreshReceipt(
            query,
            signal,
          );

        activeReceipt =
          fresh.receipt;

        activeSearchLogId =
          fresh.searchLogId;

        initialTransportPlan =
          fresh.initialTransportPlan;

        usedExistingReceipt =
          false;
      }

      let rendered;

      try {
        rendered =
          await renderReceipt(
            activeReceipt,
            renderPage,
            signal,
            initialTransportPlan,
          );
      } catch (error) {
        if (
          !usedExistingReceipt ||
          !isRecoverableReceiptError(
            error,
          )
        ) {
          throw error;
        }

        console.info(
          logPrefix,
          "receipt expired; refreshing search",
          {
            query,
            page:
              renderPage,
            receipt:
              activeReceipt,

            reason:
              error instanceof
              Error
                ? error.message
                : String(
                    error,
                  ),
          },
        );

        showLoading();

        const fresh =
          await fetchFreshReceipt(
            query,
            signal,
          );

        activeReceipt =
          fresh.receipt;

        activeSearchLogId =
          fresh.searchLogId;

        initialTransportPlan =
          fresh.initialTransportPlan;

        usedExistingReceipt =
          false;

        rendered =
          await renderReceipt(
            activeReceipt,
            renderPage,
            signal,
            initialTransportPlan,
          );
      }

      if (
        requestId !==
        requestNumber
      ) {
        return;
      }

      activeSearchLogId =
        rendered.metadata
          .searchLogId ||
        activeSearchLogId;

      activeMount = rendered.mount;

      writeUrl({
        query,

        page:
          rendered.metadata
            .page,

        receipt:
          activeReceipt,

        replace:
          replaceUrl,

        searchLogId:
          activeSearchLogId,

        fingerprint:
          rendered.metadata
            .fingerprint,

        themeId:
          rendered.metadata
            .themeId,
      });

      transitionUi(UI_STATE.AI_READY, { mount: rendered.mount });

      updateResultCount(
        rendered.mount,
        rendered.metadata,
      );

      mountPagination(
        rendered.mount,
        rendered.metadata,
        function (
          nextPage,
        ) {
          writeUrl({
            query,
            page:
              nextPage,
            receipt:
              activeReceipt,
            replace:
              false,
            searchLogId:
              activeSearchLogId,
            fingerprint:
              rendered.metadata
                .fingerprint,
            themeId:
              rendered.metadata
                .themeId,
          });

          void execute(
            query,
            nextPage,
            activeReceipt,
            true,
            UI_STATE.PAGINATION_LOADING,
          );
        },
      );

      scheduleAdjacentPrefetch(
        activeReceipt,
        rendered.metadata,
      );

      document.dispatchEvent(
        new CustomEvent(
          "ai-search:v4:updated",
          {
            detail: {
              query,

              page:
                rendered
                  .metadata
                  .page,

              engine:
                "ai-search-v4",

              renderReceipt:
                activeReceipt,

              pagination: {
                current_page:
                  rendered
                    .metadata
                    .page,

                page_size:
                  rendered
                    .metadata
                    .pageSize,

                total_products:
                  rendered
                    .metadata
                    .totalProducts,

                total_pages:
                  rendered
                    .metadata
                    .totalPages,
              },

              searchLogId:
                activeSearchLogId,
            },
          },
        ),
      );
    } catch (error) {
      if (
        error?.name !==
          "AbortError" &&
        requestId ===
          requestNumber
      ) {
        console.error(
          logPrefix,
          "executeAiSearch failed",
          {
            query,
            page,

            receipt:
              receipt ||
              null,

            reason:
              error instanceof Error
                ? error.message
                : String(
                    error,
                  ),
          },
        );

        if (executionUiState === UI_STATE.PAGINATION_LOADING) {
          transitionUi(UI_STATE.AI_READY, { mount: activeMount });
        } else if (
          executionUiState === UI_STATE.INITIAL_SEARCH_LOADING &&
          publicState().query === query
        ) {
          transitionUi(UI_STATE.NATIVE_FALLBACK, { mount: activeMount });
        } else {
          transitionUi(UI_STATE.NATIVE_FALLBACK, { mount: activeMount });
          fallback(query);
        }
      }
    } finally {
      if (
        requestId ===
        requestNumber
      ) {
        if (
          uiState !== UI_STATE.AI_READY &&
          uiState !== UI_STATE.NATIVE_FALLBACK
        ) {
          transitionUi(UI_STATE.IDLE, { mount: activeMount });
        }
      }
    }
  }

  function runCurrentSearchEntry(
    replaceUrl,
  ) {
    const current =
      publicState();

    if (
      !current.isSearchPage ||
      current.bypass ||
      !current.query
    ) {
      hideLoading();

      return;
    }

    const runtime =
      runtimeStateFor(
        current.query,
        current.page,
      );

    const receipt =
      runtime?.receipt ||
      current.legacyReceipt ||
      "";

    if (
      runtime?.searchLogId
    ) {
      activeSearchLogId =
        runtime.searchLogId;
    }

    void execute(
      current.query,
      current.page,
      receipt,
      replaceUrl,
      receipt
        ? UI_STATE.PAGINATION_LOADING
        : UI_STATE.INITIAL_SEARCH_LOADING,
    );
  }
  document.addEventListener(
    "submit",
    function (event) {
      const form =
        event.target;

      if (
        !(
          form instanceof
          HTMLFormElement
        )
      ) {
        return;
      }

      const input =
        form.querySelector(
          'input[name="q"]',
        );

      if (
        !(
          input instanceof
          HTMLInputElement
        )
      ) {
        return;
      }

      const action =
        new URL(
          form.action ||
            location.href,
          location.origin,
        );

      if (
        !isSearchPath(
          action.pathname,
        )
      ) {
        return;
      }

      const query =
        input.value.trim();

      if (!query) {
        return;
      }

      event.preventDefault();

      console.info(
        logPrefix,
        "submitAiSearch intercepted",
        {
          query,

          formAction:
            action.pathname +
            action.search,
        },
      );

      activeSearchLogId =
        null;

      activeProducts =
        [];

      removePagination();

      if (
        isSearchPath(
          location.pathname,
        )
      ) {
        console.info(
          logPrefix,
          "submitAiSearch in-place",
          {
            query,
          },
        );

        controller?.abort();
        writePendingUrl(query, false);
        transitionUi(UI_STATE.IN_PLACE_SEARCH_LOADING, {
          mount: activeMount,
        });

        void execute(
          query,
          1,
          "",
          true,
          UI_STATE.IN_PLACE_SEARCH_LOADING,
        );

        return;
      }

      /*
       * Trang khác không có
       * search mount của theme.
       *
       * Cần vào /search shell
       * trước khi V4 render.
       */
      const url =
        searchUrl(
          query,
          1,
        );

      location.assign(
        url.href,
      );
    },
    true,
  );

  document.addEventListener(
    "click",
    function (event) {
      if (
        !activeSearchLogId
      ) {
        return;
      }

      const anchor =
        event.target instanceof
        Element
          ? event.target.closest(
              'a[href*="/products/"]',
            )
          : null;

      if (!anchor) {
        return;
      }

      const card =
        anchor.closest(
          "[data-product-id]",
        );

      const cardProductId =
        normalizeProductGid(
          card?.getAttribute(
            "data-product-id",
          ),
        );

      const activeProductIds =
        new Set(
          activeProducts
            .map(
              function (
                entry,
              ) {
                return normalizeProductGid(
                  entry.productId,
                );
              },
            )
            .filter(
              Boolean,
            ),
        );

      let productId =
        cardProductId &&
        activeProductIds.has(
          cardProductId,
        )
          ? cardProductId
          : "";

      if (!productId) {
        const handle =
          new URL(
            anchor.href,
            location.origin,
          )
            .pathname
            .match(
              /\/products\/([^/?#]+)/,
            )?.[1];

        const product =
          activeProducts.find(
            function (
              entry,
            ) {
              return (
                entry.handle ===
                handle
              );
            },
          );

        productId =
          normalizeProductGid(
            product?.productId,
          );
      }

      if (!productId) {
        return;
      }

      void fetch(
        clickEndpoint,
        {
          method:
            "POST",

          credentials:
            "same-origin",

          keepalive:
            true,

          headers: {
            "Content-Type":
              "application/json",
          },

          body:
            JSON.stringify(
              {
                searchLogId:
                  activeSearchLogId,

                productId,
              },
            ),
        },
      );
    },
    true,
  );

  window.addEventListener(
    "popstate",
    function () {
      runCurrentSearchEntry(
        true,
      );
    },
  );

  window.addEventListener(
    "pageshow",
    function (event) {
      if (
        !event.persisted
      ) {
        return;
      }

      const current =
        publicState();

      const runtime =
        runtimeStateFor(
          current.query,
          current.page,
        );

      const renderedReceipt =
        document
          .documentElement
          .dataset
          .aiSearchV4Receipt ||
        "";

      const renderedPage =
        Number.parseInt(
          document
            .documentElement
            .dataset
            .aiSearchV4Page ||
            "1",
          10,
        );

      if (
        current.isSearchPage &&
        !current.bypass &&
        current.query &&
        runtime?.receipt &&
        renderedReceipt ===
          runtime.receipt &&
        renderedPage ===
          current.page
      ) {
        activeSearchLogId =
          runtime.searchLogId ||
          activeSearchLogId;

        hideLoading();

        console.info(
          logPrefix,
          "pageshow BFCache restored",
          {
            query:
              current.query,

            page:
              current.page,

            receipt:
              runtime.receipt,
          },
        );

        return;
      }

      runCurrentSearchEntry(
        true,
      );
    },
  );

  console.info(
    logPrefix,
    "loaded",
    {
      source:
        "search-interceptor.v4.js",

      configVersion:
        config.version ??
        null,

      themeMapVersion:
        config.theme_map_version ??
        null,

      endpoint,
    },
  );

  const initial =
    publicState();

  if (
    initial.isSearchPage &&
    !initial.bypass &&
    initial.query
  ) {
    transitionUi(UI_STATE.INITIAL_SEARCH_LOADING);

    runCurrentSearchEntry(
      true,
    );
  }
})();
