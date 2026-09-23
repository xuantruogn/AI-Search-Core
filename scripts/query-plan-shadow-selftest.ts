import assert from "node:assert/strict";
import { matchCatalogTerms } from "../app/services/search/catalog-term-matcher.server";
import {
  normalizeQueryText,
  parseDeterministicQuery,
} from "../app/services/search/deterministic-query-parser.server";
import { routeQuery } from "../app/services/search/query-router.server";
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
    ["nike", "Nike", "BRAND"],
    ["adidas", "Adidas", "BRAND"],
    ["air force 1", "Air Force 1", "MODEL"],
    ["iphone 15 pro max", "iPhone 15 Pro Max", "MODEL"],
    ["nam", "nam", "AUDIENCE"],
    ["kaki", "kaki", "ATTRIBUTE"],
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
