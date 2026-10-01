import assert from "node:assert/strict";
import { matchCatalogTerms } from "../app/services/search/catalog-term-matcher.server";
import {
  normalizeQueryText,
  parseDeterministicQuery,
} from "../app/services/search/deterministic-query-parser.server";
import { routeQuery } from "../app/services/search/query-router.server";
import { isApostropheSuffixCatalogMatch } from "../app/services/search/query-planner.server";
import type { ShopSearchDictionary } from "../app/services/search/shop-search-dictionary.server";

const dictionary: ShopSearchDictionary = {
  shop: "fixture.myshopify.com",
  version: "fixture-v1",
  loadedAt: 0,
  entries: [
    ["ao", "áo", "PRODUCT_TYPE"],
    ["ao khoac", "áo khoác", "PRODUCT_TYPE"],
    ["dam 2 day", "đầm 2 dây", "PRODUCT_TYPE"],
    ["giay", "giày", "PRODUCT_TYPE"],
    ["tai nghe", "tai nghe", "PRODUCT_TYPE"],
    ["op", "ốp", "PRODUCT_TYPE"],
    ["quan", "quần", "PRODUCT_TYPE"],
    ["quan ao", "quần áo", "PRODUCT_TYPE"],
    ["quan ao tre em", "quần áo trẻ em", "PRODUCT_TYPE"],
    ["quan the thao", "quần thể thao", "PRODUCT_TYPE"],
    ["sports pants", "quần thể thao", "PRODUCT_TYPE"],
    ["leather jacket", "leather jacket", "PRODUCT_TYPE"],
    ["nike shoes", "nike shoes", "PRODUCT_TYPE"],
    ["nike", "Nike", "BRAND"],
    ["adidas", "Adidas", "BRAND"],
    ["air force 1", "Air Force 1", "MODEL"],
    ["iphone 15 pro max", "iPhone 15 Pro Max", "MODEL"],
    ["simple", "Simple", "MODEL"],
    ["hat", "hat", "PRODUCT_TYPE"],
    ["man", "Man", "ATTRIBUTE"],
    ["co", "Co", "BRAND"],
    ["nam", "nam", "AUDIENCE"],
    ["kaki", "kaki", "ATTRIBUTE"],
    ["leather", "leather", "ATTRIBUTE"],
    ["ran ri", "rằn ri", "ATTRIBUTE"],
    ["chong nuoc", "chống nước", "ATTRIBUTE"],
    ["chong on", "chống ồn", "ATTRIBUTE"],
    ["airpods", "AirPods", "MODEL"],
    ["trekking", "trekking", "CONTEXT"],
  ].map(([normalized, canonical, field]) => ({
    normalized,
    canonical,
    field: field as ShopSearchDictionary["entries"][number]["field"],
    aliases: [],
    productCount: 3,
  })),
};

function planRoute(query: string) {
  const deterministic = parseDeterministicQuery(query);
  const matches = matchCatalogTerms(query, dictionary);
  const covered = new Set(matches.flatMap((match) => match.text.split(" ")));
  const unresolved = deterministic.normalizedQuery
    .split(" ")
    .filter((token) => token.length > 2 && !covered.has(token));
  return { deterministic, matches, routed: routeQuery({
    deterministic,
    matches,
    unresolvedSegments: unresolved.length ? [unresolved.join(" ")] : [],
  }) };
}

assert.equal(normalizeQueryText("ĐẦM ĐỎ"), "dam do");
assert.equal(normalizeQueryText("quần thể thao"), normalizeQueryText("quan the thao"));
assert.equal(parseDeterministicQuery("đồ gia dụng").price, undefined);
assert.equal(parseDeterministicQuery("giá đỡ điện thoại").price, undefined);
assert.equal(isApostropheSuffixCatalogMatch("I'm looking", "m"), true);
assert.equal(isApostropheSuffixCatalogMatch("women's top", "s"), true);
assert.equal(isApostropheSuffixCatalogMatch("shirt M", "m"), false);

// Accent folding must not turn Vietnamese source words into unrelated English
// catalog facts before the translation pass.
assert.equal(
  matchCatalogTerms("hạt giống nho", dictionary).some((match) => match.entry.canonical === "hat"),
  false,
);
assert.equal(
  matchCatalogTerms("vải màn che mắt", dictionary).some((match) => match.entry.canonical === "Man"),
  false,
);
assert.equal(
  matchCatalogTerms("có hệ thống dẫn đường", dictionary).some((match) => match.entry.canonical === "Co"),
  false,
);

