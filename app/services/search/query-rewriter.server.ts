import { parseSemanticDemandProfile, renderSemanticDemand, semanticDemandSchema, type SemanticDemandProfile } from "./semantic-contract.server";
import { getShopSettings } from "../commerce/shop-registry.server";
import {
  recordGeminiUsageSafe,
  recordOpenAiUsageSafe,
} from "../ai/provider-usage.server";
import {
  generateGeminiQueryRewrite,
  getGeminiQueryRewriteModel,
} from "./gemini-query-rewriter.server";
import {
  generateOpenAiQueryRewrite,
  getOpenAiQueryRewriteModel,
  isOpenAiQueryRewriteConfigured,
} from "./openai-query-rewriter.server";

type CacheEntry<T> = {
  expiresAt: number;
  value: T;
};

export type QueryRewriteResult = {
  query: string;
  rewritten: boolean;
  catalogRelevant: boolean;
  analysis: QueryRewriteAnalysis;
  model: string | null;
  fallbackReason: string | null;
  planning?: {
    route: "STRUCTURED_ONLY" | "CODE_SEMANTIC" | "VECTOR_SEMANTIC" | "LIGHT_LLM" | "FULL_LLM";
    retrievalMode: "DIRECT" | "DISCOVERY" | "COMPLEMENT";
    semanticQuery: string;
    semanticResolution: "CODE" | "VECTOR" | "LIGHT_LLM" | "FULL_LLM";
    semanticResolutionConfidence: number;
    resolvedSegments: Array<{
      text: string;
      field: string;
      canonicalValue: string;
      confidence: number;
      start?: number;
      end?: number;
      source?: string;
    }>;
    unresolvedSegments: string[];
  };
  timing?: QueryRewriteTiming;
  context?: {
    selectedTerms: Array<{
      kind: string;
      value: string;
      score: number;
      productCount: number;
    }>;
    loadMs: number;
    filterMs: number;
    totalMs: number;
    cacheStatus: "HIT" | "MISS";
    dbReadMs: number;
    aggregateCodeMs: number;
    signalBuildCodeMs: number;
    scoreCodeMs: number;
    sortSelectCodeMs: number;
    composeCodeMs: number;
    canonicalTypeCoverageComplete?: boolean;
    identityCandidateProductIds?: string[];
    targetFamilyProductIds?: string[];
    directExpansionGroundedProductIds?: string[];
    directSourceFacetGroundedProductIds?: string[];
    directSourceFacetConsensusProductIds?: string[];
    discoverySourceIdentityProductIds?: string[];
    ungroundedSourceProductClass?: boolean;
    ungroundedExplicitFeature?: boolean;
    discoverySourceGroundedProductIds?: string[];
    discoveryExpansionGroundedProductIds?: string[];
  };
};

export type QueryRewriteTiming = {
  cacheStatus: "HIT" | "MISS" | "JOINED" | "BYPASS";
  totalMs: number;
  llmMs: number;
  llmCallCount: number;
  inputTokens: number | null;
  outputTokens: number | null;
  normalizeCodeMs?: number;
  settingsDbMs?: number;
  cacheLookupCodeMs?: number;
  pendingWaitMs?: number;
  responseParseCodeMs?: number;
  cacheWriteCodeMs?: number;
  otherCodeMs?: number;
  timeoutBudgetMs?: number;
  complexityRoute?: "SIMPLE" | "COMPLEX";
};

export type SemanticMandatoryConcept = {
  /** Canonical concept in the configured shop/search language. */
  target: string;
  /** Same shopper-owned concept copied/translated from the source query. */
  source: string;
};

export type QueryRewriteAnalysis = {
  /** LLM semantic meaning only; exact enforcement remains code-owned. */
  semanticDemand?: SemanticDemandProfile;
  /** Aligned source/canonical mandatory concepts; preserves provenance. */
  semanticMandatoryConcepts?: SemanticMandatoryConcept[];
  /**
   * Target identities explicitly owned by the shopper source after validated
   * translation. This is provenance for family relevance, not an inferred
   * expansion and not by itself a closed-world absence proof.
   */
  sourceOwnedTargetIdentities?: string[];
  /**
   * Shopper-owned exact values preserved through translation (for example
   * xanh -> blue). This is provenance only. Downstream code must still map the
   * value to a typed catalog fact before using it as exact authority.
   */
  sourceOwnedExactConstraints?: string[];
  // Keep PREMIUM/BUDGET in this legacy field for downstream compatibility.
  // marketPreference is the cleaner semantic signal for new consumers.
  sortIntent: "RELEVANCE" | "PRICE_ASC" | "PRICE_DESC" | "PREMIUM" | "BUDGET";
  marketPreference: "ANY" | "PREMIUM" | "BUDGET";
  intent: string;
  detectedLanguage: string;
  complexity: "SIMPLE" | "COMPLEX";
  confidence: number;
  verticalFit: "IN_SCOPE" | "OUT_OF_SCOPE" | "UNCERTAIN";
  productType: string;
  productTypes: string[];
  productRelation: "NONE" | "SINGLE" | "ANY" | "ALL";
  retrievalMode?: "DIRECT" | "DISCOVERY" | "COMPLEMENT";
  referenceTerms?: string[];
  shopLanguageProductType: string;
  category: string;
  subcategory: string;
  brands: string[];
  models: string[];
  identifiers: string[];
  audience: string[];
  requiredAttributes: string[];
  optionalPreferences: string[];
  useCases: string[];
  compatibility: string[];
  negativeAttributes: string[];
  entities: string[];
  attributes: string[];
  negativeTerms: string[];
  semanticExpansions: string[];
  semanticMustTerms?: string[];
  semanticSourceMustTerms?: string[];
  semanticMustNotTerms?: string[];
  shopLanguage: string;
  shopLanguageTerms: string[];
  englishTerms: string[];
  matchedCatalogTerms: string[];
  decisionReason: string;
};

