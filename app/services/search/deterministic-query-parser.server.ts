import { parsePriceConstraint } from "./query-constraints.server";
import {
  QUERY_PARSER_VERSION,
  type AttributeConstraint,
  type QueryConstraint,
} from "./query-plan.server";

export function normalizeQueryText(value: string) {
  return value
    .toLocaleLowerCase("vi-VN")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeUnicodeQueryText(value: string) {
  return value
    .toLocaleLowerCase("vi-VN")
    .normalize("NFC")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function constraint(value: string, mode: QueryConstraint["mode"]): QueryConstraint {
  return {
    value,
    normalizedValue: normalizeQueryText(value),
    mode,
    confidence: 1,
    source: "CODE",
  };
}

export type DeterministicQueryParse = {
  normalizedQuery: string;
  price?: { min?: number; max?: number; currency?: string };
  marketPreference: "ANY" | "BUDGET" | "PREMIUM";
  relation: "SINGLE" | "ANY" | "ALL";
  sort: { field: "RELEVANCE" | "PRICE" | "NEWEST"; direction?: "ASC" | "DESC" };
  measurements: AttributeConstraint[];
  negatives: QueryConstraint[];
  requiredMarkers: string[];
  preferredMarkers: string[];
  consumedTerms: string[];
  hasComplexRelation: boolean;
  hasConflictingConstraints: boolean;
  version: string;
};

export function parseDeterministicQuery(query: string): DeterministicQueryParse {
  const normalizedQuery = normalizeQueryText(query);
  const numericPrice = parsePriceConstraint(query);
  const price = numericPrice
    ? {
        ...(numericPrice.min != null ? { min: numericPrice.min } : {}),
        ...(numericPrice.max != null ? { max: numericPrice.max } : {}),
        ...(numericPrice.currencyCode ? { currency: numericPrice.currencyCode } : {}),
      }
    : undefined;

  let sort: DeterministicQueryParse["sort"] = { field: "RELEVANCE" };
  if (/\b(?:re nhat|gia tang dan|thap den cao|cheapest|lowest price)\b/.test(normalizedQuery)) {
    sort = { field: "PRICE", direction: "ASC" };
  } else if (/\b(?:dat nhat|gia giam dan|cao den thap|most expensive|highest price)\b/.test(normalizedQuery)) {
    sort = { field: "PRICE", direction: "DESC" };
  } else if (/\b(?:moi nhat|hang moi|newest|latest)\b/.test(normalizedQuery)) {
    sort = { field: "NEWEST", direction: "DESC" };
  }

  const budget = /\b(?:gia re|binh dan|tiet kiem|hop tui tien|budget|affordable|value for money)\b/.test(normalizedQuery);
  const premium = /\b(?:cao cap|hang sang|luxury|premium)\b/.test(normalizedQuery);
  const marketPreference = budget ? "BUDGET" : premium ? "PREMIUM" : "ANY";

  const hasAny = /\b(?:hoac|or|either)\b/.test(normalizedQuery);
  const hasAll = /\b(?:va|and|kem theo|bo gom)\b/.test(normalizedQuery);
  const relation = hasAny ? "ANY" : hasAll ? "ALL" : "SINGLE";

  const measurements: AttributeConstraint[] = [];
  const measurementPattern = /\b(?:size\s*\d+(?:[.,]\d+)?|\d+(?:[.,]\d+)?\s*(?:ml|l|gb|tb|inch|cm|mm|kg|g|w|mah)|xl|xxl)\b/giu;
  for (const match of query.matchAll(measurementPattern)) {
    const raw = match[0].replace(/\s+/g, " ").trim();
    measurements.push({
      ...constraint(raw, "MUST"),
      name: /size/i.test(raw) || /xl/i.test(raw) ? "size" : "measurement",
    });
  }

  const negatives: QueryConstraint[] = [];
  const negativePattern = /\b(?:khong phai|khong mau|khong|loai tru|ngoai tru|without|except|not)\s+([^,;]+?)(?=\s+(?:va|hoac|nhung|phai|cang|and|or|but)\b|[,;]|$)/giu;
  for (const match of normalizedQuery.matchAll(negativePattern)) {
    const value = match[1]?.trim();
    if (value) negatives.push(constraint(value, "MUST_NOT"));
  }

  const requiredMarkers = /\b(?:bat buoc|phai co|must|required)\b/.test(normalizedQuery)
    ? ["explicit-required"]
    : [];
  const preferredMarkers = /\b(?:cang tot|neu co|uu tien|prefer|ideally)\b/.test(normalizedQuery)
    ? ["explicit-preferred"]
    : [];

  const consumedTerms = [
    ...(price ? ["price"] : []),
    ...(sort.field !== "RELEVANCE" ? ["sort"] : []),
    ...(marketPreference !== "ANY" ? ["marketPreference"] : []),
    ...measurements.map((item) => item.normalizedValue || item.value),
    ...negatives.map((item) => item.normalizedValue || item.value),
  ];

  return {
    normalizedQuery,
    ...(price ? { price } : {}),
    marketPreference,
    relation,
    sort,
    measurements,
    negatives,
    requiredMarkers,
    preferredMarkers,
    consumedTerms,
    hasComplexRelation: (hasAny && hasAll) || negatives.length > 1,
    hasConflictingConstraints: budget && premium,
    version: QUERY_PARSER_VERSION,
  };
}
