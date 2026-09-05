(() => {
  if (window.__aiSearchBridgeInstalled) return;
  window.__aiSearchBridgeInstalled = true;

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

  function configuredProxyPath() {
    const raw = window.__aiSearchBridgeConfig?.proxyPath;
    if (typeof raw !== "string") return "/apps/ai-search";

    const value = raw.trim();
    if (!value.startsWith("/") || value.startsWith("//")) {
      return "/apps/ai-search";
    }

    try {
      const parsed = new URL(value, window.location.origin);
      if (parsed.origin !== window.location.origin) return "/apps/ai-search";
      return parsed.pathname.replace(/\/$/, "") || "/apps/ai-search";
    } catch {
      return "/apps/ai-search";
    }
  }

  function configuredDefaultSearchTypes() {
    const raw = window.__aiSearchBridgeConfig?.defaultSearchTypes;
    if (!Array.isArray(raw)) return [];
    return [...new Set(raw.map((value) => String(value).trim().toLowerCase()).filter(Boolean))];
  }


  function configuredUnscopedSearchMode() {
    const raw = String(window.__aiSearchBridgeConfig?.unscopedSearchMode || "")
      .trim()
      .toLowerCase();
    return raw === "respect_store" ? "respect_store" : "product_only";
  }
  const proxyPath = configuredProxyPath();
  const defaultSearchTypes = configuredDefaultSearchTypes();
  const unscopedSearchMode = configuredUnscopedSearchMode();

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
      if (!Number.isSafeInteger(page) || page !== 1) return true;
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

  function cleanNativeBypassFromAddressBar() {
    let current;
    try {
      current = new URL(window.location.href);
    } catch {
      return false;
    }

    if (!isNativeSearchPath(current.pathname)) return false;
    if (current.searchParams.get(NATIVE_BYPASS_PARAM) !== "1") return false;

    current.searchParams.delete(NATIVE_BYPASS_PARAM);
    window.history.replaceState(
      window.history.state,
      "",
      `${current.pathname}${current.search}${current.hash}`,
    );
    return true;
  }

  function redirectNativeSearchToAi(nativeUrl) {
    if (!shouldUseAi(nativeUrl)) return false;

    const query = (nativeUrl.searchParams.get("q") || "").trim();
    const target = new URL(proxyPath, window.location.origin);
    target.searchParams.set("q", query);
    target.searchParams.set(
      "native_search_url",
      `${nativeUrl.pathname}${nativeUrl.search}`,
    );

    window.location.assign(`${target.pathname}${target.search}`);
    return true;
  }

  function buildNativeTargetFromForm(form, submitter) {
    let action;
    try {
      action = new URL(
        form.getAttribute("action") || window.location.href,
        window.location.origin,
      );
    } catch {
      return null;
    }

    if (action.origin !== window.location.origin) return null;
    if (!isNativeSearchPath(action.pathname)) return null;

    const formData = new FormData(form);
    if (
      submitter instanceof HTMLElement &&
      "name" in submitter &&
      "value" in submitter &&
      typeof submitter.name === "string" &&
      submitter.name
    ) {
      formData.append(submitter.name, String(submitter.value ?? ""));
    }

    const nativeTarget = new URL(
      `${action.pathname}${action.search}`,
      window.location.origin,
    );

    const replacedKeys = new Set();
    for (const [key, value] of formData.entries()) {
      if (typeof value !== "string") continue;
      if (!replacedKeys.has(key)) {
        nativeTarget.searchParams.delete(key);
        replacedKeys.add(key);
      }
      nativeTarget.searchParams.append(key, value);
    }

    const query = (nativeTarget.searchParams.get("q") || "").trim();
    if (!query) return null;
    nativeTarget.searchParams.set("q", query);
    normalizeProductOnlyType(nativeTarget);
    return nativeTarget;
  }

  const bypassedNativeLoad = cleanNativeBypassFromAddressBar();

  document.addEventListener("submit", (event) => {
    if (event.defaultPrevented) return;

    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    if (form.hasAttribute("data-ai-search-ignore")) return;
    if ((form.method || "get").toLowerCase() !== "get") return;

    const nativeTarget = buildNativeTargetFromForm(form, event.submitter);
    if (!nativeTarget || !shouldUseAi(nativeTarget)) return;

    event.preventDefault();
    redirectNativeSearchToAi(nativeTarget);
  });

  document.addEventListener("click", (event) => {
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

    let node = event.target;
    while (node && !(node instanceof HTMLAnchorElement)) {
      node = node.parentElement;
    }
    if (!(node instanceof HTMLAnchorElement)) return;
    if (node.hasAttribute("data-ai-search-ignore")) return;
    if (node.hasAttribute("download")) return;
    if (node.target && node.target.toLowerCase() !== "_self") return;

    let target;
    try {
      target = new URL(node.href, window.location.origin);
    } catch {
      return;
    }

    if (target.origin !== window.location.origin) return;
    normalizeProductOnlyType(target);
    if (!shouldUseAi(target)) return;

    event.preventDefault();
    redirectNativeSearchToAi(target);
  });

  if (!bypassedNativeLoad) {
    try {
      const current = new URL(window.location.href);
      normalizeProductOnlyType(current);
      redirectNativeSearchToAi(current);
    } catch {
      // Leave the storefront untouched when Location cannot be parsed.
    }
  }
})();