type FastQueryAnalysis = {
  semanticDemand?: SemanticDemandProfile;
  mandatoryConcepts?: Array<{
    target?: unknown;
    source?: unknown;
  }>;
  detectedLanguage: string;
  retrievalMode?: "DIRECT" | "DISCOVERY" | "COMPLEMENT";
  referenceTerms?: string[];
  semanticQuery: string;
  expansions?: string[];
  mustTerms?: string[];
  sourceMustTerms?: string[];
  mustNotTerms?: string[];
};

const QUERY_REWRITE_CACHE_VERSION =
  "semantic-normalize-v42-source-owned-target-and-exact-provenance";
const rewrittenQueryCache = new Map<string, CacheEntry<QueryRewriteResult>>();
const pendingRewrites = new Map<string, Promise<QueryRewriteResult>>();

function readPositiveInteger(name: string, fallback: number) {
  const value = Number.parseInt(process.env[name] || "", 10);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function isEnabled() {
  const value =
    process.env.AI_SEARCH_QUERY_REWRITE_ENABLED?.trim().toLowerCase();
  return !value || !["0", "false", "off", "no"].includes(value);
}

function getRewriteModel() {
  return getGeminiQueryRewriteModel();
}

function shouldUseOpenAiRewriteBackup(error: unknown) {
  if (!isOpenAiQueryRewriteConfigured()) return false;
  const message = error instanceof Error ? error.message : String(error);
  return (
    /Gemini API (?:429|5\d\d)\b/i.test(message) ||
    /quota|rate limit|resource exhausted/i.test(message) ||
    /timed?\s*out|timeout|GeminiTimeoutError|AbortError/i.test(message) ||
    /fetch failed|connection|ECONNRESET|ENETUNREACH|EAI_AGAIN/i.test(message)
  );
}

function hasExplicitNegationIntent(query: string) {
  const normalized = normalizeCommerceText(query);
  return /\b(?:khong muon|khong lay|khong dung|khong phai|khong mau|khong(?!\s+(?:qua|hon|duoi|tren)\b)|loai tru|ngoai tru|tru|without|except|excluding|exclude|not)\b/.test(
    normalized,
  );
}

function getRewriteBudget(query: string) {
  const tokens = query.split(/\s+/).filter(Boolean);
  const normalized = normalizeCommerceText(query);

  // A digit alone is not a structured constraint: iPhone 15, RTX 4060, size 42,
  // 500 ml and 2 TB can all be ordinary product identity/attributes.
  const hasNumericConstraint =
    (/\d/.test(normalized) &&
      /\b(?:duoi|tren|khong qua|khong hon|toi da|toi thieu|it nhat|nhieu nhat|tu|den|khoang|tam|under|below|over|above|at most|at least|between|from|to)\b/.test(
        normalized,
      )) ||
    /(?:<=|>=|<|>)\s*\d/.test(query) ||
    /[$\u20AC\u00A3\u00A5\u20AB]\s*\d/.test(query);

  const hasExplicitNegation =
    hasExplicitNegationIntent(query);

  const hasSortOrTierIntent =
    /\b(?:re nhat|dat nhat|gia tang dan|gia giam dan|thap den cao|cao den thap|cao cap|hang sang|sang trong|gia re|binh dan|tiet kiem|hop tui tien|cheapest|most expensive|lowest price|highest price|price ascending|price descending|premium|luxury|budget|affordable|value for money)\b/.test(
      normalized,
    );

  const hasBooleanStructure =
    /\b(?:hoac|either|or|and or)\b/.test(normalized);

  const complexityRoute =
    tokens.length >= 6 ||
    hasNumericConstraint ||
    hasExplicitNegation ||
    hasSortOrTierIntent ||
    hasBooleanStructure
      ? "COMPLEX"
      : "SIMPLE";

  const legacyTimeout = readPositiveInteger("AI_SEARCH_LLM_TIMEOUT_MS", 1_500);
  const timeoutMs =
    complexityRoute === "COMPLEX"
      ? Math.max(
          readPositiveInteger(
            "AI_SEARCH_LLM_COMPLEX_TIMEOUT_MS",
            Math.max(legacyTimeout, 1_800),
          ),
          6_500,
        )
      : Math.max(
          readPositiveInteger(
            "AI_SEARCH_LLM_SIMPLE_TIMEOUT_MS",
            Math.min(legacyTimeout, 1_200),
          ),
          5_000,
        );
  return { timeoutMs, complexityRoute } as const;
}

function getCached<T>(cache: Map<string, CacheEntry<T>>, key: string) {
  const entry = cache.get(key);

  if (!entry) return null;

  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }

  // Refresh insertion order so the bounded map behaves like a small LRU cache.
  cache.delete(key);
  cache.set(key, entry);
  return entry.value;
}

