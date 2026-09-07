(function () {
  "use strict";
  if (window.__aiSearchV3Installed) return;
  window.__aiSearchV3Installed = true;
  if (
    window.Shopify?.designMode ||
    window.AI_SEARCH_CONFIG?.designMode ||
    new URL(location.href).searchParams.has("preview_theme_id") ||
    (window.Shopify?.theme?.role && window.Shopify.theme.role !== "main")
  )
    return;

  console.log("[AI SEARCH V3] Search Interceptor V3 loaded (ID Paging Optimized)");
  const config = window.AI_SEARCH_CONFIG || {};
  const SEARCH_ENDPOINT = config.search_endpoint || "/apps/ai-search";
  const AI_SEARCH_PARAM = "ai_search";
  const STATE_KEY = "aiSearchV3";
  let activeController = null;
  let activeRequestId = 0;
  let interceptionInstalled = false;
  const NATIVE_BYPASS_PARAM = "_ai_search_bypass";
  const SAFE_SEARCH_PARAMS = new Set([
    "q",
    "type",
    "page",
    "sort_by",
    "options[prefix]",
  ]);
  const NATIVE_ONLY_PARAMS = new Set([
    "constraint",
    "product_type",
    "vendor",
    "tag",
    "view",
    "section_id",
    "sections",
    "options[unavailable_products]",
  ]);

  const defaultSearchTypes = Array.isArray(config.defaultSearchTypes)
    ? config.defaultSearchTypes
    : [];
  const unscopedSearchMode = config.unscopedSearchMode || "product_only";

  // ==========================================
  // CLIENT-SIDE PRODUCT ID STORAGE & THEME MAP
  // ==========================================
  const THEME_MAP_CACHE_KEY = "ai_search_theme_map_v3";
  const THEME_MAP_TTL = 24 * 60 * 60 * 1000; // 24 Hours
  const ID_CACHE_KEY_PREFIX = "ai_search_ids_";

  function getCachedThemeMap() {
    try {
      const item = localStorage.getItem(THEME_MAP_CACHE_KEY);
      if (!item) return null;
      const parsed = JSON.parse(item);
      if (Date.now() - parsed.timestamp < THEME_MAP_TTL) {
        return parsed.schema;
      }
      localStorage.removeItem(THEME_MAP_CACHE_KEY);
    } catch {
      /* ignore */
    }
    return null;
  }

  function setCachedThemeMap(schema) {
    try {
      localStorage.setItem(
        THEME_MAP_CACHE_KEY,
        JSON.stringify({ schema, timestamp: Date.now() })
      );
    } catch {
      /* ignore */
    }
  }

  // Xóa toàn bộ ID cũ trong sessionStorage khi tìm từ khóa mới
  function clearProductIdsCache() {
    try {
      Object.keys(sessionStorage).forEach((key) => {
        if (key.startsWith(ID_CACHE_KEY_PREFIX)) {
          sessionStorage.removeItem(key);
        }
      });
    } catch {
      /* ignore */
    }
  }

  // Lưu mảng ID/Handle của từ khóa vào sessionStorage
  function saveProductIdsForQuery(query, allProducts) {
    clearProductIdsCache();
    try {
      const key = `${ID_CACHE_KEY_PREFIX}${query.toLowerCase().trim()}`;
      sessionStorage.setItem(key, JSON.stringify(allProducts));
    } catch {
      console.warn("[AI SEARCH V3] Failed to save product IDs to sessionStorage");
    }
  }

  // Cắt mảng ID sản phẩm từ sessionStorage khi Next trang
  function getPagedProductsFromStorage(query, page, pageSize = 20) {
    try {
      const key = `${ID_CACHE_KEY_PREFIX}${query.toLowerCase().trim()}`;
      const raw = sessionStorage.getItem(key);
      if (!raw) return null;

      const allProducts = JSON.parse(raw);
      const totalProducts = allProducts.length;
      const totalPages = Math.ceil(totalProducts / pageSize);

      if (page > totalPages) return null;

      const start = (page - 1) * pageSize;
      const pageProducts = allProducts.slice(start, start + pageSize);

      if (pageProducts.length === 0) return null;

      return {
        products: pageProducts,
        target_ids: pageProducts.map((p) => `id:${p.id}`).join(" OR "),
        pagination: {
          current_page: page,
          page_size: pageSize,
          total_products: totalProducts,
          total_pages: totalPages,
        },
      };
    } catch {
      return null;
    }
  }

  // ==========================================
  // HELPER & ROUTING FUNCTIONS
  // ==========================================
  function isNativeSearchPath(pathname) {
    return /\/search\/?$/i.test(pathname);
  }

  function resourceTypes(url) {
    const explicit = url.searchParams
      .getAll("type")
      .flatMap((value) => value.split(","))
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);

    if (explicit.length) return [...new Set(explicit)];
    if (unscopedSearchMode === "product_only") return ["product"];
    return [...new Set(defaultSearchTypes)];
  }

  function productOnlySearch(url) {
    const types = resourceTypes(url);
    return types.length === 1 && types[0] === "product";
  }

  function normalizeProductOnlyType(url) {
    if (url.searchParams.has("type")) return;
    if (productOnlySearch(url)) url.searchParams.set("type", "product");
  }

  function looksLikeExactIdentifier(query) {
    const compact = query.trim();
    if (!compact || /\s/.test(compact)) return false;
    if (/^\d{3,18}$/.test(compact)) return true;
    if (/^[\d._\-/#:]+$/.test(compact)) {
      if (compact.replace(/\D/g, "").length >= 3) return true;
    }
    return (
      /[A-Za-z]/.test(compact) &&
      /\d/.test(compact) &&
      /^[A-Za-z0-9._\-/#:]{2,64}$/.test(compact)
    );
  }

  function usesAdvancedShopifySyntax(query) {
    return (
      /\*/.test(query) ||
      /\b(?:AND|OR|NOT)\b/.test(query) ||
      /(^|\s)[^\s:]+:[^\s]+/.test(query) ||
      /^(["']).+\1$/.test(query)
    );
  }

  function hasUnsupportedSearchParameters(url) {
    for (const [rawKey] of url.searchParams) {
      const key = rawKey.toLowerCase();
      if (key === NATIVE_BYPASS_PARAM) continue;
      if (NATIVE_ONLY_PARAMS.has(key)) return true;

      if (
        key.startsWith("filter.") ||
        key.startsWith("filter[") ||
        key.startsWith("filter%5b") ||
        key.startsWith("t.category")
      ) {
        return true;
      }

      if (!SAFE_SEARCH_PARAMS.has(rawKey)) return true;
    }

    const pageRaw = url.searchParams.get("page");
    if (pageRaw) {
      const page = Number.parseInt(pageRaw, 10);
      if (!Number.isSafeInteger(page) || page < 1) return true;
    }

    const sortBy = (url.searchParams.get("sort_by") || "").trim().toLowerCase();
    if (sortBy && sortBy !== "relevance") return true;

    const prefix = (url.searchParams.get("options[prefix]") || "")
      .trim()
      .toLowerCase();
    if (prefix && prefix !== "last" && prefix !== "none") return true;

    return false;
  }

  function shouldUseAi(url) {
    url.searchParams.delete("ai_search");
    if (!isNativeSearchPath(url.pathname)) return false;
    if (url.searchParams.get(NATIVE_BYPASS_PARAM) === "1") return false;

    const query = (url.searchParams.get("q") || "").trim();
    if (query.length < 3) return false;
    if (looksLikeExactIdentifier(query)) return false;
    if (usesAdvancedShopifySyntax(query)) return false;
    if (!productOnlySearch(url)) return false;

    normalizeProductOnlyType(url);
    if (hasUnsupportedSearchParameters(url)) return false;

    return true;
  }

  function getThemeSchema() {
    return window.AI_SEARCH_CONFIG?.schema || null;
  }

  function getThemeMap() {
    return getThemeSchema()?.search || {};
  }

  function getUrlParams() {
    return new URLSearchParams(window.location.search);
  }

  function getQueryFromUrl() {
    return (getUrlParams().get("q") || "").trim();
  }

  function getPageFromUrl() {
    const raw = parseInt(getUrlParams().get("page") || "1", 10);
    return Number.isFinite(raw) && raw >= 1 ? raw : 1;
  }

  function isAiSearchPage() {
    return getUrlParams().get(AI_SEARCH_PARAM) === "1";
  }

  function isNativeSearchPage() {
    const path = window.location.pathname;
    return path === "/search" || path.endsWith("/search");
  }

  function nativeTarget(query) {
    const url = new URL(config.search_url || "/search", location.origin);
    url.searchParams.set("q", String(query || "").trim());
    url.searchParams.set("type", "product");
    return url;
  }

  function buildAiBackendUrl(query, page) {
    const url = new URL(SEARCH_ENDPOINT, location.origin);
    if (url.origin !== location.origin) throw new Error("Invalid app proxy URL");

    url.searchParams.set("q", query);
    url.searchParams.set("format", "json");
    url.searchParams.set(
      "page",
      String(
        Number.isSafeInteger(Number.parseInt(String(page || 1), 10))
          ? Number.parseInt(String(page || 1), 10)
          : 1
      )
    );

    const target = nativeTarget(query);
    url.searchParams.set("native_search_url", target.pathname + target.search);

    const schema = getThemeSchema();
    if (schema) {
      url.searchParams.set("theme_id", schema.theme.id);
      url.searchParams.set("map_fingerprint", schema.fingerprint);
    }

    return url.pathname + url.search;
  }

  async function ensureThemeMap(query, signal) {
    const cachedSchema = getCachedThemeMap();
    if (cachedSchema) {
      config.theme_id = cachedSchema.theme.id;
      config.schema = cachedSchema;
      return cachedSchema;
    }

    const url = new URL(buildAiBackendUrl(query, 1), location.origin);
    url.searchParams.set("mode", "theme-map");

    const response = await fetch(url, {
      signal,
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });

    if (!response.ok) throw new Error("Theme Map unavailable");
    const data = await response.json();

    if (data.status !== "success" || !data.theme_map) {
      throw new Error("Theme Map unavailable");
    }

    config.theme_id = data.theme_map.theme.id;
    config.schema = data.theme_map;

    setCachedThemeMap(data.theme_map);
    return data.theme_map;
  }

  function fallbackToNative(query) {
    restoreNativeResults();
    restoreNativePagination();
    hideLoadingMessage();

    const url = nativeTarget(query);
    url.searchParams.set("_ai_search_bypass", "1");
    location.replace(url.pathname + url.search);
  }

  function buildNativeAiSearchUrl(query, page = 1) {
    const url = new URL(config.search_url || "/search", location.origin);
    url.searchParams.set("q", String(query || "").trim());
    url.searchParams.set("type", "product");
    url.searchParams.set(AI_SEARCH_PARAM, "1");
    if (Number(page) > 1) url.searchParams.set("page", String(page));
    return url.pathname + url.search;
  }

  function buildNativeRenderUrl(targetIds, page = 1) {
    const url = new URL(config.search_url || "/search", location.origin);
    url.searchParams.set("q", targetIds);
    url.searchParams.set("type", "product");
    url.searchParams.set("_ai_search_bypass", "1");
    if (page > 1) url.searchParams.set("page", String(page));
    return url.pathname + url.search;
  }

  function updateBrowserUrl(query, page = 1, replace = false) {
    const url = buildNativeAiSearchUrl(query, page);
    const state = { [STATE_KEY]: true, query, page };
    if (replace) {
      window.history.replaceState(state, "", url);
    } else {
      window.history.pushState(state, "", url);
    }
  }

  function safeQuery(root, selector) {
    if (!root || !selector) return null;
    try {
      return root.querySelector(selector);
    } catch {
      return null;
    }
  }

  function mappedRoots(root, map) {
    const ids = map.searchTemplateStructure?.[0]?.sectionIds || [];
    const types = map.searchSectionTypes || [];
    const sections = Array.from(root.querySelectorAll('[id^="shopify-section-"]'));

    const matched = sections.filter(
      (section) =>
        ids.some(
          (id) =>
            section.id.endsWith("__" + id) ||
            section.id === "shopify-section-" + id
        ) ||
        types.some((type) => section.id === "shopify-section-" + type)
    );

    return matched.length ? matched : [safeQuery(root, "main") || root];
  }

  function findProductGrid(root, map) {
    for (const scope of mappedRoots(root, map)) {
      const grid = findProductGridWithin(scope, map);
      if (grid) return grid;
    }
    return null;
  }

  function findProductGridWithin(root, map) {
    if (!root || typeof root.querySelector !== "function") return null;
    if (map && map.grid_selector) {
      const mapped = safeQuery(root, map.grid_selector);
      if (mapped) return mapped;
    }

    const selectors = [
      "#product-grid",
      ".product-grid",
      ".collection-product-list",
      ".product-list",
      ".search-results__products",
      ".template-search__results .grid",
      ".template-search .grid",
      "[data-product-grid]",
      "[id*='product-grid']",
    ];

    for (const selector of selectors) {
      const element = safeQuery(root, selector);
      if (element) return element;
    }

    const links = Array.from(root.querySelectorAll('a[href*="/products/"]'));
    if (links.length < 1) return null;

    let bestCandidate = null;
    let bestScore = 0;

    links.forEach((link) => {
      let current = link.parentElement;
      let depth = 0;

      while (current && depth < 8) {
        const tag = current.tagName ? current.tagName.toLowerCase() : "";
        if (tag === "main" || tag === "body" || current.id === "MainContent") break;

        const productCount = current.querySelectorAll('a[href*="/products/"]').length;
        if (productCount >= 1) {
          const score = productCount * 10 - depth;
          if (score > bestScore) {
            bestScore = score;
            bestCandidate = current;
          }
        }
        current = current.parentElement;
        depth++;
      }
    });

    return bestCandidate;
  }

  function hideNativeResults() {
    if (!isAiSearchPage()) return null;
    const map = getThemeMap();
    const grid = findProductGrid(document, map);
    if (!grid) return null;

    grid.dataset.aiSearchV3Hidden = "true";
    grid.style.visibility = "hidden";
    grid.style.opacity = "0";
    grid.setAttribute("aria-hidden", "true");
    return grid;
  }

  function showAiResults(grid) {
    if (!grid) return;
    grid.style.visibility = "";
    grid.style.opacity = "";
    grid.removeAttribute("aria-hidden");
    delete grid.dataset.aiSearchV3Hidden;

    document.documentElement.classList.remove("ai-search-v3-pending");
    document.documentElement.classList.add("ai-search-v3-ready");
  }

  function restoreNativeResults() {
    document.querySelectorAll('[data-ai-search-v3-hidden="true"]').forEach((grid) => {
      grid.style.visibility = "";
      grid.style.opacity = "";
      grid.removeAttribute("aria-hidden");
      delete grid.dataset.aiSearchV3Hidden;
    });

    document.documentElement.classList.remove("ai-search-v3-pending");
    document.documentElement.classList.remove("ai-search-v3-ready");
  }

  function findSearchRoot(grid, map) {
    if (grid) {
      return (
        grid.closest('[id^="shopify-section-"]') ||
        grid.closest("main") ||
        grid.parentElement
      );
    }
    return mappedRoots(document, map)[0] || null;
  }

  function removeAiPagination() {
    document.querySelectorAll(".ai-search-v3-pagination").forEach((element) => {
      element.remove();
    });
  }

  function hideNativePagination(root) {
    if (!root) return;
    const selectors = [
      ".pagination",
      ".pagination-wrapper",
      ".main-search__pagination",
      "nav.pagination",
      "[data-pagination]",
    ];

    selectors.forEach((selector) => {
      root.querySelectorAll(selector).forEach((element) => {
        if (element.classList.contains("ai-search-v3-pagination")) return;
        element.style.display = "none";
        element.dataset.aiSearchHidden = "true";
      });
    });
  }

  function restoreNativePagination() {
    document.querySelectorAll('[data-ai-search-hidden="true"]').forEach((element) => {
      element.style.display = "";
      delete element.dataset.aiSearchHidden;
    });
  }

  function updateSearchInputs(query) {
    document
      .querySelectorAll('input[name="q"], input[type="search"]')
      .forEach((input) => {
        if (document.activeElement !== input) {
          input.value = query;
        }
      });
  }

  function setLoading(isLoading) {
    const map = getThemeMap();
    const grid = findProductGrid(document, map);
    if (!grid) return;

    if (isLoading) {
      grid.classList.add("ai-search-v3-loading");
      grid.setAttribute("aria-busy", "true");
    } else {
      grid.classList.remove("ai-search-v3-loading");
      grid.removeAttribute("aria-busy");
    }
  }

  function showLoadingMessage() {
    let element = document.querySelector(".ai-search-v3-status");
    const map = getThemeMap();
    const grid = findProductGrid(document, map);

    if (!element) {
      element = document.createElement("div");
      element.className = "ai-search-v3-status";
      element.setAttribute("role", "status");
      element.setAttribute("aria-live", "polite");
      element.style.display = "none";

      if (grid && grid.parentElement) {
        grid.parentElement.insertBefore(element, grid);
      }
    }

    if (!element) return;
    element.textContent = "Đang tìm kiếm...";
    element.style.display = "";
  }

  function hideLoadingMessage() {
    const element = document.querySelector(".ai-search-v3-status");
    if (element) element.style.display = "none";
  }

  function getVisiblePages(totalPages, currentPage) {
    const pages = new Set();
    pages.add(1);
    pages.add(totalPages);

    for (let page = currentPage - 2; page <= currentPage + 2; page++) {
      if (page >= 1 && page <= totalPages) pages.add(page);
    }

    return Array.from(pages).sort((a, b) => a - b);
  }

  function createPaginationButton(text, page, options = {}) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ai-search-v3-page-btn";
    button.textContent = text;
    button.dataset.page = String(page);

    if (options.current) {
      button.setAttribute("aria-current", "page");
      button.disabled = true;
    }

    button.addEventListener("click", function () {
      if (button.disabled) return;
      const query = getQueryFromUrl();
      if (!query) return;

      updateBrowserUrl(query, page, false);
      hideNativeResults();
      executeAiSearch(query, page);
    });

    return button;
  }

  function createPaginationEllipsis() {
    const element = document.createElement("span");
    element.className = "ai-search-v3-pagination-ellipsis";
    element.textContent = "…";
    return element;
  }

  function renderPagination(query, pagination, targetGrid) {
    removeAiPagination();
    if (!targetGrid) return;

    const totalPages = Number(pagination?.total_pages || 0);
    const currentPage = Number(pagination?.current_page || 1);
    const totalProducts = Number(pagination?.total_products || 0);

    if (!Number.isFinite(totalPages) || totalPages <= 1) return;

    const nav = document.createElement("nav");
    nav.className = "ai-search-v3-pagination";
    nav.setAttribute("aria-label", "AI Search pagination");

    if (currentPage > 1) {
      nav.appendChild(createPaginationButton("←", currentPage - 1));
    }

    const pages = getVisiblePages(totalPages, currentPage);
    let previousPage = null;

    pages.forEach((page) => {
      if (previousPage !== null && page > previousPage + 1) {
        nav.appendChild(createPaginationEllipsis());
      }
      nav.appendChild(
        createPaginationButton(String(page), page, {
          current: page === currentPage,
        })
      );
      previousPage = page;
    });

    if (currentPage < totalPages) {
      nav.appendChild(createPaginationButton("→", currentPage + 1));
    }

    if (totalProducts > 0) {
      const info = document.createElement("span");
      info.className = "ai-search-v3-pagination-info";
      info.textContent = `${totalProducts} sản phẩm`;
      nav.appendChild(info);
    }

    if (targetGrid.parentElement) {
      targetGrid.parentElement.insertBefore(nav, targetGrid.nextSibling);
    }
  }

  function normalizeTargetIds(targetIds) {
    if (Array.isArray(targetIds)) {
      return targetIds
        .filter(Boolean)
        .map((id) => String(id).trim())
        .filter(Boolean)
        .join(" OR ");
    }
    return String(targetIds || "").trim();
  }

  // --- THAY BẰNG HÀM MỚI NÀY ---
  async function fetchAiResults(query, page, signal) {
    const url = buildAiBackendUrl(query, page);
    const response = await fetch(url, {
      method: "GET",
      credentials: "same-origin",
      signal,
      headers: { Accept: "application/json" },
    });

    if (!response.ok) throw new Error(`AI Search HTTP ${response.status}`);
    const data = await response.json();

    // Tự động làm mới Theme Map khi Server báo đổi Theme
    if (data.status === "theme_map_refreshed" && data.theme_map) {
      console.warn("[AI SEARCH V3] Phát hiện đổi Theme, đang tự động cập nhật lại Theme Map...");
      setCachedThemeMap(data.theme_map);
      config.theme_id = data.theme_map.theme.id;
      config.schema = data.theme_map;

      // Gọi lại search ngay lập tức
      return fetchAiResults(query, page, signal);
    }

    if (!data || data.status !== "success") {
      throw new Error(data?.message || "AI Search backend error");
    }
    return data;
  }
  // -----------------------------

  async function fetchNativeSearchHtml(targetIds, signal, page = 1) {
    const response = await fetch(buildNativeRenderUrl(targetIds, page), {
      signal,
      credentials: "same-origin",
      headers: { Accept: "text/html" },
    });

    if (!response.ok) {
      throw new Error("Shopify native search HTTP " + response.status);
    }
    return response.text();
  }

  function parseHtmlDocument(html) {
    const parser = new DOMParser();
    return parser.parseFromString(html, "text/html");
  }

  function replaceProductGrid(currentGrid, newGrid) {
    if (!currentGrid || !newGrid) return false;
    const fragment = document.createDocumentFragment();
    Array.from(newGrid.childNodes).forEach((node) => {
      fragment.appendChild(document.importNode(node, true));
    });
    currentGrid.replaceChildren(fragment);
    return true;
  }

  function activateImages(container) {
    if (!container) return;
    container.querySelectorAll("img").forEach((img) => {
      const dataSrc = img.dataset.src;
      const dataSrcset = img.dataset.srcset;

      if (dataSrc && !img.getAttribute("src")) img.src = dataSrc;
      if (dataSrcset && !img.getAttribute("srcset")) img.srcset = dataSrcset;
      img.removeAttribute("loading");
    });
  }

  function dispatchSearchUpdated(detail) {
    document.dispatchEvent(
      new CustomEvent("ai-search:v3:updated", { detail })
    );
  }

  // ==========================================
  // CORE SEARCH EXECUTION WITH CLIENT ID CACHE
  // ==========================================
  async function executeAiSearch(rawQuery, rawPage = 1) {
    const query = String(rawQuery || "").trim();
    if (!query || query.includes("id:")) return;

    const pageRaw = Number.parseInt(String(rawPage), 10);
    const page = Number.isSafeInteger(pageRaw) && pageRaw > 0 ? pageRaw : 1;

    const policyUrl = nativeTarget(query);
    policyUrl.searchParams.set("page", String(page));

    if (!shouldUseAi(policyUrl)) {
      fallbackToNative(query);
      return;
    }

    activeController?.abort();
    const controller = new AbortController();
    activeController = controller;
    const requestId = ++activeRequestId;
    const timer = setTimeout(() => controller.abort(), 30000);
    const signal = controller.signal;

    try {
      const schema = await ensureThemeMap(query, signal);
      if (requestId !== activeRequestId) return;

      const map = schema.search || getThemeMap() || {};

      // BƯỚC 1: BẤM NEXT TRANG -> ĐỌC ID TỪ BỘ NHỚ TRÌNH DUYỆT (Skip Backend hoàn toàn!)
      if (page > 1) {
        const localPagedData = getPagedProductsFromStorage(query, page);

        if (localPagedData && localPagedData.products.length > 0) {
          console.log(`[AI SEARCH V3] Hit Client ID Cache cho Trang ${page} -> Bỏ qua Server Proxy!`);

          const currentGrid = hideNativeResults() || findProductGrid(document, map);
          if (!currentGrid) throw new Error("Current Product Grid not found");

          setLoading(true);
          showLoadingMessage();

          const html = await fetchNativeSearchHtml(localPagedData.target_ids, signal, page);
          if (requestId !== activeRequestId) return;

          const nativeDocument = parseHtmlDocument(html);
          const nativeGrid = findProductGrid(nativeDocument, map);
          const liveGrid = findProductGrid(document, map);

          if (liveGrid && nativeGrid) {
            replaceProductGrid(liveGrid, nativeGrid);
            activateImages(liveGrid);
            hideNativePagination(findSearchRoot(liveGrid, map));
            renderPagination(query, localPagedData.pagination, liveGrid);
            updateSearchInputs(query);
            updateBrowserUrl(query, page, true);
            showAiResults(liveGrid);
            setLoading(false);
            hideLoadingMessage();

            dispatchSearchUpdated({
              query,
              page,
              pagination: localPagedData.pagination,
              targetIds: localPagedData.target_ids,
              products: localPagedData.products,
            });
            return; // KẾT THÚC NGAY, KHÔNG GỌI VỀ BACKEND SERVER
          }
        }
      }

      // BƯỚC 2: TÌM KÍẾM MỚI (PAGE 1) -> TỰ ĐỘNG XÓA CACHE CỦ & GỌI SERVER BACKEND
      if (page === 1) {
        clearProductIdsCache();
      }

      const currentGrid = hideNativeResults() || findProductGrid(document, map);
      if (!currentGrid) throw new Error("Current Product Grid not found");

      setLoading(true);
      showLoadingMessage();

      const data = await fetchAiResults(query, page, signal);
      if (requestId !== activeRequestId) return;

      // Lưu toàn bộ danh sách ID trả về vào sessionStorage
      if (data.all_products && Array.isArray(data.all_products)) {
        saveProductIdsForQuery(query, data.all_products);
      }

      const targetIds = normalizeTargetIds(data.target_ids);
      if (!targetIds) throw new Error("AI Search did not return target_ids");

      const html = await fetchNativeSearchHtml(targetIds, signal);
      if (requestId !== activeRequestId) return;

      const nativeDocument = parseHtmlDocument(html);
      const nativeGrid = findProductGrid(nativeDocument, map);
      if (!nativeGrid) throw new Error("Product Grid not found in Shopify native HTML");

      const liveGrid = findProductGrid(document, map);
      if (!liveGrid) throw new Error("Live Product Grid not found");

      if (!replaceProductGrid(liveGrid, nativeGrid)) {
        throw new Error("Unable to replace Product Grid");
      }

      activateImages(liveGrid);
      hideNativePagination(findSearchRoot(liveGrid, map));
      renderPagination(query, data.pagination || {}, liveGrid);
      updateSearchInputs(query);
      updateBrowserUrl(query, page, true);
      showAiResults(liveGrid);

      dispatchSearchUpdated({
        query,
        page,
        pagination: data.pagination || {},
        targetIds,
        products: data.products || [],
      });
    } catch (error) {
      if (requestId !== activeRequestId || error?.name === "AbortError") return;
      console.error("[AI SEARCH V3] Search error:", error);
      showAiResults(findProductGrid(document, getThemeMap()));
      fallbackToNative(query);
    } finally {
      clearTimeout(timer);
      if (requestId === activeRequestId) {
        setLoading(false);
        hideLoadingMessage();
      }
    }
  }

  function submitAiSearch(rawQuery) {
    const query = String(rawQuery || "").trim();
    if (!query) return;

    const target = nativeTarget(query);
    if (!shouldUseAi(target)) {
      window.location.assign(target.pathname + target.search);
      return;
    }
    window.location.assign(buildNativeAiSearchUrl(query, 1));
  }

  function stopSearchEvent(event) {
    event.preventDefault();
    event.stopPropagation();
    if (typeof event.stopImmediatePropagation === "function") {
      event.stopImmediatePropagation();
    }
  }

  function installSearchInterception() {
    if (interceptionInstalled) return;
    interceptionInstalled = true;

    function findSearchInput(form) {
      if (!(form instanceof HTMLFormElement)) return null;
      return form.querySelector('input[name="q"], input[type="search"], textarea[name="q"]');
    }

    function isSearchForm(form, input) {
      if (!input) return false;
      const action = (form.getAttribute("action") || "").trim();
      if (action) {
        const actionUrl = new URL(action, location.origin);
        if (isNativeSearchPath(actionUrl.pathname)) return true;
      }
      return (
        /search/i.test(String(form.className || "")) ||
        form.hasAttribute("data-search-form") ||
        form.hasAttribute("data-predictive-search") ||
        input.name === "q"
      );
    }

    window.addEventListener(
      "submit",
      (event) => {
        const form = event.target;
        if (!(form instanceof HTMLFormElement) || form.method.toLowerCase() !== "get") return;

        const input = findSearchInput(form);
        if (!isSearchForm(form, input)) return;

        const target = new URL(config.search_url || "/search", location.origin);
        const fields = new FormData(form, event.submitter || undefined);

        for (const [key, value] of fields) {
          if (typeof value !== "string" || key === AI_SEARCH_PARAM || key === NATIVE_BYPASS_PARAM) continue;
          target.searchParams.append(key, value);
        }

        if (!target.searchParams.get("q")) {
          target.searchParams.set("q", input.value || "");
        }

        normalizeProductOnlyType(target);

        if (!shouldUseAi(target)) {
          stopSearchEvent(event);
          location.assign(target.pathname + target.search);
          return;
        }

        stopSearchEvent(event);
        target.searchParams.set("ai_search", "1");
        location.assign(target.pathname + target.search);
      },
      true
    );

    window.addEventListener(
      "click",
      (event) => {
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.ctrlKey ||
          event.metaKey ||
          event.shiftKey ||
          event.altKey
        ) return;

        const link = event.target?.closest?.("a[href]");
        if (!link || link.download || (link.target && link.target !== "_self")) return;

        const target = new URL(link.href, location.origin);
        if (target.origin !== location.origin || !isNativeSearchPath(target.pathname)) return;

        const marked = target.searchParams.has("ai_search");
        target.searchParams.delete("ai_search");

        if (shouldUseAi(target)) {
          stopSearchEvent(event);
          target.searchParams.set("ai_search", "1");
          location.assign(target.pathname + target.search);
        } else if (marked) {
          stopSearchEvent(event);
          target.searchParams.set("_ai_search_bypass", "1");
          location.assign(target.pathname + target.search);
        }
      },
      true
    );
  }

  function initOnPageLoad() {
    if (!isNativeSearchPage()) return;
    const url = new URL(location.href);

    if (url.searchParams.get(NATIVE_BYPASS_PARAM) === "1") {
      url.searchParams.delete(NATIVE_BYPASS_PARAM);
      url.searchParams.delete(AI_SEARCH_PARAM);
      history.replaceState(history.state, "", url.pathname + url.search);
      return;
    }

    const query = (url.searchParams.get("q") || "").trim();
    if (!query || query.includes("id:")) return;

    if (url.searchParams.get(AI_SEARCH_PARAM) !== "1") return;

    hideNativeResults();
    executeAiSearch(query, getPageFromUrl());
  }

  function handlePopState() {
    activeController?.abort();
    activeRequestId += 1;

    if (!isAiSearchPage()) {
      location.reload();
      return;
    }

    executeAiSearch(getQueryFromUrl(), getPageFromUrl());
  }

  window.addEventListener("popstate", handlePopState);

  window.AI_SEARCH_V3 = {
    search: submitAiSearch,
    executeAiSearch,
    getThemeMap,
    findProductGrid,
    getQuery: getQueryFromUrl,
    getPage: getPageFromUrl,
  };

  installSearchInterception();

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initOnPageLoad, { once: true });
  } else {
    initOnPageLoad();
  }
})();