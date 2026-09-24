import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { buildThemeResultLiquid } from "../app/services/renderer/theme-result-renderer.server";
import {
  deleteSearchResult,
  getSearchResultPage,
  saveSearchResult,
} from "../app/services/search/search-result-cache.server";
import { compileThemeMapV4 } from "../app/services/theme/theme-map-v4.compiler.server";

function source(filename: string, content: string) {
  return {
    filename,
    content,
    checksum: createHash("sha256").update(content).digest("hex"),
  };
}

function compile(
  section: string,
  snippetName: string,
  argument: string,
  sectionSettings: Record<string, string | number | boolean | null> = {},
) {
  const sectionFile = source("sections/arbitrary.liquid", section);
  const snippet = source(`snippets/${snippetName}.liquid`, `
    <a href="{{ ${argument}.url }}">{{ ${argument}.title }} {{ ${argument}.price | money }}</a>
  `);
  return compileThemeMapV4({
    theme: { id: "1", name: "Fixture" },
    search: {
      templateFile: "templates/search.json",
      templateType: "JSON",
      sectionKey: "fixture",
      sectionType: "arbitrary",
      sectionFile: sectionFile.filename,
    },
    sourceFile: sectionFile.filename,
    source: sectionFile.content,
    files: [
      source("templates/search.json", "{}"),
      sectionFile,
      snippet,
    ],
    settingResolver: {
      resolveSectionSetting(expression) {
        const name = expression.match(/^section\.settings\.([A-Za-z_][A-Za-z0-9_-]*)$/)?.[1];
        return name ? sectionSettings[name] : undefined;
      },
    },
  });
}

async function main() {
  for (const fixture of [
    { variable: "item", snippet: "card-product", argument: "card_product" },
    { variable: "resource", snippet: "product-tile", argument: "item" },
    { variable: "abc", snippet: "xyz", argument: "data" },
  ]) {
    const map = compile(`
      <ul id="Results-${fixture.variable}">
        {% for ${fixture.variable} in search.results %}
          {% if ${fixture.variable}.object_type == 'product' %}
            <li>{% render '${fixture.snippet}', ${fixture.argument}: ${fixture.variable} %}</li>
          {% endif %}
        {% endfor %}
      </ul>
    `, fixture.snippet, fixture.argument);
    assert.equal(map.status, "VERIFIED");
    assert.equal(map.rendererCandidates[0].productBinding.argument, fixture.argument);
    assert.equal(map.rendererCandidates[0].mount?.selector, `#Results-${fixture.variable}`);
  }

  const dawnStyle = compile(`
    {% assign skip_styles = false %}
    <ul id="ProductGrid" role="list">
      {% for item in search.results %}
        {% assign lazy_load = false %}
        {% if forloop.index > 2 %}{% assign lazy_load = true %}{% endif %}
        {% case item.object_type %}
          {% when 'product' %}
            <li>{% render 'tile', product: item,
              show_vendor: section.settings.show_vendor,
              lazy_load: lazy_load,
              skip_styles: skip_styles %}</li>
        {% endcase %}
        {% assign skip_styles = true %}
      {% endfor %}
    </ul>
  `, "tile", "product", { show_vendor: false });
  assert.equal(dawnStyle.status, "VERIFIED");
  assert.deepEqual(dawnStyle.rendererCandidates[0].arguments, {
    show_vendor: false,
    lazy_load: false,
    skip_styles: false,
  });

  const contextual = compile(`
    <ul data-results>{% for item in search.results %}
      {% if item.object_type == 'product' %}
        {% render 'unsafe', product: item, block: block %}
      {% endif %}
    {% endfor %}</ul>
  `, "unsafe", "product");
  assert.equal(contextual.status, "UNSUPPORTED");

  const renderMap = compile(`
    <ul id="StableMount">{% for item in search.results %}
      {% if item.object_type == 'product' %}<li>{% render 'tile', product: item %}</li>{% endif %}
    {% endfor %}</ul>
  `, "tile", "product");
  assert.equal(renderMap.status, "VERIFIED");
  const plan = buildThemeResultLiquid({
    map: renderMap,
    products: [
      { productId: "gid://shopify/Product/2", handle: "second" },
      { productId: "gid://shopify/Product/1", handle: "first" },
    ],
  });
  assert.ok(plan.liquid.indexOf("second") < plan.liquid.indexOf("first"));

  const rideStyle = compile(`
    <ul id="product-grid" role="list">
      {% for item in search.results %}
        <li class="grid__item">
          {% case item.object_type %}
            {% when 'product' %}
              {% render 'card-product', card_product: item, show_vendor: false %}
          {% endcase %}
        </li>
      {% endfor %}
    </ul>
  `, "card-product", "card_product");
  assert.equal(rideStyle.status, "VERIFIED");
  const ridePlan = buildThemeResultLiquid({
    map: rideStyle,
    products: [
      { productId: "gid://shopify/Product/2", handle: "women-jacket" },
      { productId: "gid://shopify/Product/1", handle: "winter-jacket" },
    ],
  });
  assert.doesNotMatch(ridePlan.liquid, /ai_product\.object_type/);
  assert.doesNotMatch(ridePlan.liquid, /item\.object_type/);
  assert.match(ridePlan.liquid, /render\s+'card-product'/);
  assert.match(ridePlan.liquid, /card_product:\s*ai_product/);
  assert.equal(
    (ridePlan.liquid.match(/card_product:\s*ai_product/g) || []).length,
    2,
  );
  assert.throws(
    () => buildThemeResultLiquid({
      map: rideStyle,
      products: Array.from({ length: 21 }, (_, index) => ({
        productId: `gid://shopify/Product/${index + 1}`,
        handle: `unique-product-${index + 1}`,
      })),
    }),
    /THEME_RENDER_PAGE_SIZE_EXCEEDED/,
  );

  const rankedProducts = Array.from({ length: 1000 }, (_, index) => ({
    productId: `gid://shopify/Product/${index + 1}`,
    handle: `product-${index + 1}`,
    score: 1 - index / 2000,
  }));
  const cached = await saveSearchResult({
    shop: "theme-map-v4-test.myshopify.com",
    query: "fixture",
    searchLogId: "fixture-log",
    rankedProducts,
  });
  try {
    const page1 = await getSearchResultPage({ shop: cached.shop, receiptId: cached.receiptId, page: 1, pageSize: 20 });
    const page2 = await getSearchResultPage({ shop: cached.shop, receiptId: cached.receiptId, page: 2, pageSize: 20 });
    const page50 = await getSearchResultPage({ shop: cached.shop, receiptId: cached.receiptId, page: 50, pageSize: 20 });
    assert.equal(page1?.products[0].handle, "product-1");
    assert.equal(page2?.products[0].handle, "product-21");
    assert.equal(page50?.products[19].handle, "product-1000");
    assert.equal(page50?.result.searchLogId, "fixture-log");
  } finally {
    await deleteSearchResult(cached.shop, cached.receiptId);
  }

  console.log("Theme Map V4 self-test: PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