function setCached<T>(
  cache: Map<string, CacheEntry<T>>,
  key: string,
  value: T,
  ttlMs: number,
  maxEntries: number,
) {
  cache.delete(key);
  cache.set(key, { expiresAt: Date.now() + ttlMs, value });

  while (cache.size > maxEntries) {
    const oldestKey = cache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    cache.delete(oldestKey);
  }
}

function fallback(
  query: string,
  reason: string,
  model: string | null = null,
): QueryRewriteResult {
  return {
    query,
    rewritten: false,
    catalogRelevant: true,
    analysis: {
      sortIntent: "RELEVANCE",
      marketPreference: "ANY",
      intent: "",
      detectedLanguage: "unknown",
      complexity: "SIMPLE",
      confidence: 0,
      verticalFit: "UNCERTAIN",
      productType: "",
      productTypes: [],
      productRelation: "NONE",
      retrievalMode: "DIRECT",
      referenceTerms: [],
      shopLanguageProductType: "",
      category: "",
      subcategory: "",
      brands: [],
      models: [],
      identifiers: [],
      audience: [],
      requiredAttributes: [],
      optionalPreferences: [],
      useCases: [],
      compatibility: [],
      negativeAttributes: [],
      entities: [],
      attributes: [],
      negativeTerms: [],
      semanticExpansions: [],
      shopLanguage: "unknown",
      shopLanguageTerms: [],
      englishTerms: [],
      matchedCatalogTerms: [],
      decisionReason: `LLM analysis unavailable: ${reason}`,
    },
    model,
    fallbackReason: reason,
  };
}

function parseShortString(value: unknown, maxLength: number) {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/\s+/g, " ").trim();
  return cleaned.length <= maxLength ? cleaned : null;
}

function parseShortStringArray(
  value: unknown,
  maxItems: number,
  maxItemLength: number,
) {
  if (!Array.isArray(value)) return [];

  const items: string[] = [];
  for (const item of value.slice(0, maxItems)) {
    if (typeof item !== "string") continue;
    const cleaned = item.replace(/\s+/g, " ").trim().slice(0, maxItemLength);
    if (cleaned) items.push(cleaned);
  }

  return items;
}

function readFastParserOutputFields(outputText: string): string[] {
  try {
    const value = JSON.parse(outputText);
    return value && typeof value === "object" && !Array.isArray(value)
      ? Object.keys(value).sort()
      : [];
  } catch {
    return [];
  }
}

function parseMerchantVerticals(settings: unknown) {
  if (!settings || typeof settings !== "object") return [] as string[];
  const record = settings as Record<string, unknown>;
  const raw =
    record.merchantVerticals ??
    record.merchantVertical ??
    record.storeVerticals ??
    record.storeVertical ??
    [];

  const values = Array.isArray(raw) ? raw : [raw];
  return values
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 5);
}

function looksLikePriceSemantic(value: string) {
  const normalized = normalizeCommerceText(value);
  return (
    /[$â‚¬Â£Â¥â‚«]/.test(value) ||
    /\b(?:vnd|usd|eur|gbp|jpy|dong|price|cost|budget|affordable|cheapest|most expensive|re nhat|dat nhat)\b/.test(
      normalized,
    ) ||
    (/\bgia\b/.test(normalized) && /\d/.test(normalized)) ||
    (/\d/.test(normalized) &&
      /\b(?:duoi|tren|khong qua|khong hon|toi da|toi thieu|it nhat|nhieu nhat|under|below|over|above|at most|at least|between|from|to)\b/.test(
        normalized,
      ))
  );
}

function parseNonPriceStringArray(
  value: unknown,
  maxItems: number,
  maxItemLength: number,
) {
  return parseShortStringArray(value, maxItems, maxItemLength).filter(
    (item) => !looksLikePriceSemantic(item),
  );
}

