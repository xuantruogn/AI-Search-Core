import { matchCatalogTerms } from "./catalog-term-matcher.server";
import {
  normalizeQueryText,
  normalizeUnicodeQueryText,
  parseDeterministicQuery,
} from "./deterministic-query-parser.server";
import {
  QUERY_PARSER_VERSION,
  QUERY_ROUTER_VERSION,
  type QueryConstraint,
  type QueryPlan,
} from "./query-plan.server";
import { routeQuery } from "./query-router.server";
import { getShopSearchDictionary } from "./shop-search-dictionary.server";

const planCache = new Map<string, { expiresAt: number; plan: QueryPlan }>();
const pendingPlans = new Map<string, Promise<QueryPlan>>();
const STOP_WORDS = new Set(["tim", "mua", "cho", "cua", "voi", "gia", "va", "hoac", "the", "for", "with"]);

function constraint(value: string, confidence: number): QueryConstraint {
  return {
    value,
    normalizedValue: normalizeQueryText(value),
    mode: "SHOULD",
    confidence,
    source: "DICTIONARY",
  };
}

function buildSemanticQuery(query: string, deterministic: ReturnType<typeof parseDeterministicQuery>) {
  let value = normalizeUnicodeQueryText(query);
  value = value
    .replace(/\b(?:duoi|tren|khong qua|khong hon|toi da|toi thieu|it nhat|tu)\s+\d+(?:[.,]\d+)?\s*(?:k|tr|trieu|m|vnd|d|dong)?\b/g, " ")
    .replace(/\b(?:re nhat|dat nhat|gia tang dan|gia giam dan|thap den cao|cao den thap|moi nhat)\b/g, " ")
    .replace(/\b(?:gia re|binh dan|tiet kiem|hop tui tien|budget|affordable)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return value || normalizeQueryText(query);
}

async function buildUncachedPlan(shop: string, query: string): Promise<QueryPlan> {
  const deterministic = parseDeterministicQuery(query);
  const dictionary = await getShopSearchDictionary(shop);
  const normalizedQuery = normalizeQueryText(query);
  const rawMatches = matchCatalogTerms(query, dictionary).map((match) =>
    match.entry.field === "MODEL" &&
    new RegExp(`\\b(?:cho|for) ${match.text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(normalizedQuery)
      ? { ...match, entry: { ...match.entry, field: "COMPATIBILITY" as const } }
      : match,
  );
  const fieldPriority: Record<string, number> = {
    IDENTIFIER: 100, MODEL: 90, PRODUCT_TYPE: 80, BRAND: 70,
    COMPATIBILITY: 60, AUDIENCE: 50, ATTRIBUTE: 40,
    CATEGORY: 30, CONTEXT: 20, ALIAS: 10,
  };
  const strongestBySpan = new Map<string, (typeof rawMatches)[number]>();
  for (const match of rawMatches) {
    const key = normalizeQueryText(match.text);
    const current = strongestBySpan.get(key);
    if (!current || match.confidence > current.confidence ||
      (match.confidence === current.confidence &&
        (fieldPriority[match.entry.field] ?? 0) > (fieldPriority[current.entry.field] ?? 0))) {
      strongestBySpan.set(key, match);
    }
  }
  const matches = [...strongestBySpan.values()];
  const covered = new Set(
    matches.flatMap((match) => normalizeQueryText(match.text).split(" ")),
  );
  const structural = new Set(["khong", "phai", "bat", "buoc", "cang", "tot", "or", "and"]);
  const semanticQuery = buildSemanticQuery(query, deterministic);
  const measurementTokens = new Set(
    deterministic.measurements.flatMap((item) =>
      normalizeQueryText(item.value).split(" "),
    ),
  );
  const unresolvedTokens = semanticQuery
    .split(" ")
    .filter(
      (token) =>
        token.length > 1 &&
        !covered.has(token) &&
        !STOP_WORDS.has(token) &&
        !structural.has(token) &&
        !measurementTokens.has(token) &&
        !/^\d+(?:[.,]\d+)?$/.test(token),
    );
  const unresolvedSegments = unresolvedTokens.length ? [unresolvedTokens.join(" ")] : [];
  const routed = routeQuery({ deterministic, matches, unresolvedSegments });
  const modeFor = (text: string): QueryConstraint["mode"] => {
    const normalized = normalizeQueryText(text);
    if (
      deterministic.negatives.some((negative) =>
        normalizeQueryText(negative.value).includes(normalized),
      )
    ) return "MUST_NOT";
    if (
      new RegExp(`\\b(?:bat buoc|phai co|must|required) ${normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(normalizedQuery)
    ) return "MUST";
    return "SHOULD";
  };
  const byField = (field: string) =>
    matches
      .filter((match) => match.entry.field === field)
      .map((match) => ({
        ...constraint(match.entry.canonical, match.confidence),
        mode: modeFor(match.text),
      }));
  const resolvedSegments = matches.map((match) => ({
    text: match.text,
    start: match.start,
    end: match.end,
    field: match.entry.field,
    canonicalValue: match.entry.canonical,
    confidence: match.confidence,
    source: "DICTIONARY" as const,
  }));

  return {
    rawQuery: query,
    normalizedQuery: normalizeUnicodeQueryText(query),
    foldedQuery: normalizedQuery,
    route: routed.route,
    identities: byField("PRODUCT_TYPE").map((item) => ({ ...item, mode: "MUST" })),
    entities: {
      brands: byField("BRAND"),
      models: byField("MODEL"),
      identifiers: byField("IDENTIFIER").map((item) => ({ ...item, mode: "MUST" })),
    },
    attributes: byField("ATTRIBUTE").map((item) => ({ ...item, name: "attribute" })),
    measurements: deterministic.measurements,
    audiences: byField("AUDIENCE"),
    contexts: [...byField("CONTEXT"), ...byField("ALIAS")],
    compatibility: byField("COMPATIBILITY").map((item) => ({ ...item, mode: "MUST" })),
    ...(deterministic.price ? { price: deterministic.price } : {}),
    marketPreference: deterministic.marketPreference,
    relation: deterministic.relation,
    sort: deterministic.sort,
    semanticQuery,
    resolvedSegments,
    unresolvedSegments,
    routerReason: routed.reasons,
    versions: {
      dictionaryVersion: dictionary.version,
      queryParserVersion: QUERY_PARSER_VERSION,
      queryRouterVersion: QUERY_ROUTER_VERSION,
    },
  };
}

export async function buildQueryPlan(shop: string, query: string): Promise<QueryPlan> {
  const dictionary = await getShopSearchDictionary(shop);
  const key = `${shop}\u0000${dictionary.version}\u0000${QUERY_PARSER_VERSION}\u0000${QUERY_ROUTER_VERSION}\u0000${normalizeQueryText(query)}`;
  const cached = planCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.plan;
  const pending = pendingPlans.get(key);
  if (pending) return pending;
  const task = buildUncachedPlan(shop, query);
  pendingPlans.set(key, task);
  try {
    const plan = await task;
    planCache.set(key, { expiresAt: Date.now() + 300_000, plan });
    while (planCache.size > 2_000) planCache.delete(planCache.keys().next().value as string);
    return plan;
  } finally {
    pendingPlans.delete(key);
  }
}
