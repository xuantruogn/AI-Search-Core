(function () {
  "use strict";

  if (window.__aiSearchV4Installed) return;
  window.__aiSearchV4Installed = true;

  const config = window.AI_SEARCH_CONFIG || {};
  const endpoint = config.search_endpoint || "/apps/ai-search";
  const clickEndpoint = endpoint.replace(/\/+$/, "") + "/click";
  const stateKey = "aiSearchV4";
  const receiptPattern = /^srch_[A-Za-z0-9_-]+$/;
  const logPrefix = "[AI SEARCH V4]";

  let controller = null;
  let requestNumber = 0;
  let activeSearchLogId = null;
  let activeProducts = [];

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
          background: Canvas;
          color: CanvasText;
          opacity: 0.94;
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
      loading.innerHTML = '<span data-ai-search-v4-spinner aria-hidden="true"></span>';

      (document.body || document.documentElement).appendChild(loading);
    }

    return loading;
  }

  function showLoading() {
    const loading = ensureLoadingUi();
    loading.dataset.active = "true";
    document.documentElement.setAttribute("aria-busy", "true");
  }

  function hideLoading() {
    const loading = document.querySelector("[data-ai-search-v4-loading]");

    if (loading) {
      loading.dataset.active = "false";
    }

    document.documentElement.removeAttribute("aria-busy");
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
    };

    history[replace ? "replaceState" : "pushState"](
      state,
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

    return mount;
  }

  function activateRuntime(mount, metadata) {
    mount
      .querySelectorAll("img[data-src]")
      .forEach(function (image) {
        if (!image.getAttribute("src")) {
          image.src = image.dataset.src;
        }
      });

    document.documentElement.dataset.aiSearchV4Receipt = metadata.receipt || "";
    document.documentElement.dataset.aiSearchV4Page = String(metadata.page || 1);

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
        throw new Error(`THEME_RENDER_HTTP_${response.status}`);
      }

      const html = await response.text();
      const template = document.createElement("template");
      template.innerHTML = html;

      const metadata = decodeMetadata(response, template);

      try {
        const mount = verifyMount(metadata, receipt);

        mount.replaceChildren(template.content);

        activeProducts = Array.isArray(metadata.products)
          ? metadata.products
          : [];

        activateRuntime(mount, metadata);

        return {
          mount,
          metadata,
        };
      } catch (error) {
        rejected.add(metadata.candidateId);

        candidateId = (metadata.candidateIds || []).find(
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
    const raw = String(value || "").trim();

    if (!raw) {
      return "";
    }

    if (/^gid:\/\/shopify\/Product\/\d+$/.test(raw)) {
      return raw;
    }

    if (/^\d+$/.test(raw)) {
      return `gid://shopify/Product/${raw}`;
    }

    return "";
  }

  function validateRenderedMount(root, mountRecipe) {
    if (!mountRecipe?.selector) {
      throw new Error("THEME_CONTEXT_MOUNT_MISSING");
    }

    let matches;

    try {
      matches = root.querySelectorAll(mountRecipe.selector);
    } catch {
      throw new Error("THEME_CONTEXT_MOUNT_SELECTOR_INVALID");
    }

    if (matches.length !== 1) {
      throw new Error("THEME_CONTEXT_RENDERED_MOUNT_NOT_UNIQUE");
    }

    const mount = matches[0];
    const expectedTag = mountRecipe.verification?.expectedTag;

    if (
      expectedTag &&
      mount.tagName.toLowerCase() !== String(expectedTag).toLowerCase()
    ) {
      throw new Error("THEME_CONTEXT_RENDERED_MOUNT_TAG_MISMATCH");
    }

    return mount;
  }

  function getSectionIdForMount(mount) {
    const wrapper = mount.closest('[id^="shopify-section-"]');

    if (!wrapper?.id) {
      throw new Error("THEME_CONTEXT_SECTION_WRAPPER_NOT_FOUND");
    }

    const sectionId = wrapper.id.replace(/^shopify-section-/, "").trim();

    if (!sectionId) {
      throw new Error("THEME_CONTEXT_SECTION_ID_INVALID");
    }

    return sectionId;
  }

  async function fetchTransportPlan(receipt, page, signal) {
    const requestUrl = transportUrl(receipt, page);

    console.info(logPrefix, "fetchTransportPlan", {
      receipt,
      page,
      url: requestUrl,
    });

    const response = await fetch(requestUrl, {
      credentials: "same-origin",
      signal,
      headers: {
        Accept: "application/json",
      },
    });

    let data = null;

    try {
      data = await response.json();
    } catch {
      data = null;
    }

    // Classic snippet themes do not have a THEME_CONTEXT_REQUIRED candidate.
    // In that case preserve the existing App Proxy Liquid renderer path.
    if (
      response.status === 409 &&
      data?.reason === "THEME_CONTEXT_TRANSPORT_CANDIDATE_NOT_FOUND"
    ) {
      return null;
    }

    if (!response.ok) {
      if (
        response.status === 410 ||
        data?.reason === "SEARCH_RECEIPT_EXPIRED_OR_INVALID"
      ) {
        throw new Error("THEME_RENDER_HTTP_410");
      }

      if (
        response.status === 400 &&
        data?.reason === "INVALID_SEARCH_RECEIPT"
      ) {
        throw new Error("SEARCH_RECEIPT_INVALID");
      }

      throw new Error(
        data?.reason || `THEME_TRANSPORT_HTTP_${response.status}`,
      );
    }

    if (
      data?.status !== "success" ||
      data?.render_strategy !== "THEME_CONTEXT_REQUIRED" ||
      data?.safeToRender !== true
    ) {
      throw new Error(data?.reason || "THEME_TRANSPORT_PLAN_INVALID");
    }

    if (
      !data.mount?.selector ||
      !Array.isArray(data.targetProductIds) ||
      data.targetProductIds.length === 0 ||
      !Array.isArray(data.batches) ||
      data.batches.length === 0
    ) {
      throw new Error("THEME_TRANSPORT_PLAN_INVALID");
    }

    return data;
  }

  async function fetchThemeContextBatch({
    batch,
    sectionId,
    mountRecipe,
    signal,
  }) {
    const url = new URL(config.search_url || "/search", location.origin);

    url.searchParams.set("q", batch.query);
    url.searchParams.set("type", "product");
    url.searchParams.set("sections", sectionId);
    url.searchParams.delete("page");
    url.searchParams.delete("_ai_search_bypass");

    const response = await fetch(url.pathname + url.search, {
      credentials: "same-origin",
      signal,
      headers: {
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      throw new Error(`THEME_CONTEXT_SECTION_HTTP_${response.status}`);
    }

    const payload = await response.json();
    const html = payload?.[sectionId];

    if (typeof html !== "string" || !html.trim()) {
      throw new Error("THEME_CONTEXT_SECTION_HTML_MISSING");
    }

    const template = document.createElement("template");
    template.innerHTML = html;

    const renderedMount = validateRenderedMount(
      template.content,
      mountRecipe,
    );

    const cards = new Map();

    for (const child of Array.from(renderedMount.children)) {
      const productId = normalizeProductGid(
        child.getAttribute("data-product-id"),
      );

      if (!productId) {
        continue;
      }

      if (cards.has(productId)) {
        throw new Error("THEME_CONTEXT_DUPLICATE_PRODUCT_CARD");
      }

      cards.set(productId, child);
    }

    const expectedIds = Array.from(
      new Set(
        (batch.productIds || [])
          .map(normalizeProductGid)
          .filter(Boolean),
      ),
    );

    const selectedCards = new Map();

    for (const productId of expectedIds) {
      const card = cards.get(productId);

      if (!card) {
        throw new Error(`THEME_CONTEXT_TARGET_MISSING:${productId}`);
      }

      selectedCards.set(productId, card);
    }

    console.info(logPrefix, "section batch rendered", {
      sectionId,
      expectedCount: expectedIds.length,
      renderedDirectCards: cards.size,
      discardedExtras: Math.max(0, cards.size - selectedCards.size),
      encodedQueryLength: batch.encodedQueryLength,
    });

    return selectedCards;
  }

  function productHandleFromCard(card) {
    const anchor = card.querySelector('a[href*="/products/"]');

    if (!anchor) {
      return "";
    }

    try {
      return (
        new URL(anchor.href, location.origin)
          .pathname
          .match(/\/products\/([^/?#]+)/)?.[1] || ""
      );
    } catch {
      return "";
    }
  }

  async function renderThemeContext(receipt, page, plan, signal) {
    const metadata = {
      version: 4,
      themeId: plan.theme_id,
      fingerprint: plan.map_fingerprint,
      receipt: plan.receipt || receipt,
      searchLogId: plan.search_log_id || null,
      page: Number(plan.pagination?.current_page || page),
      pageSize: Number(plan.pagination?.page_size || 20),
      totalProducts: Number(plan.pagination?.total_products || 0),
      totalPages: Number(plan.pagination?.total_pages || 0),
      candidateId: plan.candidate?.id || null,
      runtimeMode: "THEME_CONTEXT",
      mount: plan.mount,
      candidateIds: plan.candidate?.id ? [plan.candidate.id] : [],
      products: [],
    };

    if (metadata.receipt !== receipt) {
      throw new Error("THEME_CONTEXT_RECEIPT_MISMATCH");
    }

    const mount = verifyMount(metadata, receipt);
    const sectionId = getSectionIdForMount(mount);

    const targetProductIds = plan.targetProductIds.map(normalizeProductGid);

    if (
      targetProductIds.some((productId) => !productId) ||
      new Set(targetProductIds).size !== targetProductIds.length
    ) {
      throw new Error("THEME_CONTEXT_TARGET_IDS_INVALID");
    }

    const batchMaps = await Promise.all(
      plan.batches.map(function (batch) {
        return fetchThemeContextBatch({
          batch,
          sectionId,
          mountRecipe: plan.mount,
          signal,
        });
      }),
    );

    const cardsByProductId = new Map();

    for (const batchCards of batchMaps) {
      for (const [productId, card] of batchCards) {
        if (cardsByProductId.has(productId)) {
          throw new Error("THEME_CONTEXT_DUPLICATE_TARGET_ACROSS_BATCHES");
        }

        cardsByProductId.set(productId, card);
      }
    }

    const orderedCards = targetProductIds.map(function (productId) {
      const card = cardsByProductId.get(productId);

      if (!card) {
        throw new Error(`THEME_CONTEXT_TARGET_MISSING:${productId}`);
      }

      if (card.hasAttribute("data-page")) {
        card.setAttribute("data-page", String(metadata.page));
      }

      return card;
    });

    if (mount.hasAttribute("data-last-page")) {
      mount.setAttribute("data-last-page", String(metadata.totalPages));
    }

    mount.replaceChildren(...orderedCards);

    activeProducts = orderedCards.map(function (card, index) {
      return {
        productId: targetProductIds[index],
        handle: productHandleFromCard(card),
      };
    });

    metadata.products = activeProducts;

    activateRuntime(mount, metadata);

    console.info(logPrefix, "theme-context render complete", {
      receipt,
      page: metadata.page,
      sectionId,
      targetCount: targetProductIds.length,
      batchCount: plan.batches.length,
      mountSelector: plan.mount.selector,
    });

    return {
      mount,
      metadata,
    };
  }

  async function renderReceipt(receipt, page, signal) {
    const transportPlan = await fetchTransportPlan(
      receipt,
      page,
      signal,
    );

    if (transportPlan) {
      return renderThemeContext(
        receipt,
        page,
        transportPlan,
        signal,
      );
    }

    return renderAppProxy(receipt, page, signal);
  }

  function updateResultCount(mount, metadata) {
    const totalProducts = Number(metadata.totalProducts);

    if (!Number.isSafeInteger(totalProducts) || totalProducts < 0) {
      return;
    }

    const scopes = [
      mount.closest("section"),
      mount.closest('[id^="shopify-section-"]'),
      mount.closest("main"),
    ].filter(Boolean);

    let statusElement = null;

    for (const scope of scopes) {
      const candidates = Array.from(
        scope.querySelectorAll('[role="status"]'),
      ).filter(function (element) {
        if (mount.contains(element)) return false;
        if (element.getAttribute("aria-hidden") === "true") return false;
        if (!(element.textContent || "").trim()) return false;
        return true;
      });

      if (candidates.length === 1) {
        statusElement = candidates[0];
        break;
      }
    }

    if (!statusElement) {
      console.info(logPrefix, "resultCount skipped", {
        reason: "RESULT_COUNT_STATUS_NOT_UNIQUE",
        totalProducts,
      });
      return;
    }

    const currentText = statusElement.textContent || "";
    const countToken = currentText.match(
      /\d(?:[\d.,\u00A0\u202F ]*\d)?/,
    );

    if (!countToken || typeof countToken.index !== "number") {
      console.info(logPrefix, "resultCount skipped", {
        reason: "RESULT_COUNT_NUMBER_NOT_FOUND",
        totalProducts,
        currentText,
      });
      return;
    }

    statusElement.textContent =
      currentText.slice(0, countToken.index) +
      String(totalProducts) +
      currentText.slice(countToken.index + countToken[0].length);

    console.info(logPrefix, "resultCount updated", {
      totalProducts,
      previousText: currentText,
      updatedText: statusElement.textContent,
    });
  }

  function removePagination() {
    document.querySelector("[data-ai-search-v4-pagination]")?.remove();
  }

  function paginationButton(label, page, current, onPage) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.disabled = current;

    if (current) {
      button.setAttribute("aria-current", "page");
    }

    button.addEventListener("click", function () {
      onPage(page);
    });

    return button;
  }

  function mountPagination(mount, metadata, onPage) {
    removePagination();

    if (metadata.totalPages <= 1) {
      return;
    }

    const nav = document.createElement("nav");
    nav.dataset.aiSearchV4Pagination = "";
    nav.setAttribute("aria-label", "Search result pages");

    if (metadata.page > 1) {
      nav.appendChild(
        paginationButton("←", metadata.page - 1, false, onPage),
      );
    }

    const first = Math.max(1, metadata.page - 2);
    const last = Math.min(metadata.totalPages, metadata.page + 2);

    for (let page = first; page <= last; page += 1) {
      nav.appendChild(
        paginationButton(
          String(page),
          page,
          page === metadata.page,
          onPage,
        ),
      );
    }

    if (metadata.page < metadata.totalPages) {
      nav.appendChild(
        paginationButton("→", metadata.page + 1, false, onPage),
      );
    }

    mount.insertAdjacentElement("afterend", nav);
  }

  function isRecoverableReceiptError(error) {
    const message = error instanceof Error ? error.message : String(error);

    return (
      message === "THEME_RENDER_HTTP_404" ||
      message === "THEME_RENDER_HTTP_410" ||
      message === "THEME_TRANSPORT_HTTP_410" ||
      message === "SEARCH_RECEIPT_EXPIRED_OR_INVALID" ||
      message === "SEARCH_RECEIPT_INVALID" ||
      message === "SEARCH_RECEIPT_REQUIRED"
    );
  }

  async function fetchFreshReceipt(query, signal) {
    const requestUrl = backendUrl(query);

    console.info(logPrefix, "fetchAiResults", {
      query,
      page: 1,
      url: requestUrl,
    });

    const response = await fetch(requestUrl, {
      credentials: "same-origin",
      signal,
      headers: {
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      throw new Error(`AI_SEARCH_HTTP_${response.status}`);
    }

    const data = await response.json();

    if (data.status !== "success") {
      console.warn(logPrefix, "backend fallback response", {
        status: data.status,
        reason: data.reason || "AI_SEARCH_FAILED",
        nativeUrl: data.native_url || null,
      });

      throw new Error(data.reason || "AI_SEARCH_FAILED");
    }

    const receipt = data.render_receipt?.id || "";

    if (!receiptPattern.test(receipt)) {
      throw new Error("SEARCH_RECEIPT_INVALID");
    }

    if (data.theme_id) {
      config.theme_id =
        String(data.theme_id);
    }

    if (data.map_fingerprint) {
      config.map_fingerprint =
        String(data.map_fingerprint);
    }

    return {
      receipt,
      searchLogId: data.search_log_id || null,
      themeId: data.theme_id || null,
      fingerprint: data.map_fingerprint || null,
    };
  }

  async function execute(query, page, receipt, replaceUrl) {
    controller?.abort();
    controller = new AbortController();

    const signal = controller.signal;
    const requestId = ++requestNumber;

    showLoading();

    try {
      let activeReceipt = receipt;
      let renderPage = page;
      let usedExistingReceipt = Boolean(activeReceipt);

      if (!activeReceipt) {
        const fresh = await fetchFreshReceipt(query, signal);
        activeReceipt = fresh.receipt;
        activeSearchLogId = fresh.searchLogId;
        usedExistingReceipt = false;
      }

      let rendered;

      try {
        rendered = await renderReceipt(activeReceipt, renderPage, signal);
      } catch (error) {
        if (!usedExistingReceipt || !isRecoverableReceiptError(error)) {
          throw error;
        }

        console.info(logPrefix, "receipt expired; refreshing search", {
          query,
          page: renderPage,
          receipt: activeReceipt,
          reason: error instanceof Error ? error.message : String(error),
        });

        const fresh = await fetchFreshReceipt(query, signal);
        activeReceipt = fresh.receipt;
        activeSearchLogId = fresh.searchLogId;
        usedExistingReceipt = false;

        rendered = await renderReceipt(activeReceipt, renderPage, signal);
      }

      if (requestId !== requestNumber) {
        return;
      }

      activeSearchLogId =
        rendered.metadata.searchLogId || activeSearchLogId;

      writeUrl({
        query,
        page: rendered.metadata.page,
        receipt: activeReceipt,
        replace: replaceUrl,
        searchLogId: activeSearchLogId,
        fingerprint: rendered.metadata.fingerprint,
        themeId: rendered.metadata.themeId,
      });

      updateResultCount(rendered.mount, rendered.metadata);

      mountPagination(
        rendered.mount,
        rendered.metadata,
        function (nextPage) {
          writeUrl({
            query,
            page: nextPage,
            receipt: activeReceipt,
            replace: false,
            searchLogId: activeSearchLogId,
            fingerprint: rendered.metadata.fingerprint,
            themeId: rendered.metadata.themeId,
          });

          void execute(query, nextPage, activeReceipt, true);
        },
      );

      document.dispatchEvent(
        new CustomEvent("ai-search:v3:updated", {
          detail: {
            query,
            page: rendered.metadata.page,
            engine: "ai-search-v4",
            renderReceipt: activeReceipt,
            pagination: {
              current_page: rendered.metadata.page,
              page_size: rendered.metadata.pageSize,
              total_products: rendered.metadata.totalProducts,
              total_pages: rendered.metadata.totalPages,
            },
            searchLogId: activeSearchLogId,
          },
        }),
      );
    } catch (error) {
      if (
        error?.name !== "AbortError" &&
        requestId === requestNumber
      ) {
        console.error(logPrefix, "executeAiSearch failed", {
          query,
          page,
          receipt: receipt || null,
          reason: error instanceof Error ? error.message : String(error),
        });

        fallback(query);
      }
    } finally {
      if (requestId === requestNumber) {
        hideLoading();
      }
    }
  }

  function runCurrentSearchEntry(replaceUrl) {
    const current = publicState();

    if (
      !current.isSearchPage ||
      current.bypass ||
      !current.query
    ) {
      hideLoading();
      return;
    }

    const runtime = runtimeStateFor(current.query, current.page);
    const receipt = runtime?.receipt || current.legacyReceipt || "";

    if (runtime?.searchLogId) {
      activeSearchLogId = runtime.searchLogId;
    }

    void execute(
      current.query,
      current.page,
      receipt,
      replaceUrl,
    );
  }

  document.addEventListener(
    "submit",
    function (event) {
      const form = event.target;

      if (!(form instanceof HTMLFormElement)) {
        return;
      }

      const input = form.querySelector('input[name="q"]');

      if (!(input instanceof HTMLInputElement)) {
        return;
      }

      const action = new URL(
        form.action || location.href,
        location.origin,
      );

      if (!isSearchPath(action.pathname)) {
        return;
      }

      const query = input.value.trim();

      if (!query) {
        return;
      }

      event.preventDefault();

      console.info(logPrefix, "submitAiSearch intercepted", {
        query,
        formAction: action.pathname + action.search,
      });

      activeSearchLogId = null;
      activeProducts = [];
      removePagination();
      showLoading();

      if (isSearchPath(location.pathname)) {
        console.info(logPrefix, "submitAiSearch in-place", {
          query,
        });

        void execute(query, 1, "", false);
        return;
      }

      /*
       * Trang khác không có search mount của theme.
       * Điều hướng sang search shell là bước bắt buộc với kiến trúc hiện tại.
       * URL public không chứa receipt/ai_search.
       */
      const url = searchUrl(query, 1);
      location.assign(url.href);
    },
    true,
  );

  document.addEventListener(
    "click",
    function (event) {
      if (!activeSearchLogId) {
        return;
      }

      const anchor =
        event.target instanceof Element
          ? event.target.closest('a[href*="/products/"]')
          : null;

      if (!anchor) {
        return;
      }

      const card = anchor.closest("[data-product-id]");
      const cardProductId = normalizeProductGid(
        card?.getAttribute("data-product-id"),
      );

      const activeProductIds = new Set(
        activeProducts
          .map(function (entry) {
            return normalizeProductGid(entry.productId);
          })
          .filter(Boolean),
      );

      let productId =
        cardProductId && activeProductIds.has(cardProductId)
          ? cardProductId
          : "";

      if (!productId) {
        const handle = new URL(anchor.href, location.origin)
          .pathname
          .match(/\/products\/([^/?#]+)/)?.[1];

        const product = activeProducts.find(function (entry) {
          return entry.handle === handle;
        });

        productId = normalizeProductGid(product?.productId);
      }

      if (!productId) {
        return;
      }

      void fetch(clickEndpoint, {
        method: "POST",
        credentials: "same-origin",
        keepalive: true,
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          searchLogId: activeSearchLogId,
          productId,
        }),
      });
    },
    true,
  );

  window.addEventListener("popstate", function () {
    runCurrentSearchEntry(true);
  });

  window.addEventListener("pageshow", function (event) {
    if (!event.persisted) {
      return;
    }

    const current = publicState();
    const runtime = runtimeStateFor(current.query, current.page);
    const renderedReceipt =
      document.documentElement.dataset.aiSearchV4Receipt || "";
    const renderedPage = Number.parseInt(
      document.documentElement.dataset.aiSearchV4Page || "1",
      10,
    );

    if (
      current.isSearchPage &&
      !current.bypass &&
      current.query &&
      runtime?.receipt &&
      renderedReceipt === runtime.receipt &&
      renderedPage === current.page
    ) {
      activeSearchLogId = runtime.searchLogId || activeSearchLogId;
      hideLoading();

      console.info(logPrefix, "pageshow BFCache restored", {
        query: current.query,
        page: current.page,
        receipt: runtime.receipt,
      });

      return;
    }

    runCurrentSearchEntry(true);
  });

  console.info(logPrefix, "loaded", {
    source: "search-interceptor.v4.js",
    configVersion: config.version ?? null,
    themeMapVersion: config.theme_map_version ?? null,
    endpoint,
  });

  const initial = publicState();

  if (
    initial.isSearchPage &&
    !initial.bypass &&
    initial.query
  ) {
    showLoading();
    runCurrentSearchEntry(true);
  }
})();
