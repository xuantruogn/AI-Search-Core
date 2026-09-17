(function () {
  "use strict";

  if (window.__aiSearchV3Installed) return;
  window.__aiSearchV3Installed = true;

  console.log("⚡ [AI Search Client V3] Engine Dedicated Page đang hoạt động.");

  const SEARCH_ENDPOINT = "/apps/ai-search";
  const CACHE_KEY_PREFIX = "BUYENSE_SEARCH_CACHE_";

  // Helper thực hiện chuyển hướng thẳng sang App Proxy
  function redirectToDedicatedPage(query) {
    const cleanQuery = String(query || "").trim();
    if (!cleanQuery) return;

    console.log(`🚀 [AI Search Client V3] Đang chuyển hướng từ khóa "${cleanQuery}" sang Dedicated Page...`);
    const targetUrl = `${SEARCH_ENDPOINT}?q=${encodeURIComponent(cleanQuery)}`;
    window.location.assign(targetUrl);
  }

  // Bắt tất cả ô input tìm kiếm trên trang
  function installSearchInterception() {
    // 1. CHẶN FORM SUBMIT TRUYỀN THỐNG
    document.addEventListener(
      "submit",
      function (event) {
        const form = event.target;
        if (!form) return;

        const input = form.querySelector('input[name="q"], input[type="search"], input[placeholder*="Search" i]');
        if (!input) return;

        const query = input.value;
        if (query && query.trim()) {
          event.preventDefault();
          event.stopPropagation();
          event.stopImmediatePropagation();
          redirectToDedicatedPage(query);
        }
      },
      true // Capture phase để chạy trước script của Theme
    );

    // 2. CHẶN PHÍM ENTER TRÊN BẤT KỲ Ô INPUT SEARCH NÀO
    document.addEventListener(
      "keydown",
      function (event) {
        if (event.key === "Enter" || event.keyCode === 13) {
          const input = event.target;
          if (
            input &&
            (input.name === "q" || input.type === "search" || (input.tagName === "INPUT" && input.closest("form")?.action?.includes("/search")))
          ) {
            const query = input.value;
            if (query && query.trim()) {
              event.preventDefault();
              event.stopPropagation();
              event.stopImmediatePropagation();
              redirectToDedicatedPage(query);
            }
          }
        }
      },
      true
    );
  }

  function getClientCache(query) {
    try {
      const data = sessionStorage.getItem(CACHE_KEY_PREFIX + query.toLowerCase().trim());
      return data ? JSON.parse(data) : null;
    } catch (e) {
      return null;
    }
  }

  function setClientCache(query, cacheObject) {
    try {
      sessionStorage.setItem(CACHE_KEY_PREFIX + query.toLowerCase().trim(), JSON.stringify(cacheObject));
    } catch (e) {}
  }

  function renderCardHtml(product) {
    const isAvailable = product.availableForSale;
    const priceInfo = product.priceInfo;

    return `
      <div class="ai-card">
        <div class="ai-card__media">
          ${!isAvailable 
            ? '<span class="ai-badge ai-badge--soldout">Sold out</span>' 
            : priceInfo?.isSale 
            ? `<span class="ai-badge ai-badge--sale">Sale -${priceInfo.discountPercent}%</span>` 
            : ''}
          <a href="/products/${product.handle}">
            <img class="ai-card__img" src="${product.images?.primary || ''}" alt="${(product.title || '').replace(/"/g, '&quot;')}" loading="lazy" />
            ${product.images?.hasHover ? `<img class="ai-card__img ai-card__img--hover" src="${product.images.hover}" alt="${(product.title || '').replace(/"/g, '&quot;')}" loading="lazy" />` : ''}
          </a>
        </div>
        <div class="ai-card__info">
          ${product.vendor ? `<div class="ai-card__vendor">${product.vendor}</div>` : ''}
          <a href="/products/${product.handle}" class="ai-card__title">${product.title}</a>
          <div class="ai-card__price-wrapper">
            <span class="ai-card__price ${priceInfo?.isSale ? 'ai-card__price--sale' : ''}">
              ${priceInfo?.formattedPrice || ''}
            </span>
              ${priceInfo?.isSale && priceInfo?.formattedCompareAtPrice ? `<span class="ai-card__compare-price">${priceInfo.formattedCompareAtPrice}</span>` : ''}
          </div>
          <form action="/cart/add" method="post" style="margin-top: auto;">
            <input type="hidden" name="id" value="${product.defaultVariantId || ''}" />
            <button type="submit" class="ai-card__btn" ${!isAvailable ? 'disabled' : ''}>
              ${isAvailable ? 'Add to cart' : 'Sold out'}
            </button>
          </form>
        </div>
      </div>
    `;
  }

  function renderToGrid(gridContainer, products) {
    gridContainer.innerHTML = products.map(renderCardHtml).join("");
  }

  async function goToPage(targetPage) {
    const serverCache = window.__BUYENSE_CACHE__;
    if (!serverCache || !serverCache.query) return;

    const currentQuery = serverCache.query;
    const serverPageSize = Number(serverCache.pageSize);
    const serverTotalPages = Number(serverCache.totalPages);

    if (!Number.isFinite(serverPageSize) || serverPageSize <= 0) return;
    if (!Number.isFinite(serverTotalPages) || serverTotalPages <= 0) return;

    let clientCache = getClientCache(currentQuery);
    const serverAllIds = Array.isArray(serverCache.allIds) ? serverCache.allIds : [];
    const serverPage1 = serverCache.pages?.[1] || [];

    const cacheIsOutdated =
      !clientCache ||
      clientCache.pageSize !== serverPageSize ||
      clientCache.totalPages !== serverTotalPages ||
      JSON.stringify(clientCache.allIds) !== JSON.stringify(serverAllIds);

    if (cacheIsOutdated) {
      clientCache = {
        query: currentQuery,
        allIds: serverAllIds,
        pageSize: serverPageSize,
        totalPages: serverTotalPages,
        pages: { 1: serverPage1 },
      };
      setClientCache(currentQuery, clientCache);
    }

    const gridContainer = document.getElementById("ai-product-grid");
    if (!gridContainer) return;

    const updatedCache = getClientCache(currentQuery) || clientCache;

    if (
      updatedCache.pages &&
      Array.isArray(updatedCache.pages[targetPage]) &&
      updatedCache.pages[targetPage].length > 0
    ) {
      renderToGrid(gridContainer, updatedCache.pages[targetPage]);
      updatePaginationButtons(targetPage);
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }

    const pageSize = Number(updatedCache.pageSize);
    if (!Number.isFinite(pageSize) || pageSize <= 0) return;

    const offset = (targetPage - 1) * pageSize;
    const targetIds = updatedCache.allIds.slice(offset, offset + pageSize);
    if (!targetIds.length) return;

    gridContainer.style.opacity = "0.5";

    try {
      const response = await fetch(
        `${SEARCH_ENDPOINT}?format=json&ids=${targetIds.join(",")}`
      );
      const data = await response.json();

      if (data.status === "success" && Array.isArray(data.products)) {
        updatedCache.pages[targetPage] = data.products;
        setClientCache(currentQuery, updatedCache);

        renderToGrid(gridContainer, data.products);
        updatePaginationButtons(targetPage);
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    } catch (err) {
      console.error("❌ [AI Search Client] Lỗi AJAX Phân trang:", err);
    } finally {
      gridContainer.style.opacity = "1";
    }
  }

  function initPagination() {
    const container = document.getElementById("ai-pagination");
    if (!container) return;

    container.addEventListener("click", function (e) {
      const btn = e.target.closest(".ai-pagination__btn");
      if (!btn) return;

      const targetPage = parseInt(btn.dataset.page, 10);
      if (targetPage) {
        goToPage(targetPage);
      }
    });
  }

  function updatePaginationButtons(activePage) {
    const buttons = document.querySelectorAll(".ai-pagination__btn");
    buttons.forEach((btn) => {
      const p = parseInt(btn.dataset.page, 10);
      if (p === activePage) {
        btn.classList.add("ai-pagination__btn--active");
      } else {
        btn.classList.remove("ai-pagination__btn--active");
      }
    });
  }

  function startEngine() {
    installSearchInterception();
    initPagination();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startEngine);
  } else {
    startEngine();
  }
})();