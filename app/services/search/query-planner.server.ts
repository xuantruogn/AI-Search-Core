import { isGenericDiscoveryFamily } from "./query-family.server";
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
  /\b(?:pair(?:s|ed|ing)?(?: well)? with|go(?:es|ing)?(?: well)? with|match(?:es|ed|ing)?(?: with)?|wear with|style with|mac(?: gi)? voi|phoi(?: do)? voi|ket hop voi|hop voi|di cung voi)\b/;

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

export function shouldForceCrossLanguageRewrite(args: {
  query: string;
  route: QueryPlan["route"];
  unresolvedSegments: string[];
}) {
  return (
    args.route === "VECTOR_SEMANTIC" &&
    args.unresolvedSegments.length > 0 &&
    /[^\x00-\x7F]/.test(args.query)
  );
}

export function sourceProductTypeOwnsTarget(args: {
  query: string;
  start: number;
  end: number;
}) {
  const tokens = normalizeQueryText(args.query).split(" ").filter(Boolean);
  if (tokens.length === 0) return false;

  // A quality modifying an indefinite requested object is not a catalog noun.
  // Keep it unresolved so semantic understanding can disambiguate it.
  const prefix = tokens.slice(0, args.start).join(" ");
  if (
    /\b(?:something|anything|nothing|thing|things)(?: (?:very|quite|really|more|less))?$/.test(
      prefix,
    )
  ) {
    return false;
  }

  // A catalog noun appearing only after a relation/context boundary is
  // context, not automatically the requested product. Do this before the
  // short-query fast path so phrases such as "working from home" do not turn
  // PRODUCT_TYPE=Home into the target identity.
  const contextualBoundaries = new Set([
    "for", "with", "on", "at", "from", "using", "without", "while",
    "when", "during", "about", "around", "because", "to",
  ]);
  const firstBoundary = tokens.findIndex((token) =>
    contextualBoundaries.has(token),
  );
  if (firstBoundary >= 0 && args.start > firstBoundary) return false;

  // Short catalog-style queries are overwhelmingly direct noun phrases:
  // "black cardigan", "women navy jacket", "electric kettle", etc.
  if (tokens.length <= 6) return true;
  if (args.start <= 0) return true;

  const before = tokens.slice(0, args.start);
  const tail = before.slice(-6).join(" ");

  // A product class explicitly owned by a request noun phrase remains the
  // target even inside a longer sentence: "I need a portable computer ...",
  // "looking for a waterproof jacket ...", "tôi cần một chiếc balo ...".
  if (
    /(?:^| )(?:need|want|find|buy|get|looking for|show me|can|muon|tim|mua)(?: (?:a|an|some|the|my|your|mot|chiec|cai))?(?: [a-z0-9]+){0,4}$/.test(
      tail,
    )
  ) {
    return true;
  }

  // If the identity appears before the first relation/context boundary, it is
  // still the requested product: "jacket for rain", "bag for commuting".
  if (firstBoundary < 0 || args.start < firstBoundary) return true;

  // In a long need/action sentence, a catalog word appearing only inside the
  // context is not automatically the target product. Examples:
  // "print labels from my home office" (Home), "video calls on my computer"
  // (Computer), "boil water for tea" (Tea). Leave it unresolved for the
  // semantic pass instead of creating a false DIRECT identity.
  return false;
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

async function buildUncachedPlan(
  shop: string,
  query: string,
  dictionary: Awaited<ReturnType<typeof getShopSearchDictionary>>,
): Promise<QueryPlan> {
  const deterministic = parseDeterministicQuery(query);
  const normalizedQuery = normalizeQueryText(query);
  const initialCatalogMatches = matchCatalogTerms(query, dictionary);
  const explicitComplementarySpan = complementaryRelationSpan(normalizedQuery);
  const normalizedTokens = normalizedQuery.split(" ").filter(Boolean);
  const forIndex = normalizedTokens.indexOf("for");
  const genericTargetBeforeFor =
    forIndex > 0 &&
    /^(?:an? )?(?:accessory|accessories|part|parts)\b/.test(
      normalizedTokens.slice(0, forIndex).join(" "),
    );
  const genericComplementTargets = new Set([
    "accessory", "accessories", "part", "parts",
  ]);
  const specificTargetBeforeFor =
    forIndex > 0 &&
    initialCatalogMatches.some(
      (match) =>
        match.entry.field === "PRODUCT_TYPE" &&
        match.end <= forIndex &&
        !genericComplementTargets.has(
          normalizeQueryText(match.entry.canonical),
        ) &&
        sourceProductTypeOwnsTarget({
          query,
          start: match.start,
          end: match.end,
        }),
    );
  const referenceIdentityAfterFor =
    forIndex >= 0 &&
    initialCatalogMatches.some(
      (match) =>
        match.entry.field === "PRODUCT_TYPE" &&
        match.start > forIndex,
    );
  const genericComplementarySpan =
    !explicitComplementarySpan &&
    genericTargetBeforeFor &&
    !specificTargetBeforeFor
      ? { start: forIndex, end: forIndex + 1 }
      : null;
  const complementarySpan =
    explicitComplementarySpan ?? genericComplementarySpan;
  const complementaryRelation = complementarySpan !== null;
  const rawMatches = initialCatalogMatches
    .filter((match) => {
      // Audience vocabulary can also exist as merchant productType. Source
      // role wins: men/women/kids/toddler are audience, never target identity
      // merely because the shop dictionary contains the same text.
      if (
        match.entry.field === "PRODUCT_TYPE" &&
        /^(?:men|women|mens|womens|men s|women s|male|female|boys|girls|kids|children|toddler)$/.test(
          normalizeQueryText(match.text),
        )
      ) {
        return false;
      }

      if (
        deterministic.price &&
        match.entry.field === "MEASUREMENT" &&
        /^\d+(?:[.,]\d+)?$/.test(match.text.trim())
      ) {
        return false;
      }

      if (
        match.entry.field === "PRODUCT_TYPE" &&
        !sourceProductTypeOwnsTarget({
          query,
          start: match.start,
          end: match.end,
        }) &&
        !(
          complementaryRelation &&
          complementarySpan &&
          match.start >= complementarySpan.end
        )
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
  const originalSpanWinners = [...strongestBySpan.values()];
  const promotedFamilySuffixKeys = new Set<string>();
  for (const identity of originalSpanWinners) {
    if (
      identity.entry.field !== "PRODUCT_TYPE" ||
      identity.confidence > 0.92
    ) {
      continue;
    }
    const leadingAttribute = originalSpanWinners.some(
      (match) =>
        match.entry.field === "ATTRIBUTE" &&
        match.start === identity.start &&
        match.end < identity.end &&
        match.confidence >= 0.5,
    );
    if (!leadingAttribute) continue;

    for (const candidate of originalSpanWinners) {
      if (
        !["ATTRIBUTE", "ALIAS", "CATEGORY"].includes(candidate.entry.field) ||
        candidate.start <= identity.start ||
        candidate.end !== identity.end ||
        candidate.entry.productCount <
          Math.max(3, identity.entry.productCount * 3)
      ) {
        continue;
      }
      promotedFamilySuffixKeys.add(
        `${candidate.start}:${candidate.end}:${normalizeQueryText(candidate.text)}`,
      );
    }
  }

  const spanWinners = originalSpanWinners.map((match) => {
    const key =
      `${match.start}:${match.end}:${normalizeQueryText(match.text)}`;
    if (!promotedFamilySuffixKeys.has(key)) return match;
    return {
      ...match,
      confidence: Math.max(match.confidence, 0.8),
      entry: {
        ...match.entry,
        field: "PRODUCT_TYPE" as const,
        confidence: Math.max(match.entry.confidence ?? 0, 0.8),
      },
    };
  });
  const productTypeSpans = spanWinners.filter(
    (match) => match.entry.field === "PRODUCT_TYPE",
  );
  const decomposableProductTypeSpans = new Set(
    productTypeSpans.filter((identity) => {
      const leadingAttribute = spanWinners.some(
        (match) =>
          match.entry.field === "ATTRIBUTE" &&
          match.start === identity.start &&
          match.end < identity.end,
      );
      const suffixFamily = productTypeSpans.some(
        (candidate) =>
          candidate !== identity &&
          candidate.start > identity.start &&
          candidate.end === identity.end,
      );
      return leadingAttribute && suffixFamily;
    }),
  );
  const matches = spanWinners.filter((match) => {
    if (
      match.entry.field === "PRODUCT_TYPE" &&
      decomposableProductTypeSpans.has(match)
    ) {
      // Prefer "modifier + family" over a catalog phrase that accidentally
      // fossilized the modifier into identity: "leather shoes" becomes
      // ATTRIBUTE=leather + PRODUCT_TYPE=shoes. This keeps exact facets and
      // family retrieval independently enforceable.
      return false;
    }
    const dominatedByLongerSameField = spanWinners.some(
      (other) =>
        other !== match &&
        other.entry.field === match.entry.field &&
        !decomposableProductTypeSpans.has(other) &&
        other.start <= match.start &&
        other.end >= match.end &&
        (other.start < match.start || other.end > match.end),
    );
    if (dominatedByLongerSameField) return false;

    if (match.entry.field === "PRODUCT_TYPE") return true;

    const containingIdentity = productTypeSpans.find(
      (identity) =>
        match.start >= identity.start &&
        match.end <= identity.end &&
        (match.start > identity.start || match.end < identity.end),
    );
    if (!containingIdentity) return true;

    // A longer exact product identity owns its internal span. Nested model,
    // compatibility, audience, measurement, etc. are descriptive pieces of
    // that identity, not independent MUST constraints. Treating them as
    // separate closed-world facts can prove false absence, e.g. an exact
    // "Presta valve adapter" identity intersected with COMPATIBILITY="Presta
    // valve". The one intentional exception is a leading ATTRIBUTE modifier:
    // "black backpack" and "waterproof jacket" should retain their explicit
    // shopper facet even when an enriched leaf identity happens to contain it.
    if (match.entry.field !== "ATTRIBUTE") return false;

    const attributeTokens = normalizeQueryText(match.text)
      .split(" ")
      .filter(Boolean);
    return (
      attributeTokens.length === 1 &&
      match.start === containingIdentity.start &&
      match.end < containingIdentity.end
    );
  });
  const covered = new Set(
    matches.flatMap((match) => normalizeQueryText(match.text).split(" ")),
  );
  const structural = new Set(["khong", "phai", "bat", "buoc", "cang", "tot", "or", "and"]);
  const semanticQuery = buildSemanticQuery(query, deterministic);
  const effectiveDeterministicMeasurements = deterministic.measurements.filter(
    (measurement) => {
      const normalizedMeasurement = normalizeQueryText(measurement.value);
      if (!normalizedMeasurement) return false;
      return !matches.some(
        (match) =>
          match.entry.field === "COMPATIBILITY" &&
          (
            normalizeQueryText(match.text) === normalizedMeasurement ||
            normalizeQueryText(match.text).startsWith(normalizedMeasurement + " ")
          ),
      );
    },
  );
  const measurementTokens = new Set(
    effectiveDeterministicMeasurements.flatMap((item) =>
      normalizeQueryText(item.value).split(" "),
    ),
  );
  const compatibilityTokens = new Set(
    deterministic.compatibility.flatMap((item) =>
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
        !compatibilityTokens.has(token) &&
        !/^\d+(?:[.,]\d+)?$/.test(token),
    );
  const unresolvedSegments = unresolvedTokens.length ? [unresolvedTokens.join(" ")] : [];
  const routedBase = routeQuery({ deterministic, matches, unresolvedSegments });
  // If a catalog identity is resolved but the remaining source text is
  // non-ASCII, vector-only handling can preserve the product noun while
  // silently losing a foreign-language modifier (for example "T-shirt màu
  // đen" in an English catalog). Route that unresolved remainder through the
  // lightweight translator/analyzer instead of embedding untranslated prose.
  const languageAwareRouted = shouldForceCrossLanguageRewrite({
    query,
    route: routedBase.route,
    unresolvedSegments,
  })
    ? {
        ...routedBase,
        route: "LIGHT_LLM" as const,
        reasons: [...new Set([...routedBase.reasons, "CROSS_LANGUAGE_SEMANTIC_REMAINDER"])],
      }
    : routedBase;
  const routed = complementaryRelation
    ? {
        ...languageAwareRouted,
        route: "FULL_LLM" as const,
        reasons: [...new Set([...languageAwareRouted.reasons, "COMPLEMENTARY_RELATION"])],
      }
    : languageAwareRouted;
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
  const onlyGenericIdentity = identityConstraints.length > 0
    ? identityConstraints.every((item) => isGenericDiscoveryFamily(item.value))
    : normalizedQuery.split(" ").some((token) => isGenericDiscoveryFamily(token));
  const hardIdentityIntersection =
    identityConstraints.length === 1 ||
    deterministic.relation === "ALL";
  const retrievalMode: QueryPlan["retrievalMode"] =
    complementaryRelation
      ? "COMPLEMENT"
      : (identityConstraints.length === 0 || onlyGenericIdentity) &&
          (onlyGenericIdentity || routed.route === "LIGHT_LLM" || routed.route === "FULL_LLM")
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
  const normalizedReferenceTail = referenceTail
    .replace(/^(?:a|an|the|mot|một)\s+/i, "")
    .trim();
  // Preserve the full source reference phrase so qualifiers owned by the
  // referenced item (black dress, blue skirt, fixed gear bicycle) survive
  // LLM timeout/fallback. Canonical context terms supplement that phrase;
  // they must never replace it and silently discard color/style/model facts.
  const referenceTerms = [
    ...(normalizedReferenceTail ? [normalizedReferenceTail] : []),
    ...resolvedReferenceTerms,
  ].filter(
    (value, index, list) =>
      value && list.findIndex((candidate) =>
        normalizeQueryText(candidate) === normalizeQueryText(value),
      ) === index,
  );

  return {
    rawQuery: query,
    normalizedQuery: normalizeUnicodeQueryText(query),
    foldedQuery: normalizedQuery,
    route: routed.route,
    retrievalMode,
    referenceTerms,
    identities: identityConstraints.map((item) => ({
      ...item,
      mode: !onlyGenericIdentity && hardIdentityIntersection ? "MUST" : "SHOULD",
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
      ...effectiveDeterministicMeasurements,
      ...byField("MEASUREMENT").map((item) => ({ ...item, name: "measurement" })),
    ],
    audiences: byField("AUDIENCE"),
    contexts: [...byField("CONTEXT"), ...byField("ALIAS")],
    compatibility: [
      ...deterministic.compatibility,
      ...byField("COMPATIBILITY").map((item) => ({ ...item, mode: "MUST" as const })),
    ].filter(
      (item, index, list) =>
        list.findIndex(
          (candidate) =>
            normalizeQueryText(candidate.value) === normalizeQueryText(item.value),
        ) === index,
    ),
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
  const task = buildUncachedPlan(shop, query, dictionary);
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
