/* eslint-disable no-console */
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");

const runtime = fs.readFileSync(
  path.join(__dirname, "../extensions/ai-search-storefront/assets/search-interceptor.v4.js"),
  "utf8",
);
const bridge = fs.readFileSync(
  path.join(__dirname, "../extensions/ai-search-storefront/blocks/ai_search_bridge.liquid"),
  "utf8",
);

function pageHtml() {
  return `<!doctype html><html><head><script>
    window.AI_SEARCH_ENGINE="v4";
    window.AI_SEARCH_CONFIG={version:4,theme_map_version:4,theme_id:"1",search_url:"/search",search_endpoint:"/apps/ai-search"};
  </script><script src="/runtime.js" defer></script></head><body>
    <form action="/search"><input name="q"></form>
    <ul id="VerifiedMount"><li data-handle="native">native</li></ul>
  </body></html>`;
}

function renderMetadata(page, options = {}) {
  return encodeURIComponent(JSON.stringify({
    version: 4,
    themeId: options.changedTheme ? "2" : "1",
    fingerprint: "fixture-fingerprint",
    receipt: "srch_fixture",
    searchLogId: "log_fixture",
    page,
    pageSize: 2,
    totalProducts: 3,
    totalPages: 2,
    candidateId: options.candidateId || "candidate-one",
    candidateIds: options.emptyFirstCandidate
      ? ["candidate-one", "candidate-two"]
      : ["candidate-one"],
    runtimeMode: "STATIC",
    mount: {
      strategy: "ELEMENT_ID",
      selector: options.missingMount ? "#MissingMount" : "#VerifiedMount",
      sourceFile: "sections/arbitrary.liquid",
      verification: { expectedTag: "ul", expectedMatchCount: 1 },
    },
    products: page === 1
      ? [{ productId: "gid://shopify/Product/2", handle: "beta" }, { productId: "gid://shopify/Product/1", handle: "alpha" }]
      : [{ productId: "gid://shopify/Product/3", handle: "gamma" }],
  }));
}

async function scenario(browser, options = {}) {
  const page = await browser.newPage();
  const calls = { search: 0, render: 0, nativeRender: 0, click: 0, fallback: 0 };
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (process.env.DEBUG_STOREFRONT_TEST === "1") console.log("[browser]", message.type(), message.text());
  });
  await page.route("https://theme.test/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/runtime.js") {
      return route.fulfill({ contentType: "application/javascript", body: runtime });
    }
    if (url.pathname === "/apps/ai-search/click") {
      calls.click += 1;
      return route.fulfill({ contentType: "application/json", body: '{"ok":true}' });
    }
    if (url.pathname === "/apps/ai-search") {
      if (url.searchParams.get("mode") === "transport-v4") {
        return route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({ reason: "THEME_CONTEXT_TRANSPORT_CANDIDATE_NOT_FOUND" }),
        });
      }
      if (url.searchParams.get("mode") === "render-v4") {
        calls.render += 1;
        const pageNumber = Number(url.searchParams.get("page") || 1);
        const requestedCandidate = url.searchParams.get("candidate_id") || "candidate-one";
        const emptyCandidate = options.emptyFirstCandidate && requestedCandidate === "candidate-one";
        const body = emptyCandidate
          ? '<li class="grid__item"></li><li class="grid__item"></li>'
          : pageNumber === 1
          ? '<li data-handle="beta"><a href="/products/beta">beta</a></li><li data-handle="alpha"><a href="/products/alpha">alpha</a></li>'
          : '<li data-handle="gamma"><a href="/products/gamma">gamma</a></li>';
        return route.fulfill({
          contentType: "text/html",
          body,
          headers: {
            "X-AI-Search-Render-Meta": renderMetadata(pageNumber, {
              ...options,
              candidateId: requestedCandidate,
            }),
          },
        });
      }
      calls.search += 1;
      if (options.backendError) return route.fulfill({ status: 503, body: "Unavailable" });
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          status: "success",
          engine: "ai-search-v4",
          render_receipt: { id: "srch_fixture", expires_at: new Date(Date.now() + 60_000).toISOString(), total_products: 3 },
          search_log_id: "log_fixture",
          pagination: { current_page: 1, page_size: 2, total_products: 3, total_pages: 2 },
        }),
      });
    }
    const query = url.searchParams.get("q") || "";
    if (query.includes("id:")) calls.nativeRender += 1;
    if (url.searchParams.has("_ai_search_bypass")) calls.fallback += 1;
    return route.fulfill({ contentType: "text/html", body: pageHtml() });
  });

  await page.goto("https://theme.test/search?q=green&type=product&ai_search=1");
  if (options.backendError || options.changedTheme || options.missingMount) {
    await page.waitForFunction(() =>
      !document.documentElement.hasAttribute("aria-busy") &&
      document.querySelector("#VerifiedMount")?.textContent === "native"
    );
    assert.equal(calls.fallback, 0);
  } else {
    await page.waitForFunction(() => document.querySelector("#VerifiedMount")?.textContent === "betaalpha");
    assert.deepEqual(
      await page.locator("#VerifiedMount > li").evaluateAll((nodes) => nodes.map((node) => node.dataset.handle)),
      ["beta", "alpha"],
    );
    await page.locator("#VerifiedMount a").first().evaluate((anchor) => {
      anchor.addEventListener("click", (event) => event.preventDefault(), { once: true });
    });
    await page.locator("#VerifiedMount a").first().click({ noWaitAfter: true });
    await page.waitForTimeout(50);
    await page.getByRole("button", { name: "Next search results page" }).click();
    await page.waitForFunction(() => document.querySelector("#VerifiedMount")?.textContent === "gamma");
    assert.equal(new URL(page.url()).searchParams.get("receipt"), null);
    assert.equal(new URL(page.url()).searchParams.get("page"), "2");
    assert.equal(await page.evaluate(() => history.state.receipt), "srch_fixture");
    assert.equal(calls.search, 1);
    assert.equal(calls.render, options.emptyFirstCandidate ? 4 : 2);
    assert.equal(calls.nativeRender, 0);
    assert.equal(calls.click, 1);
  }
  assert.deepEqual(errors, []);
  await page.close();
}

async function main() {
  assert.ok(bridge.includes('data-ai-search-v4-early-boot", "pending"'));
  assert.ok(bridge.includes("Finding the best matches…"));
  assert.ok(bridge.indexOf("ensureEarlyShell();") < bridge.indexOf("async function boot()"));
  const { chromium } = require("playwright");
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROME_PATH ||
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  });
  try {
    await scenario(browser);
    await scenario(browser, { backendError: true });
    await scenario(browser, { changedTheme: true });
    await scenario(browser, { missingMount: true });
    await scenario(browser, { emptyFirstCandidate: true });
    console.log("Theme Map V4 storefront self-test: PASS");
  } finally {
    await browser.close();
  }
}

module.exports = { pageHtml, renderMetadata, runtime };
if (require.main === module) main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
