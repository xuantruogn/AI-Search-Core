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

const COMPLEMENTARY_RELATION_PATTERN =
  /\b(?:pair(?:s|ed|ing)?(?: well)? with|go(?:es|ing)?(?: well)? with|match(?:es|ed|ing)? with|wear with|style with|mac(?: gi)? voi|phoi(?: do)? voi|ket hop voi|hop voi|di cung voi)\b/;

function complementaryRelationSpan(normalizedQuery: string) {
  const match = normalizedQuery.match(COMPLEMENTARY_RELATION_PATTERN);
  if (!match || match.index === undefined) return null;
  const before = normalizedQuery.slice(0, match.index).trim();
  const start = before ? before.split(/\s+/).length : 0;
  const width = match[0].trim().split(/\s+/).length;
  return { start, end: start + width };
}

function isComplementaryRelationQuery(normalizedQuery: string) {
  return complementaryRelationSpan(normalizedQuery) !== null;
}

function buildSemanticQuery(query: string, deterministic: ReturnType<typeof parseDeterministicQuery>) {
  let value = normalizeUnicodeQueryText(query);
  value = value
    .replace(/\b(?:không dưới|khong duoi|không trên|khong tren|không quá|khong qua|không hơn|khong hon|dưới|duoi|trên|tren|tối đa|toi da|tối thiểu|toi thieu|ít nhất|it nhat|từ|tu)\s+\d+(?:[.,]\d+)?\s*(?:k|tr|triệu|trieu|m|vnd|đ|d|đồng|dong)?\b/g, " ")
    .replace(/\b(?:rẻ nhất|re nhat|đắt nhất|dat nhat|giá tăng dần|gia tang dan|giá giảm dần|gia giam dan|thấp đến cao|thap den cao|cao đến thấp|cao den thap|mới nhất|moi nhat)\b/g, " ")
    .replace(/\b(?:giá rẻ|gia re|bình dân|binh dan|tiết kiệm|tiet kiem|hợp túi tiền|hop tui tien|budget|affordable|inexpensive|cheap|low cost|not too expensive|doesn t cost too much|does not cost too much)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return value || normalizeQueryText(query);
}

export function isApostropheSuffixCatalogMatch(
  query: string,
  matchText: string,
) {
  const token = matchText.trim().toLowerCase();
  if (!/^[a-z]$/.test(token)) return false;
  const raw = query.toLowerCase().replace(/’/g, "'");
  return raw.includes("'" + token);
}

async function buildUncachedPlan(shop: string, query: string): Promise<QueryPlan> {
  const deterministic = parseDeterministicQuery(query);
  const dictionary = await getShopSearchDictionary(shop);
  const normalizedQuery = normalizeQueryText(query);
  const complementaryRelation = isComplementaryRelationQuery(normalizedQuery);
  const complementarySpan = complementaryRelationSpan(normalizedQuery);
  const rawMatches = matchCatalogTerms(query, dictionary)
    .filter((match) => {
      if (
        deterministic.price &&
        match.entry.field === "MEASUREMENT" &&
        /^\d+(?:[.,]\d+)?$/.test(match.text.trim())
      ) {
        return false;
      }

      // Contractions/possessives such as "I'm" and "women's" normalize to
      // separate one-letter tokens. Never let those apostrophe suffixes become
      // size, variant, model or other catalog facets. Genuine standalone
      // single-letter queries such as "shirt M" remain eligible.
      if (isApostropheSuffixCatalogMatch(query, match.text)) {
        return false;
      }

      return true;
    })
    .map((match) => {
      if (
        match.entry.field === "MODEL" &&
        new RegExp(`\\b(?:cho|for) ${match.text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(normalizedQuery)
      ) {
        return { ...match, entry: { ...match.entry, field: "COMPATIBILITY" as const } };
      }

      if (
        complementaryRelation &&
        complementarySpan &&
        match.entry.field === "PRODUCT_TYPE" &&
        match.start >= complementarySpan.end
      ) {
        // In a complementary relation, a product mentioned after the relation
        // phrase is the reference item ("top to wear with a skirt" => skirt).
        // A product before the relation phrase remains the target identity.
        return { ...match, entry: { ...match.entry, field: "CONTEXT" as const } };
      }

      return match;
    });
  const fieldPriority: Record<string, number> = {
    IDENTIFIER: 100, MODEL: 90, PRODUCT_TYPE: 80, BRAND: 70,
    COMPATIBILITY: 60, MEASUREMENT: 55, AUDIENCE: 50, ATTRIBUTE: 40,
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
  const routedBase = routeQuery({ deterministic, matches, unresolvedSegments });
  const routed = complementaryRelation
    ? {
        ...routedBase,
        route: "FULL_LLM" as const,
        reasons: [...new Set([...routedBase.reasons, "COMPLEMENTARY_RELATION"])],
      }
    : routedBase;
  const modeFor = (text: string): QueryConstraint["mode"] => {
    const normalized = normalizeQueryText(text);
    if (
      deterministic.negatives.some((negative) =>
        normalizeQueryText(negative.value).includes(normalized),
      )
    ) return "MUST_NOT";
    const at = ` ${normalizedQuery} `.indexOf(` ${normalized} `);
    const prefix = at < 0 ? "" : normalizedQuery.slice(0, at)
      .split(" ").filter(Boolean).slice(-3).join(" ");
    if (/\b(?:only|must|requires?|required|exclusively|chi|bat buoc|phai co)\b/.test(prefix)) {
      return "MUST";
    }
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

  const identityConstraints = byField("PRODUCT_TYPE");
  const hardIdentityIntersection =
    identityConstraints.length === 1 ||
    deterministic.relation === "ALL";
  const retrievalMode: QueryPlan["retrievalMode"] =
    complementaryRelation
      ? "COMPLEMENT"
      : identityConstraints.length === 0 &&
          (routed.route === "LIGHT_LLM" || routed.route === "FULL_LLM")
        ? "DISCOVERY"
        : "DIRECT";
  const resolvedReferenceTerms =
    complementaryRelation && complementarySpan
      ? resolvedSegments
          .filter(
            (segment) =>
              segment.field === "CONTEXT" &&
              segment.start >= complementarySpan.end,
          )
          .map((segment) => segment.canonicalValue)
          .filter(Boolean)
      : [];
  const referenceTail =
    complementaryRelation && complementarySpan
      ? normalizedQuery
          .split(/\s+/)
          .slice(complementarySpan.end)
          .join(" ")
          .trim()
      : "";
  const referenceTerms =
    resolvedReferenceTerms.length > 0
      ? [...new Set(resolvedReferenceTerms)]
      : referenceTail
        ? [referenceTail]
        : [];

  return {
    rawQuery: query,
    normalizedQuery: normalizeUnicodeQueryText(query),
    foldedQuery: normalizedQuery,
    route: routed.route,
    retrievalMode,
    referenceTerms,
    identities: identityConstraints.map((item) => ({
      ...item,
      mode: hardIdentityIntersection ? "MUST" : "SHOULD",
    })),
    entities: {
      brands: byField("BRAND"),
      models: byField("MODEL"),
      identifiers: byField("IDENTIFIER").map((item) => ({ ...item, mode: "MUST" })),
    },
    attributes: matches
      .filter((match) =>
        match.entry.field === "ATTRIBUTE" &&
        (!complementaryRelation || !complementarySpan || match.start < complementarySpan.end),
      )
      .map((match) => ({
        ...constraint(match.entry.canonical, match.confidence),
        mode: modeFor(match.text),
        name: "attribute",
      })),
    measurements: [
      ...deterministic.measurements,
      ...byField("MEASUREMENT").map((item) => ({ ...item, name: "measurement" })),
    ],
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
