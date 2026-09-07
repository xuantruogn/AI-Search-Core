export type SearchEngine = "AI" | "NATIVE";

export type SearchRouteDecision = {
  engine: SearchEngine;
  reason: string;
  query: string;
  nativeSearchPath: string | null;
  resourceTypes: string[];
};

type ClassifySearchRequestOptions = {
  query: string;
  nativeSearchTarget?: string | null;
  maxQueryChars?: number;
  minSemanticQueryChars?: number;
};

const SAFE_SEARCH_PARAMS = new Set([
  "q",
  "type",
  "page",
  "sort_by",
  "options[prefix]",
]);

const NATIVE_ONLY_PARAM_PREFIXES = [
  "filter.",
  "filter[",
  "filter%5b",
  "t.category",
];

const NATIVE_ONLY_PARAMS = new Set([
  "constraint",
  "product_type",
  "vendor",
  "tag",
  "view",
  "section_id",
  "sections",
  "options[unavailable_products]",
]);

function unique(values: string[]) {
  return [...new Set(values)];
}

function native(
  reason: string,
  query: string,
  nativeSearchPath: string | null,
  resourceTypes: string[] = [],
): SearchRouteDecision {
  return {
    engine: "NATIVE",
    reason,
    query,
    nativeSearchPath,
    resourceTypes,
  };
}

function ai(
  query: string,
  nativeSearchPath: string,
  resourceTypes: string[],
): SearchRouteDecision {
  return {
    engine: "AI",
    reason: "SEMANTIC_PRODUCT_SEARCH",
    query,
    nativeSearchPath,
    resourceTypes,
  };
}

function parseNativeSearchTarget(target?: string | null): URL | null {
  if (!target || !target.startsWith("/") || target.startsWith("//")) {
    return null;
  }

  if (target.includes("..")) return null;

  try {
    const parsed = new URL(target, "https://shop.invalid");
    if (!/\/search\/?$/i.test(parsed.pathname)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function readResourceTypes(url: URL): string[] {
  return unique(
    url.searchParams
      .getAll("type")
      .flatMap((value) => value.split(","))
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
}

function hasNativeOnlyParams(url: URL): string | null {
  for (const [rawKey] of url.searchParams) {
    const key = rawKey.toLowerCase();

    if (NATIVE_ONLY_PARAMS.has(key)) return rawKey;
    if (NATIVE_ONLY_PARAM_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      return rawKey;
    }

    if (!SAFE_SEARCH_PARAMS.has(rawKey)) {
      // Unknown search parameters can alter theme/search behaviour. Preserve
      // Shopify rather than silently dropping semantics the AI layer does not
      // understand.
      return rawKey;
    }
  }

  return null;
}

function looksLikeAdvancedShopifySyntax(query: string) {
  if (/\*/.test(query)) return true;
  if (/\b(?:AND|OR|NOT)\b/.test(query)) return true;
  if (/^[^\s:]+:[^\s]+/.test(query) || /\s[^\s:]+:[^\s]+/.test(query)) {
    return true;
  }
  if (/^(["']).+\1$/.test(query)) return true;
  return false;
}

export function looksLikeExactIdentifier(query: string) {
  const compact = query.trim();
  if (!compact || /\s/.test(compact)) return false;

  // Numeric product codes / barcodes / IDs. Three digits is intentionally low
  // because merchants commonly use short internal part numbers.
  if (/^\d{3,18}$/.test(compact)) return true;

  // Punctuation-separated numeric codes such as 123-456 or 12/345/67.
  if (/^[\d._\-/#:]+$/.test(compact)) {
    const digits = compact.replace(/\D/g, "");
    if (digits.length >= 3) return true;
  }

  const hasLetter = /[A-Za-z]/.test(compact);
  const hasDigit = /\d/.test(compact);
  if (!hasLetter || !hasDigit) return false;

  // SKU/model/variant-like token: A12, ABC-123, iPhone15, X_500-Pro.
  if (/^[A-Za-z0-9._\-/#:]{2,64}$/.test(compact)) return true;

  return false;
}

export function classifySearchRequest({
  query,
  nativeSearchTarget,
  maxQueryChars = 500,
  minSemanticQueryChars = 3,
}: ClassifySearchRequestOptions): SearchRouteDecision {
  const normalizedQuery = query.trim();
  const parsed = parseNativeSearchTarget(nativeSearchTarget);
  const nativePath = parsed ? `${parsed.pathname}${parsed.search}` : null;

  if (!normalizedQuery) {
    return native("EMPTY_QUERY", normalizedQuery, nativePath);
  }

  if (normalizedQuery.length > maxQueryChars) {
    return native("QUERY_TOO_LONG", normalizedQuery, nativePath);
  }

  if (normalizedQuery.length < minSemanticQueryChars) {
    return native("QUERY_TOO_SHORT_FOR_SEMANTIC", normalizedQuery, nativePath);
  }

  if (looksLikeExactIdentifier(normalizedQuery)) {
    return native("EXACT_IDENTIFIER_QUERY", normalizedQuery, nativePath);
  }

  if (looksLikeAdvancedShopifySyntax(normalizedQuery)) {
    return native("SHOPIFY_QUERY_SYNTAX", normalizedQuery, nativePath);
  }

  if (!parsed) {
    // App Proxy should be reached through the theme bridge. Without the native
    // target we cannot prove search resource type/filter/sort semantics.
    return native("NATIVE_SEARCH_CONTEXT_MISSING", normalizedQuery, null);
  }

  const resourceTypes = readResourceTypes(parsed);
  if (resourceTypes.length !== 1 || resourceTypes[0] !== "product") {
    return native(
      resourceTypes.length === 0
        ? "SEARCH_TYPES_UNSCOPED"
        : "SEARCH_TYPES_NOT_PRODUCT_ONLY",
      normalizedQuery,
      nativePath,
      resourceTypes,
    );
  }

  const unsupportedParam = hasNativeOnlyParams(parsed);
  if (unsupportedParam) {
    return native(
      `UNSUPPORTED_SEARCH_PARAM:${unsupportedParam}`,
      normalizedQuery,
      nativePath,
      resourceTypes,
    );
  }

  const pageRaw = parsed.searchParams.get("page");
  if (pageRaw) {
    const page = Number.parseInt(pageRaw, 10);
    if (!Number.isSafeInteger(page) || page < 1) {
      return native("INVALID_PAGE", normalizedQuery, nativePath, resourceTypes);
    }
  }

  const sortBy = parsed.searchParams.get("sort_by")?.trim().toLowerCase();
  if (sortBy && sortBy !== "relevance") {
    return native("NON_RELEVANCE_SORT", normalizedQuery, nativePath, resourceTypes);
  }

  const prefix = parsed.searchParams.get("options[prefix]")?.trim().toLowerCase();
  if (prefix && prefix !== "last" && prefix !== "none") {
    return native("UNSUPPORTED_PREFIX_MODE", normalizedQuery, nativePath, resourceTypes);
  }

  return ai(
    normalizedQuery,
    `${parsed.pathname}${parsed.search}`,
    resourceTypes,
  );
}
