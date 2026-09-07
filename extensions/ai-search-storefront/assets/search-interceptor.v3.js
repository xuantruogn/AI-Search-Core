(function () {
  "use strict";
  if (window.__aiSearchV3Installed) return;
  window.__aiSearchV3Installed = true;
  if (window.Shopify?.designMode || window.AI_SEARCH_CONFIG?.designMode ||
      new URL(location.href).searchParams.has("preview_theme_id") ||
      (window.Shopify?.theme?.role && window.Shopify.theme.role !== "main")) return;

  console.log(
    "[AI SEARCH V3] Search Interceptor V3 loaded"
  );
  const config =
    window.AI_SEARCH_CONFIG || {};
  const SEARCH_ENDPOINT =
    config.search_endpoint ||
    "/apps/ai-search";
  const AI_SEARCH_PARAM =
    "ai_search";
  const STATE_KEY =
    "aiSearchV3";
  let activeController =
    null;
  let activeRequestId =
    0;
  let interceptionInstalled =
    false;
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

  const defaultSearchTypes = Array.isArray(config.defaultSearchTypes) ? config.defaultSearchTypes : [];
  const unscopedSearchMode = config.unscopedSearchMode || "product_only";

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

      // AI Search xử lý pagination riêng.
      // Page >= 1 đều được phép.
      if (!Number.isSafeInteger(page) || page < 1) {
        return true;
      }
    }

    const sortBy =
      (url.searchParams.get("sort_by") || "")
        .trim()
        .toLowerCase();

    if (sortBy && sortBy !== "relevance") {
      return true;
    }

    const prefix =
      (url.searchParams.get("options[prefix]") || "")
        .trim()
        .toLowerCase();

    if (
      prefix &&
      prefix !== "last" &&
      prefix !== "none"
    ) {
      return true;
    }

    return false;
  }

  function shouldUseAi(url) {
    url.searchParams.delete("ai_search");

    if (!isNativeSearchPath(url.pathname)) {
      return false;
    }

    if (
      url.searchParams.get(NATIVE_BYPASS_PARAM) === "1"
    ) {
      return false;
    }

    const query =
      (url.searchParams.get("q") || "").trim();

    if (query.length < 3) {
      return false;
    }

    if (looksLikeExactIdentifier(query)) {
      return false;
    }

    if (usesAdvancedShopifySyntax(query)) {
      return false;
    }

    if (!productOnlySearch(url)) {
      return false;
    }

    normalizeProductOnlyType(url);

    if (hasUnsupportedSearchParameters(url)) {
      return false;
    }

    return true;
  }

  function getThemeSchema() {
    return window.AI_SEARCH_CONFIG?.schema || null;
  }

  function getThemeMap() {
    return getThemeSchema()?.search || {};
  }

  function getUrlParams() {
    return new URLSearchParams(
      window.location.search
    );
  }

  function getQueryFromUrl() {
    return (
      getUrlParams()
        .get("q") || ""
    ).trim();
  }

  function getPageFromUrl() {
    const raw =
      parseInt(
        getUrlParams()
          .get("page") || "1",
        10
      );

    return (
      Number.isFinite(raw) &&
      raw >= 1
    )
      ? raw
      : 1;
  }

  function isAiSearchPage() {
    const params =
      getUrlParams();

    return (
      params.get(
        AI_SEARCH_PARAM
      ) === "1"
    );
  }

  function isNativeSearchPage() {
    const path =
      window.location.pathname;

    return (
      path === "/search" ||
      path.endsWith("/search")
    );
  }

  function nativeTarget(query) {
  const url = new URL(
    config.search_url || "/search",
    location.origin
  );

  url.searchParams.set(
    "q",
    String(query || "").trim()
  );


  url.searchParams.set(
    "type",
    "product"
  );

  return url;
}

  function buildAiBackendUrl(
    query,
    page
  ) {
    const url =
      new URL(
        SEARCH_ENDPOINT,
        location.origin
      );

    if (
      url.origin !==
      location.origin
    ) {
      throw new Error(
        "Invalid app proxy URL"
      );
    }

    url.searchParams.set(
      "q",
      query
    );

    url.searchParams.set(
      "format",
      "json"
    );

    // const target =
    //   nativeTarget(query);

    // if (page > 1) {
    //   target.searchParams.set(
    //     "page",
    //     String(page)
    //   );
    // }
    url.searchParams.set(
  "page",
  String(
    Number.isSafeInteger(
      Number.parseInt(String(page || 1), 10)
    )
      ? Number.parseInt(String(page || 1), 10)
      : 1
  )
);

const target =
  nativeTarget(query);

    url.searchParams.set(
      "native_search_url",
      target.pathname +
        target.search
    );

    const schema =
      getThemeSchema();

    if (schema) {
      url.searchParams.set(
        "theme_id",
        schema.theme.id
      );

      url.searchParams.set(
        "map_fingerprint",
        schema.fingerprint
      );
    }

    return (
      url.pathname +
      url.search
    );
  }

  async function ensureThemeMap(
    query,
    signal
  ) {
    const url =
      new URL(
        buildAiBackendUrl(
          query,
          1
        ),
        location.origin
      );

    url.searchParams.set(
      "mode",
      "theme-map"
    );

    const response =
      await fetch(
        url,
        {
          signal,
          credentials:
            "same-origin",
          headers: {
            Accept:
              "application/json"
          }
        }
      );

    if (!response.ok) {
      throw new Error(
        "Theme Map unavailable"
      );
    }

    const data =
      await response.json();

    if (
      data.status !== "success" ||
      !data.theme_map
    ) {
      throw new Error(
        "Theme Map unavailable"
      );
    }

    if (
      config.theme_id &&
      String(config.theme_id) !==
        String(data.theme_map.theme.id)
    ) {
      throw new Error(
        "Theme changed or map unavailable"
      );
    }

    config.theme_id =
      data.theme_map.theme.id;

    config.schema =
      data.theme_map;

    return data.theme_map;
  }

  function fallbackToNative(query) {
    restoreNativeResults();
    restoreNativePagination();
    hideLoadingMessage();

    const url =
      nativeTarget(query);

    url.searchParams.set(
      "_ai_search_bypass",
      "1"
    );

    location.replace(
      url.pathname +
      url.search
    );
  }

  function buildNativeAiSearchUrl(
  query,
  page = 1
) {
  const url = new URL(
    config.search_url || "/search",
    location.origin
  );

  url.searchParams.set(
    "q",
    String(query || "").trim()
  );

  url.searchParams.set(
    "type",
    "product"
  );

  url.searchParams.set(
    AI_SEARCH_PARAM,
    "1"
  );

  if (
    Number(page) > 1
  ) {
    url.searchParams.set(
      "page",
      String(page)
    );
  }

  return (
    url.pathname +
    url.search
  );
}

  function buildNativeRenderUrl(
    targetIds,
    page = 1
  ) {
    const url =
      new URL(
        config.search_url || "/search",
        location.origin
      );

    url.searchParams.set(
      "q",
      targetIds
    );

    url.searchParams.set(
      "type",
      "product"
    );

    url.searchParams.set(
      "_ai_search_bypass",
      "1"
    );

    if (page > 1) {
      url.searchParams.set(
        "page",
        String(page)
      );
    }

    return (
      url.pathname +
      url.search
    );
  }

  function updateBrowserUrl(
    query,
    page = 1,
    replace = false
  ) {
    const url =
      buildNativeAiSearchUrl(
        query,
        page
      );

    const state = {
      [STATE_KEY]: true,
      query,
      page
    };

    if (replace) {
      window.history.replaceState(
        state,
        "",
        url
      );
    } else {
      window.history.pushState(
        state,
        "",
        url
      );
    }
  }

  function safeQuery(
    root,
    selector
  ) {
    if (
      !root ||
      !selector
    ) {
      return null;
    }

    try {
      return root.querySelector(
        selector
      );
    } catch (error) {
      return null;
    }
  }

  function mappedRoots(
    root,
    map
  ) {
    const ids =
      map.searchTemplateStructure?.[0]?.sectionIds || [];

    const types =
      map.searchSectionTypes || [];

    const sections =
      Array.from(
        root.querySelectorAll(
          '[id^="shopify-section-"]'
        )
      );

    const matched =
      sections.filter(
        (section) =>
          ids.some(
            (id) =>
              section.id.endsWith(
                "__" + id
              ) ||
              section.id ===
                "shopify-section-" + id
          ) ||
          types.some(
            (type) =>
              section.id ===
              "shopify-section-" + type
          )
      );

    return matched.length
      ? matched
      : [
          safeQuery(
            root,
            "main"
          ) || root
        ];
  }

  function findProductGrid(
    root,
    map
  ) {
    for (
      const scope of mappedRoots(
        root,
        map
      )
    ) {
      const grid =
        findProductGridWithin(
          scope,
          map
        );

      if (grid) {
        return grid;
      }
    }

    return null;
  }

  function findProductGridWithin(
    root,
    map
  ) {
    if (
      !root ||
      typeof root.querySelector !==
        "function"
    ) {
      return null;
    }

    if (
      map &&
      map.grid_selector
    ) {
      const mapped =
        safeQuery(
          root,
          map.grid_selector
        );

      if (mapped) {
        return mapped;
      }
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
      "[id*='product-grid']"
    ];

    for (
      const selector of selectors
    ) {
      const element =
        safeQuery(
          root,
          selector
        );

      if (element) {
        return element;
      }
    }

    const links =
      Array.from(
        root.querySelectorAll(
          'a[href*="/products/"]'
        )
      );

    if (
      links.length < 1
    ) {
      return null;
    }

    let bestCandidate =
      null;

    let bestScore =
      0;

    links.forEach((link) => {
      let current =
        link.parentElement;

      let depth =
        0;

      while (
        current &&
        depth < 8
      ) {
        const tag =
          current.tagName
            ? current.tagName.toLowerCase()
            : "";

        if (
          tag === "main" ||
          tag === "body" ||
          current.id === "MainContent"
        ) {
          break;
        }

        const productCount =
          current.querySelectorAll(
            'a[href*="/products/"]'
          ).length;

        if (
          productCount >= 1
        ) {
          const score =
            productCount * 10 -
            depth;

          if (
            score >
            bestScore
          ) {
            bestScore =
              score;

            bestCandidate =
              current;
          }
        }

        current =
          current.parentElement;

        depth++;
      }
    });

    return bestCandidate;
  }

  function hideNativeResults() {
    if (
      !isAiSearchPage()
    ) {
      return null;
    }

    const map =
      getThemeMap();

    const grid =
      findProductGrid(
        document,
        map
      );

    if (!grid) {
      return null;
    }

    grid.dataset.aiSearchV3Hidden =
      "true";

    grid.style.visibility =
      "hidden";

    grid.style.opacity =
      "0";

    grid.setAttribute(
      "aria-hidden",
      "true"
    );

    return grid;
  }

  function showAiResults(
    grid
  ) {
    if (!grid) {
      return;
    }

    grid.style.visibility =
      "";

    grid.style.opacity =
      "";

    grid.removeAttribute(
      "aria-hidden"
    );

    delete grid.dataset
      .aiSearchV3Hidden;

    document.documentElement.classList.remove(
      "ai-search-v3-pending"
    );

    document.documentElement.classList.add(
      "ai-search-v3-ready"
    );
  }

  function restoreNativeResults() {
    document
      .querySelectorAll(
        '[data-ai-search-v3-hidden="true"]'
      )
      .forEach((grid) => {
        grid.style.visibility =
          "";

        grid.style.opacity =
          "";

        grid.removeAttribute(
          "aria-hidden"
        );

        delete grid.dataset
          .aiSearchV3Hidden;
      });

    document.documentElement.classList.remove(
      "ai-search-v3-pending"
    );

    document.documentElement.classList.remove(
      "ai-search-v3-ready"
    );
  }

  function findSearchRoot(
    grid,
    map
  ) {
    if (grid) {
      return (
        grid.closest(
          '[id^="shopify-section-"]'
        ) ||
        grid.closest("main") ||
        grid.parentElement
      );
    }

    return (
      mappedRoots(
        document,
        map
      )[0] || null
    );
  }

  function removeAiPagination() {
    document
      .querySelectorAll(
        ".ai-search-v3-pagination"
      )
      .forEach((element) => {
        element.remove();
      });
  }

  function hideNativePagination(
    root
  ) {
    if (!root) {
      return;
    }

    const selectors = [
      ".pagination",
      ".pagination-wrapper",
      ".main-search__pagination",
      "nav.pagination",
      "[data-pagination]"
    ];

    selectors.forEach(
      (selector) => {
        root
          .querySelectorAll(
            selector
          )
          .forEach((element) => {
            if (
              element.classList.contains(
                "ai-search-v3-pagination"
              )
            ) {
              return;
            }

            element.style.display =
              "none";

            element.dataset.aiSearchHidden =
              "true";
          });
      }
    );
  }

  function restoreNativePagination() {
    document
      .querySelectorAll(
        '[data-ai-search-hidden="true"]'
      )
      .forEach((element) => {
        element.style.display =
          "";

        delete element.dataset
          .aiSearchHidden;
      });
  }

  function updateSearchInputs(
    query
  ) {
    document
      .querySelectorAll(
        'input[name="q"], input[type="search"]'
      )
      .forEach((input) => {
        if (
          document.activeElement !==
          input
        ) {
          input.value =
            query;
        }
      });
  }

  function setLoading(
    isLoading
  ) {
    const map =
      getThemeMap();

    const grid =
      findProductGrid(
        document,
        map
      );

    if (!grid) {
      return;
    }

    if (isLoading) {
      grid.classList.add(
        "ai-search-v3-loading"
      );

      grid.setAttribute(
        "aria-busy",
        "true"
      );
    } else {
      grid.classList.remove(
        "ai-search-v3-loading"
      );

      grid.removeAttribute(
        "aria-busy"
      );
    }
  }

  function showLoadingMessage() {
    let element =
      document.querySelector(
        ".ai-search-v3-status"
      );

    const map =
      getThemeMap();

    const grid =
      findProductGrid(
        document,
        map
      );

    if (!element) {
      element =
        document.createElement(
          "div"
        );

      element.className =
        "ai-search-v3-status";

      element.setAttribute(
        "role",
        "status"
      );

      element.setAttribute(
        "aria-live",
        "polite"
      );

      element.style.display =
        "none";

      if (
        grid &&
        grid.parentElement
      ) {
        grid.parentElement.insertBefore(
          element,
          grid
        );
      }
    }

    if (!element) {
      return;
    }

    element.textContent =
      "Đang tìm kiếm...";

    element.style.display =
      "";
  }

  function hideLoadingMessage() {
    const element =
      document.querySelector(
        ".ai-search-v3-status"
      );

    if (element) {
      element.style.display =
        "none";
    }
  }

  function getVisiblePages(
    totalPages,
    currentPage
  ) {
    const pages =
      new Set();

    pages.add(1);
    pages.add(totalPages);

    for (
      let page =
        currentPage - 2;
      page <=
        currentPage + 2;
      page++
    ) {
      if (
        page >= 1 &&
        page <= totalPages
      ) {
        pages.add(page);
      }
    }

    return Array
      .from(pages)
      .sort(
        (a, b) => a - b
      );
  }

  function createPaginationButton(
    text,
    page,
    options = {}
  ) {
    const button =
      document.createElement(
        "button"
      );

    button.type =
      "button";

    button.className =
      "ai-search-v3-page-btn";

    button.textContent =
      text;

    button.dataset.page =
      String(page);

    if (
      options.current
    ) {
      button.setAttribute(
        "aria-current",
        "page"
      );

      button.disabled =
        true;
    }

    button.addEventListener(
      "click",
      function () {
        if (
          button.disabled
        ) {
          return;
        }

        const query =
          getQueryFromUrl();

        if (!query) {
          return;
        }

        updateBrowserUrl(
          query,
          page,
          false
        );

        hideNativeResults();

        executeAiSearch(
          query,
          page
        );
      }
    );

    return button;
  }

  function createPaginationEllipsis() {
    const element =
      document.createElement(
        "span"
      );

    element.className =
      "ai-search-v3-pagination-ellipsis";

    element.textContent =
      "…";

    return element;
  }

  function renderPagination(
    query,
    pagination,
    targetGrid
  ) {
    removeAiPagination();

    if (!targetGrid) {
      return;
    }

    const totalPages =
      Number(
        pagination?.total_pages || 0
      );

    const currentPage =
      Number(
        pagination?.current_page || 1
      );

    const totalProducts =
      Number(
        pagination?.total_products || 0
      );

    if (
      !Number.isFinite(
        totalPages
      ) ||
      totalPages <= 1
    ) {
      return;
    }

    const nav =
      document.createElement(
        "nav"
      );

    nav.className =
      "ai-search-v3-pagination";

    nav.setAttribute(
      "aria-label",
      "AI Search pagination"
    );

    if (
      currentPage > 1
    ) {
      nav.appendChild(
        createPaginationButton(
          "←",
          currentPage - 1
        )
      );
    }

    const pages =
      getVisiblePages(
        totalPages,
        currentPage
      );

    let previousPage =
      null;

    pages.forEach(
      (page) => {
        if (
          previousPage !== null &&
          page >
            previousPage + 1
        ) {
          nav.appendChild(
            createPaginationEllipsis()
          );
        }

        nav.appendChild(
          createPaginationButton(
            String(page),
            page,
            {
              current:
                page === currentPage
            }
          )
        );

        previousPage =
          page;
      }
    );

    if (
      currentPage <
      totalPages
    ) {
      nav.appendChild(
        createPaginationButton(
          "→",
          currentPage + 1
        )
      );
    }

    if (
      totalProducts > 0
    ) {
      const info =
        document.createElement(
          "span"
        );

      info.className =
        "ai-search-v3-pagination-info";

      info.textContent =
        `${totalProducts} sản phẩm`;

      nav.appendChild(
        info
      );
    }

    if (
      targetGrid.parentElement
    ) {
      targetGrid.parentElement.insertBefore(
        nav,
        targetGrid.nextSibling
      );
    }
  }

  function normalizeTargetIds(
    targetIds
  ) {
    if (
      Array.isArray(targetIds)
    ) {
      return targetIds
        .filter(Boolean)
        .map(
          (id) =>
            String(id).trim()
        )
        .filter(Boolean)
        .join(" OR ");
    }

    return String(
      targetIds || ""
    ).trim();
  }

  async function fetchAiResults(
    query,
    page,
    signal
  ) {
    const url =
      buildAiBackendUrl(
        query,
        page
      );

    const response =
      await fetch(
        url,
        {
          method: "GET",
          credentials:
            "same-origin",
          signal,
          headers: {
            Accept:
              "application/json"
          }
        }
      );

    if (
      !response.ok
    ) {
      throw new Error(
        `AI Search HTTP ${response.status}`
      );
    }

    const data =
      await response.json();

    if (
      !data ||
      data.status !== "success"
    ) {
      throw new Error(
        data?.message ||
        "AI Search backend error"
      );
    }

    return data;
  }

  async function fetchNativeSearchHtml(
    targetIds,
    signal,
    page = 1
  ) {
    const response =
      await fetch(
        buildNativeRenderUrl(
          targetIds,
          page
        ),
        {
          signal,
          credentials:
            "same-origin",
          headers: {
            Accept:
              "text/html"
          }
        }
      );

    if (!response.ok) {
      throw new Error(
        "Shopify native search HTTP " +
        response.status
      );
    }

    return response.text();
  }

  function parseHtmlDocument(
    html
  ) {
    const parser =
      new DOMParser();

    return parser.parseFromString(
      html,
      "text/html"
    );
  }

  function replaceProductGrid(
    currentGrid,
    newGrid
  ) {
    if (
      !currentGrid ||
      !newGrid
    ) {
      return false;
    }

    const fragment =
      document.createDocumentFragment();

    Array
      .from(
        newGrid.childNodes
      )
      .forEach((node) => {
        fragment.appendChild(
          document.importNode(
            node,
            true
          )
        );
      });

    currentGrid.replaceChildren(
      fragment
    );

    return true;
  }

  function activateImages(
    container
  ) {
    if (!container) {
      return;
    }

    container
      .querySelectorAll(
        "img"
      )
      .forEach((img) => {
        const dataSrc =
          img.dataset.src;

        const dataSrcset =
          img.dataset.srcset;

        if (
          dataSrc &&
          !img.getAttribute(
            "src"
          )
        ) {
          img.src =
            dataSrc;
        }

        if (
          dataSrcset &&
          !img.getAttribute(
            "srcset"
          )
        ) {
          img.srcset =
            dataSrcset;
        }

        img.removeAttribute(
          "loading"
        );
      });
  }

  function dispatchSearchUpdated(
    detail
  ) {
    document.dispatchEvent(
      new CustomEvent(
        "ai-search:v3:updated",
        {
          detail
        }
      )
    );
  }

  function cardHandle(
    node,
    expected
  ) {
    const handles =
      new Set();

    const links =
      Array.from(
        node.querySelectorAll(
          'a[href*="/products/"]'
        )
      );

    if (
      node.matches?.(
        'a[href*="/products/"]'
      )
    ) {
      links.unshift(node);
    }

    for (
      const link of links
    ) {
      try {
        const url =
          new URL(
            link.getAttribute("href"),
            location.origin
          );

        const handle =
          decodeURIComponent(
            url.pathname.match(
              /\/products\/([^/]+)/
            )?.[1] || ""
          );

        if (
          expected.has(handle)
        ) {
          handles.add(handle);
        }
      } catch {
        /* Invalid product links are not rank evidence. */
      }
    }

    return handles.size === 1
      ? [...handles][0]
      : null;
  }

  async function collectRankedGrid(
    data,
    map,
    signal
  ) {
    const expected =
      new Set(
        data.products.map(
          (product) =>
            product.handle
        )
      );

    if (
      !expected.size ||
      expected.size !==
        data.products.length
    ) {
      throw new Error(
        "Invalid ranked handles"
      );
    }

    const cards =
      new Map();

    let firstGrid =
      null;

    let firstDocument =
      null;

    for (
      let page = 1;
      page <= 20 &&
      cards.size < expected.size;
      page += 1
    ) {
      const doc =
        parseHtmlDocument(
          await fetchNativeSearchHtml(
            normalizeTargetIds(
              data.target_ids
            ),
            signal,
            page
          )
        );

      const themeId =
        doc.querySelector(
          'meta[name="ai-search-theme-id"]'
        )?.content;

      if (
        String(themeId) !==
        String(data.theme_id)
      ) {
        throw new Error(
          "Native HTML belongs to another theme"
        );
      }

      const grid =
        findProductGrid(
          doc,
          map
        );

      if (
        !grid ||
        /Liquid (?:error|syntax error)/i.test(
          grid.textContent
        )
      ) {
        throw new Error(
          "Native product grid unavailable"
        );
      }

      firstGrid ||= grid;
      firstDocument ||= doc;

      const before =
        cards.size;

      for (
        const child of Array.from(
          grid.children
        )
      ) {
        const handle =
          cardHandle(
            child,
            expected
          );

        if (
          handle &&
          !cards.has(handle)
        ) {
          cards.set(
            handle,
            child
          );
        }
      }

      if (
        cards.size === before
      ) {
        break;
      }
    }

    if (
      cards.size !==
      expected.size
    ) {
      throw new Error(
        "Native search did not render every ranked product"
      );
    }

    const companions =
      Array.from(
        firstGrid.children
      ).filter(
        (node) =>
          node.matches(
            "style,script,link"
          )
      );

    firstGrid.replaceChildren(
      ...companions,
      ...data.products.map(
        (product) =>
          cards.get(
            product.handle
          )
      )
    );

    return {
      grid:
        firstGrid,
      doc:
        firstDocument
    };
  }

  async function loadNativeAssets(
    root,
    signal
  ) {
    const existing =
      new Set(
        Array.from(
          document.querySelectorAll(
            'script[src],link[rel="stylesheet"]'
          )
        ).map(
          (node) =>
            node.src ||
            node.href
        )
      );

    for (
      const node of root.querySelectorAll(
        'script[src],link[rel="stylesheet"]'
      )
    ) {
      const url =
        new URL(
          node.getAttribute("src") ||
          node.getAttribute("href"),
          location.origin
        );

      if (
        existing.has(
          url.href
        )
      ) {
        continue;
      }

      if (
        url.origin !==
          location.origin &&
        url.hostname !==
          "cdn.shopify.com"
      ) {
        continue;
      }

      if (
        signal.aborted
      ) {
        throw new DOMException(
          "Aborted",
          "AbortError"
        );
      }

      const copy =
        document.createElement(
          node.tagName.toLowerCase()
        );

      for (
        const attr of node.attributes
      ) {
        copy.setAttribute(
          attr.name,
          attr.value
        );
      }

      await new Promise(
        (
          resolve,
          reject
        ) => {
          const timer =
            setTimeout(
              () =>
                reject(
                  new Error(
                    "Theme asset timeout"
                  )
                ),
              10000
            );

          copy.onload =
            () => {
              clearTimeout(
                timer
              );

              resolve();
            };

          copy.onerror =
            () => {
              clearTimeout(
                timer
              );

              reject(
                new Error(
                  "Theme asset failed"
                )
              );
            };

          document.head.appendChild(
            copy
          );
        }
      );

      existing.add(
        url.href
      );
    }
  }

  async function executeAiSearch(
    rawQuery,
    rawPage = 1
  ) {
    const query =
      String(
        rawQuery || ""
      ).trim();

    if (
      !query ||
      query.includes("id:")
    ) {
      return;
    }

    const pageRaw =
      Number.parseInt(
        String(rawPage),
        10
      );

    const page =
      Number.isSafeInteger(
        pageRaw
      ) &&
      pageRaw > 0
        ? pageRaw
        : 1;

    const policyUrl =
      nativeTarget(query);

    policyUrl.searchParams.set(
      "page",
      String(page)
    );

    if (
      !shouldUseAi(
        policyUrl
      )
    ) {
      fallbackToNative(query);
      return;
    }

    activeController?.abort();

    const controller =
      new AbortController();

    activeController =
      controller;

    const requestId =
      ++activeRequestId;

    const timer =
      setTimeout(
        () =>
          controller.abort(),
        30000
      );

    const signal =
      controller.signal;

    try {
      // Giữ Theme Map lifecycle của V3.
      // Render sử dụng cơ chế đã chứng minh của V2:
      //
      // AI target_ids
      // → Shopify Native HTML
      // → findProductGrid()
      // → replace Product Grid

      const schema =
        await ensureThemeMap(
          query,
          signal
        );

      if (
        requestId !==
        activeRequestId
      ) {
        return;
      }

      const map =
        schema.search ||
        getThemeMap() ||
        {};

      const currentGrid =
        hideNativeResults() ||
        findProductGrid(
          document,
          map
        );

      if (!currentGrid) {
        throw new Error(
          "Current Product Grid not found"
        );
      }

      setLoading(true);
      showLoadingMessage();

      const data =
        await fetchAiResults(
          query,
          page,
          signal
        );

      if (
        requestId !==
        activeRequestId
      ) {
        return;
      }

      const targetIds =
        normalizeTargetIds(
          data.target_ids
        );

      if (!targetIds) {
        throw new Error(
          "AI Search did not return target_ids"
        );
      }

      const html =
        await fetchNativeSearchHtml(
          targetIds,
          signal
        );

      if (
        requestId !==
        activeRequestId
      ) {
        return;
      }

      const nativeDocument =
        parseHtmlDocument(
          html
        );

      const nativeGrid =
        findProductGrid(
          nativeDocument,
          map
        );

      if (!nativeGrid) {
        throw new Error(
          "Product Grid not found in Shopify native HTML"
        );
      }

      const liveGrid =
        findProductGrid(
          document,
          map
        );

      if (!liveGrid) {
        throw new Error(
          "Live Product Grid not found"
        );
      }

      if (
        !replaceProductGrid(
          liveGrid,
          nativeGrid
        )
      ) {
        throw new Error(
          "Unable to replace Product Grid"
        );
      }

      activateImages(
        liveGrid
      );

      hideNativePagination(
        findSearchRoot(
          liveGrid,
          map
        )
      );

      renderPagination(
        query,
        data.pagination || {},
        liveGrid
      );

      updateSearchInputs(
        query
      );

      updateBrowserUrl(
        query,
        page,
        true
      );

      showAiResults(
        liveGrid
      );

      dispatchSearchUpdated({
        query,
        page,
        pagination:
          data.pagination || {},
        targetIds,
        products:
          data.products || []
      });

      console.log(
        "[AI SEARCH V3] Search rendered with V2 native render flow",
        {
          query,
          page,
          pagination:
            data.pagination,
          targetIds
        }
      );
    } catch (error) {
      if (
        requestId !==
          activeRequestId ||
        error?.name ===
          "AbortError"
      ) {
        return;
      }

      console.error(
        "[AI SEARCH V3] Search error:",
        error
      );

      showAiResults(
        findProductGrid(
          document,
          getThemeMap()
        )
      );

      fallbackToNative(
        query
      );
    } finally {
      clearTimeout(
        timer
      );

      if (
        requestId ===
        activeRequestId
      ) {
        setLoading(false);
        hideLoadingMessage();
      }
    }
  }

  function submitAiSearch(
    rawQuery
  ) {
    const query =
      String(
        rawQuery || ""
      ).trim();

    if (!query) {
      return;
    }

    const target =
      nativeTarget(query);

    // Giữ chính sách V3:
    // Không phải search nào cũng bắt buộc dùng AI.

    if (
      !shouldUseAi(
        target
      )
    ) {
      window.location.assign(
        target.pathname +
        target.search
      );

      return;
    }

    window.location.assign(
      buildNativeAiSearchUrl(
        query,
        1
      )
    );
  }

  function stopSearchEvent(
    event
  ) {
    event.preventDefault();
    event.stopPropagation();

    if (
      typeof event.stopImmediatePropagation ===
      "function"
    ) {
      event.stopImmediatePropagation();
    }
  }

  function installSearchInterception() {
    if (
      interceptionInstalled
    ) {
      return;
    }

    interceptionInstalled =
      true;

    /*
     * Kế thừa phương pháp V2:
     *
     * Không chỉ dựa vào form.action.
     *
     * Tìm trực tiếp input search để bắt được
     * cả Search Form ở Homepage và các Theme
     * có form.action không chuẩn.
     */

    function findSearchInput(
      form
    ) {
      if (
        !(form instanceof HTMLFormElement)
      ) {
        return null;
      }

      return form.querySelector(
        'input[name="q"], input[type="search"], textarea[name="q"]'
      );
    }

    function isSearchForm(
      form,
      input
    ) {
      if (!input) {
        return false;
      }

      const action =
        (
          form.getAttribute(
            "action"
          ) || ""
        ).trim();

      if (action) {
        const actionUrl =
          new URL(
            action,
            location.origin
          );

        if (
          isNativeSearchPath(
            actionUrl.pathname
          )
        ) {
          return true;
        }
      }

      /*
       * Fallback rộng như V2.
       */

      return (
        /search/i.test(
          String(
            form.className || ""
          )
        ) ||
        form.hasAttribute(
          "data-search-form"
        ) ||
        form.hasAttribute(
          "data-predictive-search"
        ) ||
        input.name === "q"
      );
    }

    window.addEventListener(
      "submit",
      (event) => {
        const form =
          event.target;

        if (
          !(
            form instanceof
            HTMLFormElement
          ) ||
          form.method.toLowerCase() !==
            "get"
        ) {
          return;
        }

        const input =
          findSearchInput(
            form
          );

        if (
          !isSearchForm(
            form,
            input
          )
        ) {
          return;
        }

        /*
         * Luôn tạo URL Shopify chuẩn.
         *
         * Điều này xử lý Homepage Search
         * khi form.action trống hoặc
         * không phải /search.
         */

        const target =
          new URL(
            config.search_url ||
              "/search",
            location.origin
          );

        const fields =
          new FormData(
            form,
            event.submitter ||
              undefined
          );

        for (
          const [
            key,
            value
          ] of fields
        ) {
          if (
            typeof value !==
              "string" ||
            key ===
              AI_SEARCH_PARAM ||
            key ===
              NATIVE_BYPASS_PARAM
          ) {
            continue;
          }

          target.searchParams.append(
            key,
            value
          );
        }

        if (
          !target.searchParams.get(
            "q"
          )
        ) {
          target.searchParams.set(
            "q",
            input.value || ""
          );
        }

        normalizeProductOnlyType(
          target
        );

        /*
         * QUYẾT ĐỊNH AI HAY SHOPIFY NATIVE
         */

        if (
          !shouldUseAi(
            target
          )
        ) {
          /*
           * Trường hợp cần Shopify Search mặc định.
           */

          stopSearchEvent(
            event
          );

          location.assign(
            target.pathname +
            target.search
          );

          return;
        }

        /*
         * AI Search.
         */

        stopSearchEvent(
          event
        );

        target.searchParams.set(
          "ai_search",
          "1"
        );

        location.assign(
          target.pathname +
          target.search
        );
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
        ) {
          return;
        }

        const link =
          event.target?.closest?.(
            "a[href]"
          );

        if (
          !link ||
          link.download ||
          (
            link.target &&
            link.target !== "_self"
          )
        ) {
          return;
        }

        const target =
          new URL(
            link.href,
            location.origin
          );

        if (
          target.origin !==
            location.origin ||
          !isNativeSearchPath(
            target.pathname
          )
        ) {
          return;
        }

        const marked =
          target.searchParams.has(
            "ai_search"
          );

        target.searchParams.delete(
          "ai_search"
        );

        if (
          shouldUseAi(
            target
          )
        ) {
          stopSearchEvent(
            event
          );

          target.searchParams.set(
            "ai_search",
            "1"
          );

          location.assign(
            target.pathname +
            target.search
          );
        } else if (
          marked
        ) {
          stopSearchEvent(
            event
          );

          target.searchParams.set(
            "_ai_search_bypass",
            "1"
          );

          location.assign(
            target.pathname +
            target.search
          );
        }
      },
      true
    );
  }

  function initOnPageLoad() {
    if (
      !isNativeSearchPage()
    ) {
      return;
    }

    const url =
      new URL(
        location.href
      );

    if (
      url.searchParams.get(
        NATIVE_BYPASS_PARAM
      ) === "1"
    ) {
      url.searchParams.delete(
        NATIVE_BYPASS_PARAM
      );

      url.searchParams.delete(
        AI_SEARCH_PARAM
      );

      history.replaceState(
        history.state,
        "",
        url.pathname +
        url.search
      );

      return;
    }

    const query =
      (
        url.searchParams.get(
          "q"
        ) || ""
      ).trim();

    if (
      !query ||
      query.includes("id:")
    ) {
      return;
    }

    /*
     * Quy tắc V2:
     * Chỉ chạy AI khi URL được đánh dấu ai_search=1.
     */

    if (
      url.searchParams.get(
        AI_SEARCH_PARAM
      ) !== "1"
    ) {
      return;
    }

    hideNativeResults();

    executeAiSearch(
      query,
      getPageFromUrl()
    );
  }

  function handlePopState() {
    activeController?.abort();

    activeRequestId += 1;

    if (
      !isAiSearchPage()
    ) {
      location.reload();
      return;
    }

    executeAiSearch(
      getQueryFromUrl(),
      getPageFromUrl()
    );
  }

  window.addEventListener(
    "popstate",
    handlePopState
  );

  window.AI_SEARCH_V3 = {
    search:
      submitAiSearch,

    executeAiSearch,

    getThemeMap,

    findProductGrid,

    getQuery:
      getQueryFromUrl,

    getPage:
      getPageFromUrl
  };

  installSearchInterception();

  if (
    document.readyState ===
    "loading"
  ) {
    document.addEventListener(
      "DOMContentLoaded",
      initOnPageLoad,
      {
        once: true
      }
    );
  } else {
    initOnPageLoad();
  }
})();