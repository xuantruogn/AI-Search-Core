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

function compile(section: string, snippetName: string, argument: string) {
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