function parseMandatoryConcepts(value: unknown) {
  if (!Array.isArray(value)) return [] as SemanticMandatoryConcept[];
  const result: SemanticMandatoryConcept[] = [];
  const seen = new Set<string>();
  for (const item of value.slice(0, 5)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const target = parseShortString(record.target, 96);
    const source = parseShortString(record.source, 96);
    if (!target || !source) continue;
    const key = `${normalizeCommerceText(target)}\u0000${normalizeCommerceText(source)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ target, source });
  }
  return result;
}

function normalizeCommerceText(value: string) {
  return value
    .toLocaleLowerCase("vi-VN")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\u0111/g, "d")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Exact commerce instructions are deterministic. Let the LLM interpret them
 * in languages we do not recognize, but never let it turn a numeric boundary
 * such as "under 400k" into an implicit cheapest-first sort.
 */
function resolveSortIntent(
  originalQuery: string,
  llmIntent: QueryRewriteAnalysis["sortIntent"],
) {
  const query = normalizeCommerceText(originalQuery);
  if (
    /\b(?:re nhat|gia tang dan|thap den cao|cheapest|lowest price|price ascending)\b/.test(query)
  ) return "PRICE_ASC" as const;
  if (
    /\b(?:dat nhat|gia giam dan|cao den thap|most expensive|highest price|price descending)\b/.test(query)
  ) return "PRICE_DESC" as const;
  if (/\b(?:cao cap|hang sang|sang trong|premium|luxury)\b/.test(query)) {
    return "PREMIUM" as const;
  }
  if (
    /\b(?:gia re|binh dan|tiet kiem|hop tui tien|affordable|budget|inexpensive|cheap|low cost|value for money|not too expensive|doesn t cost too much|does not cost too much)\b/.test(query)
  ) return "BUDGET" as const;

  const hasNumericBoundary =
    /\d/.test(query) &&
    /\b(?:duoi|tren|khong qua|khong hon|toi da|toi thieu|it nhat|tu|den|under|below|over|above|at most|at least|from|to)\b/.test(query);
  return hasNumericBoundary ? "RELEVANCE" as const : llmIntent;
}

function composeEmbeddingQuery(originalQuery: string, groups: string[][]) {
  const terms: Array<{ raw: string; normalized: string; tokens: Set<string> }> = [];

  for (const value of [originalQuery, ...groups.flat()]) {
    const cleaned = value.replace(/\s+/g, " ").trim();
    const normalized = normalizeCommerceText(cleaned);
    if (!cleaned || !normalized) continue;
    const tokens = new Set(normalized.split(" ").filter(Boolean));
    const redundant = terms.some((existing) => {
      if (existing.normalized === normalized) return true;
      const contributesNewToken = [...tokens].some((token) => !existing.tokens.has(token));
      return !contributesNewToken || existing.normalized.includes(normalized);
    });
    if (redundant) continue;
    terms.push({ raw: cleaned, normalized, tokens });
  }

  // Preserve both language groups; the old 500-character cut could discard
  // the entire translation after the original query and expansions.
  return terms.map((term) => term.raw).join(" | ").trim();
}

export function parseRewrittenQuery(
  outputText: string,
  originalQuery: string,
  selectedShopLanguage: string,
  complexityRoute: "SIMPLE" | "COMPLEX",
): Pick<
  QueryRewriteResult,
  "query" | "rewritten" | "catalogRelevant" | "analysis"
> | null {
  let decoded: unknown;
  try {
    decoded = JSON.parse(outputText);
  } catch {
    return null;
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    return null;
  }

  const parsed = decoded as FastQueryAnalysis;
  const detectedLanguage =
    parseShortString(parsed.detectedLanguage, 32) || "unknown";
  const retrievalMode =
    parsed.retrievalMode === "DIRECT" ||
    parsed.retrievalMode === "DISCOVERY" ||
    parsed.retrievalMode === "COMPLEMENT"
      ? parsed.retrievalMode
      : "DISCOVERY";
  const referenceTerms =
    retrievalMode === "COMPLEMENT"
      ? parseShortStringArray(
          parsed.referenceTerms,
          3,
          96,
        )
      : [];
  const semanticDemand = parseSemanticDemandProfile(parsed.semanticDemand);
  if (!semanticDemand) return null;
  const semanticQuery = renderSemanticDemand(semanticDemand) || parseShortString(parsed.semanticQuery, 240);
  if (!semanticQuery) return null;

  const expansions = parseShortStringArray(parsed.expansions, 6, 96).filter(
    (value) =>
      normalizeCommerceText(value) !== normalizeCommerceText(semanticQuery),
  );
  const semanticMandatoryConcepts = parseMandatoryConcepts(
    parsed.mandatoryConcepts,
  );
  const semanticMustTerms = semanticMandatoryConcepts.map(
    (concept) => concept.target,
  );
  const semanticSourceMustTerms = semanticMandatoryConcepts.map(
    (concept) => concept.source,
  );
  const semanticMustNotTerms =
    hasExplicitNegationIntent(originalQuery)
      ? parseShortStringArray(parsed.mustNotTerms, 2, 96)
      : [];
  // Keep the primary vector focused on the shopper's semantic need.
  // LLM expansions are separate recall branches; concatenating coat + sweater +
  // cardigan + ... into one embedding creates a semantic centroid that is less
  // representative of every individual class.
  const normalizedEmbeddingQuery = semanticQuery;

  const semanticExpansions = [
    semanticQuery,
    ...expansions,
  ];

  return {
    query: normalizedEmbeddingQuery || semanticQuery,
    rewritten:
      normalizeCommerceText(semanticQuery) !== normalizeCommerceText(originalQuery) ||
      expansions.length > 0,
    catalogRelevant: true,
    analysis: {
      sortIntent: "RELEVANCE",
      marketPreference: "ANY",
      semanticDemand,
      semanticMandatoryConcepts,
      intent: normalizedEmbeddingQuery,
      detectedLanguage,
      complexity: complexityRoute,
      confidence: 1,
      verticalFit: "UNCERTAIN",
      productType: "",
      productTypes: [],
      productRelation: "NONE",
      retrievalMode,
      referenceTerms,
      shopLanguageProductType: "",
      category: "",
      subcategory: "",
      brands: [],
      models: [],
      identifiers: [],
      audience: [],
      requiredAttributes: [],
      optionalPreferences: [],
      useCases: [],
      compatibility: [],
      negativeAttributes: [],
      entities: [],
      attributes: [],
      negativeTerms: [],
      semanticExpansions,
      semanticMustTerms,
      semanticSourceMustTerms,
      semanticMustNotTerms,
      shopLanguage: selectedShopLanguage,
      shopLanguageTerms: semanticExpansions,
      englishTerms: [],
      matchedCatalogTerms: [],
      decisionReason:
        "Gemini detected query language and normalized semantic retrieval text to the configured shop language; structured intent remains code-owned.",
    },
  };
}

export async function rewriteSearchQuery({
  shop,
  query,
  searchLanguage: providedSearchLanguage,
}: {
  shop: string;
  query: string;
  searchLanguage?: string | null;
}): Promise<QueryRewriteResult> {
  const requestStartedAt = Date.now();
  const normalizeStartedAt = Date.now();
  const cleanQuery = query.replace(/\s+/g, " ").trim();
  const normalizeCodeMs = Date.now() - normalizeStartedAt;

  if (!cleanQuery) return fallback(cleanQuery, "EMPTY_QUERY");
  if (!isEnabled()) return fallback(cleanQuery, "DISABLED");

  const model = getRewriteModel();
  const backupModel = getOpenAiQueryRewriteModel();
  const settingsStartedAt = Date.now();
  let searchLanguage = providedSearchLanguage?.trim() || null;
  if (!searchLanguage) {
    const shopSettings = await getShopSettings(shop);
    searchLanguage = shopSettings.searchLanguage?.trim() || null;
  }
  const settingsDbMs = Date.now() - settingsStartedAt;
  if (!searchLanguage) {
    return fallback(cleanQuery, "SHOP_LANGUAGE_NOT_CONFIGURED", model);
  }

  const { timeoutMs, complexityRoute } = getRewriteBudget(cleanQuery);
  const startedAt = requestStartedAt;
  const cacheKey = `merchant-language-v4:${searchLanguage}:gemini=${model}:openai=${backupModel || "none"}:${QUERY_REWRITE_CACHE_VERSION}\u0000${shop}\u0000${cleanQuery.toLocaleLowerCase("en-US")}`;
  const cacheLookupStartedAt = Date.now();
  const cached = getCached(rewrittenQueryCache, cacheKey);
  const cacheLookupCodeMs = Date.now() - cacheLookupStartedAt;
  if (cached) {
    console.log("[AI Search] Query rewrite cache hit", {
      shop,
      query: cleanQuery,
      complexityRoute,
      cacheStatus: "HIT",
      model,
      llmMs: 0,
      totalMs: Date.now() - startedAt,
      inputTokens: null,
      outputTokens: null,
      semanticQuery: cached.query,
    });
    return {
      ...cached,
      timing: {
        cacheStatus: "HIT",
        totalMs: Date.now() - startedAt,
        llmMs: 0,
        llmCallCount: 0,
        inputTokens: null,
        outputTokens: null,
        normalizeCodeMs,
        settingsDbMs,
        cacheLookupCodeMs,
        otherCodeMs:
          Math.max(0, Date.now() - startedAt - settingsDbMs),
        timeoutBudgetMs: timeoutMs,
        complexityRoute,
      },
    };
  }

  const pending = pendingRewrites.get(cacheKey);
  if (pending) {
    console.log("[AI Search] Query rewrite joined in-flight request", {
      shop,
      query: cleanQuery,
      complexityRoute,
      cacheStatus: "JOINED",
      model,
    });
    const result = await pending;
    const pendingWaitMs = Date.now() - startedAt - settingsDbMs;
    return {
      ...result,
      timing: {
        cacheStatus: "JOINED",
        totalMs: Date.now() - startedAt,
        llmMs: result.timing?.llmMs ?? 0,
        llmCallCount: 0,
        inputTokens: result.timing?.inputTokens ?? null,
        outputTokens: result.timing?.outputTokens ?? null,
        normalizeCodeMs,
        settingsDbMs,
        cacheLookupCodeMs,
        pendingWaitMs: Math.max(0, pendingWaitMs),
        otherCodeMs: normalizeCodeMs + cacheLookupCodeMs,
        timeoutBudgetMs: timeoutMs,
        complexityRoute,
      },
    };
  }

  const task = performRewrite({ shop, cleanQuery, searchLanguage, model, backupModel, timeoutMs,
    cacheKey, startedAt, normalizeCodeMs, settingsDbMs, cacheLookupCodeMs,
    complexityRoute });
  pendingRewrites.set(cacheKey, task);
  try {
    const taskResult = await task;
    const result = taskResult.fallbackReason
      ? {
          ...taskResult,
          analysis: {
            ...taskResult.analysis,
            complexity: complexityRoute,
          },
        }
      : taskResult;
    if (result.fallbackReason) {
      setCached(
        rewrittenQueryCache,
        cacheKey,
        result,
        readPositiveInteger("AI_SEARCH_QUERY_FALLBACK_CACHE_TTL_MS", 3_000),
        readPositiveInteger("AI_SEARCH_QUERY_REWRITE_CACHE_MAX_ENTRIES", 1_000),
      );
    }
    return result;
  } finally {
    pendingRewrites.delete(cacheKey);
  }
}

async function performRewrite({ shop, cleanQuery, searchLanguage, model, backupModel, timeoutMs,
  cacheKey, startedAt, normalizeCodeMs, settingsDbMs, cacheLookupCodeMs,
  complexityRoute }: {
  shop: string; cleanQuery: string; searchLanguage: string; model: string;
  backupModel: string; timeoutMs: number; cacheKey: string; startedAt: number;
  normalizeCodeMs: number; settingsDbMs: number; cacheLookupCodeMs: number;
  complexityRoute: "SIMPLE" | "COMPLEX";
}): Promise<QueryRewriteResult> {
  let llmStartedAt = Date.now();
  try {
    const instructions = [
      `Detect SHOPPER_QUERY language. Target language: ${searchLanguage}.`,
      `Return detectedLanguage plus semanticQuery and expansions. semanticQuery, expansions, mandatoryConcepts.target, mustNotTerms and referenceTerms MUST all be in target language ${searchLanguage}; translate when needed. mandatoryConcepts.source is the only field allowed to stay in the shopper's original language.`,
      "Choose retrievalMode by source-query relation, not by how broad the catalog term is. Use DIRECT whenever the shopper explicitly names the target product or product class they want (a broad class such as pants, eyewear, jackets or backpacks is still DIRECT). Use DISCOVERY only when the shopper states a need, activity, occasion, recipient, environment or desired outcome without naming the target product class. Use COMPLEMENT only when the shopper asks for a product to pair/use/wear with a referenced item.",
      "For relational shopping queries equivalent to 'what should I wear with X', 'Y to wear with X', 'pair with X', or Vietnamese 'mặc gì với X', use COMPLEMENT and put ONLY the referenced item X in referenceTerms. Never put the requested target Y in referenceTerms. referenceTerms is extraction/translation evidence; do not invent additional referenced products.",
      "In COMPLEMENT mode, mandatoryConcepts belong to the requested TARGET product only. Never copy the reference item or reference-only qualifiers into mandatoryConcepts. Example: for 'what goes well with a navy coat', coat/navy coat/navy describe the reference and must not become target requirements; referenceTerms should identify the coat while expansions describe plausible complementary products.",
      "Return mandatoryConcepts as aligned {target, source} pairs for semantic conditions whose absence makes a product unacceptable. target is the canonical concept in the configured target language; source is the same concept as expressed in the original shopper query. Required target identity, use, season, environment, surface, compatibility, and capability phrases belong here; preferences do not. Example: 'snowboard for summer training on artificial slope' requires aligned pairs for snowboard, summer, and artificial slope.",
      "mandatoryConcepts preserves provenance: each pair MUST describe one and the same concept. Never reorder or pair an identity target with an occasion/context source phrase. Every shopper-explicit required semanticDemand.exactConstraints item (for example color/material/size/measurement/compatibility) must also have an aligned mandatoryConcepts {target, source} pair so code can validate source ownership; this pair is provenance only and does not itself grant exact authority.",
      "Return mustNotTerms ONLY when the shopper explicitly excludes something with wording like without/not/exclude/không/loại trừ. Never infer an exclusion from audience, recipient, occasion, gender, style, or preference.",
      "Keep semanticQuery short and faithful. If the shopper explicitly names a product identity, semanticQuery must preserve that identity. If retrievalMode is DISCOVERY and the shopper does NOT name an exact product identity, semanticQuery must be NEED-FIRST and CATEGORY-NEUTRAL: state the required use/context/attribute without choosing one product family as the answer. Put plausible purchasable product classes only in expansions. Generic 'wear all day' must not become footwear unless the source explicitly mentions feet/shoes/footwear; generic activity/occasion needs must not become apparel unless the source explicitly names wearing/clothing/fashion. Add up to 6 high-value retrieval expansions.",
      "If the shopper names an exact product identity, every expansion must preserve that identity and may only be a direct synonym/equivalent form.",
      "When the shopper names a broad or ambiguous product class, preserve the source breadth during translation: do not narrow it to one subtype. Prefer a neutral canonical retail class for semanticQuery, and include a common retail taxonomy synonym or broader canonical class among expansions when that helps bridge vocabulary. Do not broaden exact brands, models, SKUs, identifiers, or clearly specific product classes.",
      "If the shopper gives a broad category or need without one exact product identity, expansions SHOULD be concrete purchasable product subtypes/classes that naturally satisfy it, not mere paraphrases. Example: when target language is English, Vietnamese 'quần áo mùa đông' should expand to 'winter coat', 'sweater', 'fleece sweatshirt', 'cardigan', 'puffer jacket', 'thermal wear'. Always write retrieval fields in the configured target language, never copy the shopper language into expansions unless it is also the target language.",
      "Preserve the shopper action/domain. Queries meaning wear/dress/mặc must stay in apparel/outfit products. Use gift/giftable intent ONLY when the source explicitly says gift, present, quà, tặng or an equivalent gift action. Recipient phrasing such as 'for someone who likes X' is NOT gift intent by itself; keep it as a preference/recipient need. Do not turn a wear or preference query into gift suggestions or vice versa.",
      "For DISCOVERY requests that name an activity, occasion, environment or recipient need but do NOT explicitly name wearing/clothing/fashion or a product class, keep the primary semanticQuery cross-category and need-first. Do not invent apparel/outfit as the primary family. Individual expansions may include apparel alongside equipment, accessories or other natural product classes when relevant.",
      "Preserve exact brands, models, SKUs, numbers, measurements and negation. Do not invent features.",
      "Also return semanticDemand with string arrays identity, desiredOutcomes, useCases, contexts, qualities, audience, styles, negativeConstraints, exactConstraints. These axes align with product Supply identity, purposes, useCases, contexts, qualities, audience, styles. Use only shopper-owned meaning, in target language. Leave identity empty when the source names no target class; never copy expansions or reference products into it. Audience only if explicit. Put only closed-world exact brand/model/SKU/identifier/compatibility/price/measurements/color/size in exactConstraints, excluded properties in negativeConstraints; do not duplicate those exact-only values in positive axes. Seasons, weather, use cases, desired outcomes and semantic qualities belong on their semantic axes even when explicitly stated; do not move them into exactConstraints merely because they are explicit. Demand constraints are advisory extraction, code owns hard validation. semanticQuery is a natural sentence of the same demand, never a semicolon facet dump.",
      "Return JSON only.",
    ].join(" ");

    const schema = {
      type: "object",
      properties: {
        semanticDemand: semanticDemandSchema,
        detectedLanguage: { type: "string" },
        retrievalMode: {
          type: "string",
          enum: ["DIRECT", "DISCOVERY", "COMPLEMENT"],
        },
        referenceTerms: {
          type: "array",
          items: { type: "string" },
          maxItems: 3,
        },
        semanticQuery: { type: "string" },
        expansions: {
          type: "array",
          items: { type: "string" },
          maxItems: 6,
        },
        mandatoryConcepts: {
          type: "array",
          maxItems: 5,
          items: {
            type: "object",
            properties: {
              target: { type: "string" },
              source: { type: "string" },
            },
            required: ["target", "source"],
            additionalProperties: false,
          },
        },
        mustNotTerms: {
          type: "array",
          items: { type: "string" },
          maxItems: 2,
        },
      },
      required: [
        "semanticDemand",
        "detectedLanguage",
        "retrievalMode",
        "referenceTerms",
        "semanticQuery",
        "expansions",
        "mandatoryConcepts",
        "mustNotTerms",
      ],
      additionalProperties: false,
    };
    llmStartedAt = Date.now();
    const rewriteRequest = {
      model,
      instructions,
      input: `SHOPPER_QUERY:\n${cleanQuery}`,
      schema,
      maxOutputTokens: 900,
      timeoutMs,
      complexityRoute,
    } as const;
    let provider: "GEMINI" | "OPENAI" = "GEMINI";
    let activeModel = model;
    let response:
      | Awaited<ReturnType<typeof generateGeminiQueryRewrite>>
      | Awaited<ReturnType<typeof generateOpenAiQueryRewrite>>;

    try {
      response = await generateGeminiQueryRewrite(rewriteRequest);
      recordGeminiUsageSafe({
        shop,
        operation: "QUERY_REWRITE",
        model,
        requestId: response.requestId,
        inputTokens: response.usage.inputTokens,
        cachedInputTokens: response.usage.cachedInputTokens,
        outputTokens: response.usage.outputTokens,
        totalTokens: response.usage.totalTokens,
      });
    } catch (primaryError) {
      if (!shouldUseOpenAiRewriteBackup(primaryError)) {
        throw primaryError;
      }

      provider = "OPENAI";
      activeModel = backupModel;
      console.warn("[AI Search] Gemini rewrite unavailable; using OpenAI backup", {
        shop,
        query: cleanQuery,
        geminiModel: model,
        openAiModel: backupModel,
        reason:
          primaryError instanceof Error
            ? primaryError.message.slice(0, 300)
            : String(primaryError).slice(0, 300),
      });

      const openAiResponse = await generateOpenAiQueryRewrite({
        model: backupModel,
        instructions,
        input: rewriteRequest.input,
        schema,
        maxOutputTokens: rewriteRequest.maxOutputTokens,
        timeoutMs,
      });
      response = openAiResponse;
      recordOpenAiUsageSafe({
        shop,
        operation: "QUERY_REWRITE",
        model: backupModel,
        requestId: openAiResponse.requestId,
        inputTokens: openAiResponse.usage.inputTokens,
        cachedInputTokens: openAiResponse.usage.cachedInputTokens,
        outputTokens: openAiResponse.usage.outputTokens,
        totalTokens: openAiResponse.usage.totalTokens,
        headers: openAiResponse.headers,
      });
    }

    const llmDurationMs =
      Date.now() - llmStartedAt;
    if (
      ["1", "true", "yes", "on"].includes(
        process.env.AI_SEARCH_LOG_LLM_CONTRACT?.trim().toLowerCase() ?? "",
      )
    ) {
      console.log("[AI Search][LLM CONTRACT] Query rewrite result", {
        shop,
        provider,
        model: activeModel,
        responseStatus: response.status,
        finishReason: response.finishReason,
        outputTextLength: response.outputText.length,
        outputText: response.outputText,
        parseInput: response.outputText,
      });
    }
    if (response.status !== "completed") {
      const reason = response.finishReason === "MAX_TOKENS"
        ? "LLM_OUTPUT_TRUNCATED" : "LLM_INCOMPLETE";
      console.warn("[AI Search] Query rewrite incomplete", {
        shop, provider, model: activeModel, reason, llmDurationMs, usage: response.usage,
      });
      return {
        ...fallback(cleanQuery, reason, activeModel),
        timing: {
          cacheStatus: "MISS", totalMs: Date.now() - startedAt,
          llmMs: llmDurationMs, llmCallCount: 1,
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
          timeoutBudgetMs: timeoutMs,
          complexityRoute,
        },
      };
    }
    const responseParseStartedAt = Date.now();
    const fastParserOutputFields = readFastParserOutputFields(
      response.outputText,
    );
    const parsed = parseRewrittenQuery(
      response.outputText,
      cleanQuery,
      searchLanguage,
      complexityRoute,
    );
    const responseParseCodeMs = Date.now() - responseParseStartedAt;
    if (!parsed) {
      console.warn("[AI Search] Structured LLM output rejected", {
        shop,
        provider,
        model: activeModel,
        query: cleanQuery,
        outputPreview: response.outputText.slice(0, 1_000),
      });
      return {
        ...fallback(cleanQuery, "INVALID_LLM_OUTPUT", activeModel),
        timing: {
          cacheStatus: "MISS", totalMs: Date.now() - startedAt,
          llmMs: llmDurationMs, llmCallCount: 1,
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
          normalizeCodeMs, settingsDbMs, cacheLookupCodeMs,
          responseParseCodeMs,
          otherCodeMs: Math.max(0, Date.now() - startedAt - llmDurationMs - settingsDbMs),
          timeoutBudgetMs: timeoutMs,
          complexityRoute,
        },
      };
    }

    const result: QueryRewriteResult = {
      ...parsed,
      model: activeModel,
      fallbackReason: null,
      timing: {
        cacheStatus: "MISS",
        totalMs: Date.now() - startedAt,
        llmMs: llmDurationMs,
        llmCallCount: 1,
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        normalizeCodeMs,
        settingsDbMs,
        cacheLookupCodeMs,
        responseParseCodeMs,
        timeoutBudgetMs: timeoutMs,
        complexityRoute,
      },
    };

    const cacheWriteStartedAt = Date.now();
    setCached(
      rewrittenQueryCache,
      cacheKey,
      result,
      readPositiveInteger("AI_SEARCH_QUERY_REWRITE_CACHE_TTL_MS", 86_400_000),
      readPositiveInteger("AI_SEARCH_QUERY_REWRITE_CACHE_MAX_ENTRIES", 1_000),
    );
    const cacheWriteCodeMs = Date.now() - cacheWriteStartedAt;
    result.timing = {
      ...result.timing!,
      cacheWriteCodeMs,
      otherCodeMs: Math.max(
        0,
        Date.now() - startedAt - llmDurationMs - settingsDbMs,
      ),
      timeoutBudgetMs: timeoutMs,
      complexityRoute,
    };

    console.log("[AI Search] Query rewrite completed", {
      shop,
      query: cleanQuery,
      complexityRoute,
      cacheStatus: "MISS",
      provider,
      model: activeModel,
      llmMs: llmDurationMs,
      totalMs: Date.now() - startedAt,
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      semanticQuery: result.query,
      fastParserOutputFields,
      timeoutMs,
    });

    return result;
  } catch (error) {
    console.warn("[AI Search] Query rewrite failed; using original query", {
      shop,
      query: cleanQuery,
      complexityRoute,
      cacheStatus: "MISS",
      model,
      timeoutMs,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    });

    const llmDurationMs = Date.now() - llmStartedAt;
    const reason = error instanceof Error &&
      (error.name === "APIConnectionTimeoutError" || /timed?\s*out|timeout/i.test(error.message))
      ? "LLM_TIMEOUT" : "LLM_ERROR";
    return {
      ...fallback(cleanQuery, reason, model),
      timing: {
        cacheStatus: "MISS", totalMs: Date.now() - startedAt,
        llmMs: llmDurationMs, llmCallCount: 1,
        inputTokens: null, outputTokens: null,
        normalizeCodeMs, settingsDbMs, cacheLookupCodeMs,
        otherCodeMs: Math.max(0, Date.now() - startedAt - llmDurationMs - settingsDbMs),
        timeoutBudgetMs: timeoutMs,
        complexityRoute,
      },
    };
  }
}