const priced = parseDeterministicQuery("áo nam dưới 500k");
assert.equal(priced.price?.max, 500_000);
assert.equal(priced.marketPreference, "ANY");

const budget = parseDeterministicQuery("đầm 2 dây siêu cấp vipro giá rẻ");
assert.equal(budget.marketPreference, "BUDGET");
assert.notEqual(budget.marketPreference, "PREMIUM");

const exact = planRoute("Nike Air Force 1 size 42");
assert.equal(exact.routed.route, "STRUCTURED_ONLY");
assert.ok(exact.matches.some((match) => match.entry.field === "MODEL"));
assert.ok(exact.deterministic.measurements.some((item) => item.name === "size"));

const semantic = planRoute("giày đi cả ngày không đau chân");
assert.equal(semantic.routed.route, "VECTOR_SEMANTIC");

// A catalog model name can also be an ordinary adjective in recommendation
// prose. An isolated MODEL hit must not collapse a long unresolved need into
// an exact structured lookup.
const ambiguousModel = planRoute(
  "gift for my girlfriend something simple and elegant",
);
assert.ok(ambiguousModel.matches.some((match) => match.entry.field === "MODEL"));
assert.equal(ambiguousModel.routed.route, "LIGHT_LLM");

// A resolved product identity plus an ordinary attribute must still use the
// semantic lane. Treating "áo kaki" as structured-only would collapse a soft
// material/style preference into exact equality and skip vector recall.
const softFacetDirect = planRoute("áo kaki");
assert.equal(softFacetDirect.routed.route, "CODE_SEMANTIC");
assert.ok(
  softFacetDirect.routed.reasons.includes("IDENTITY_WITH_SOFT_SEMANTIC_MODIFIER"),
);

// Closed-world commerce entities remain eligible for structured-only.
const exactBrandDirect = planRoute("áo nike");
assert.equal(exactBrandDirect.routed.route, "STRUCTURED_ONLY");

// Long product identities must not swallow nested facet/entity ownership.
const nestedSoftFacet = planRoute("leather jacket");
assert.ok(
  nestedSoftFacet.matches.some(
    (match) => match.entry.field === "PRODUCT_TYPE" && match.entry.canonical === "leather jacket",
  ),
);
assert.ok(
  nestedSoftFacet.matches.some(
    (match) => match.entry.field === "ATTRIBUTE" && match.entry.canonical === "leather",
  ),
);
assert.equal(nestedSoftFacet.routed.route, "CODE_SEMANTIC");

const nestedExactBrand = planRoute("nike shoes");
assert.ok(nestedExactBrand.matches.some((match) => match.entry.field === "BRAND"));
assert.equal(nestedExactBrand.routed.route, "STRUCTURED_ONLY");

const compatibility = planRoute("ốp cho iphone 15 pro max");
assert.ok(compatibility.matches.some((match) => match.entry.field === "MODEL"));
assert.ok(compatibility.matches.some((match) => match.entry.field === "PRODUCT_TYPE"));

const negative = planRoute("tai nghe chống ồn không phải airpods");
assert.ok(negative.deterministic.negatives.some((item) => /airpods/i.test(item.value)));

const alternatives = planRoute("giày nike hoặc adidas");
assert.equal(alternatives.deterministic.relation, "ANY");
assert.equal(alternatives.matches.filter((match) => match.entry.field === "BRAND").length, 2);

const multiple = planRoute("áo và quần kaki");
assert.equal(multiple.deterministic.relation, "ALL");
assert.equal(multiple.matches.filter((match) => match.entry.field === "PRODUCT_TYPE").length, 2);

const longest = planRoute("quần áo trẻ em màu trắng");
assert.ok(longest.matches.some((match) => match.entry.canonical === "quần áo trẻ em"));
assert.ok(!longest.matches.some((match) => match.entry.canonical === "quần áo"));

const viIntent = planRoute("quần thể thao màu trắng");
const enIntent = planRoute("sports pants in white");
assert.equal(
  viIntent.matches.find((match) => match.entry.field === "PRODUCT_TYPE")?.entry.canonical,
  enIntent.matches.find((match) => match.entry.field === "PRODUCT_TYPE")?.entry.canonical,
);

console.log("Query plan shadow self-test: PASS");
