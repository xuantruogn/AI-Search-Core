import { normalizeQueryText } from "./deterministic-query-parser.server";
import type { DictionaryEntry, ShopSearchDictionary } from "./shop-search-dictionary.server";

export type CatalogTermMatch = {
  text: string;
  entry: DictionaryEntry;
  confidence: number;
  matchType: "EXACT" | "NORMALIZED" | "ALIAS" | "FUZZY";
  start: number;
  end: number;
};

const FIELD_PRIORITY: Record<string, number> = {
  IDENTIFIER: 100,
  MODEL: 90,
  BRAND: 85,
  PRODUCT_TYPE: 80,
  CATEGORY: 70,
  AUDIENCE: 60,
  MEASUREMENT: 55,
  ATTRIBUTE: 50,
  COMPATIBILITY: 45,
  CONTEXT: 30,
  ALIAS: 20,
};

const NESTED_FACT_FIELDS = new Set([
  "IDENTIFIER",
  "MODEL",
  "BRAND",
  "AUDIENCE",
  "MEASUREMENT",
  "ATTRIBUTE",
  "COMPATIBILITY",
  "CONTEXT",
]);

function normalizeUnicodeTokens(value: string) {
  return value
    .toLocaleLowerCase("vi-VN")
    .normalize("NFC")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

function phraseTokenSpan(queryTokens: string[], phrase: string) {
  const phraseTokens = phrase.split(" ").filter(Boolean);
  if (phraseTokens.length === 0) return null;
  for (let start = 0; start <= queryTokens.length - phraseTokens.length; start += 1) {
    if (phraseTokens.every((token, offset) => queryTokens[start + offset] === token)) {
      return { start, end: start + phraseTokens.length };
    }
  }
  return null;
}

function editDistanceAtMostOne(left: string, right: string) {
  if (Math.abs(left.length - right.length) > 1) return false;
  let edits = 0;
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) { i += 1; j += 1; continue; }
    edits += 1;
    if (edits > 1) return false;
    if (left.length > right.length) i += 1;
    else if (right.length > left.length) j += 1;
    else { i += 1; j += 1; }
  }
  return edits + (i < left.length || j < right.length ? 1 : 0) <= 1;
}

export function matchCatalogTerms(
  query: string,
  dictionary: ShopSearchDictionary,
): CatalogTermMatch[] {
  const normalizedQuery = normalizeQueryText(query);
  const queryTokens = normalizedQuery.split(" ").filter(Boolean);
  const unicodeQueryTokens = normalizeUnicodeTokens(query);
  const matches: CatalogTermMatch[] = [];
  const occupied = new Set<number>();

  for (const entry of dictionary.entries.slice().sort((a, b) => {
    // Identity-like phrases beat attributes/tags, then longest phrase wins.
    // This prevents "chain" from occupying the first token of the stronger
    // synonym "chain breaker", while still preventing a noisy long TAG from
    // shadowing a real product identity.
    const identityFields = new Set(["IDENTIFIER", "MODEL", "BRAND", "PRODUCT_TYPE"]);
    const identityTierDelta =
      Number(identityFields.has(b.field)) - Number(identityFields.has(a.field));
    const tokenDelta =
      b.normalized.split(" ").length - a.normalized.split(" ").length;
    const confidenceDelta = (b.confidence ?? 1) - (a.confidence ?? 1);
    const priorityDelta =
      (FIELD_PRIORITY[b.field] ?? 0) - (FIELD_PRIORITY[a.field] ?? 0);
    return identityTierDelta || tokenDelta || confidenceDelta || priorityDelta;
  })) {
    const span = phraseTokenSpan(queryTokens, entry.normalized);
    if (!span) continue;

    // Do not let diacritic folding turn a foreign-language source token into
    // an unrelated shop-language catalog term. Examples: Vietnamese
    // "hạt" -> English "hat", "màn" -> "man", "có" -> brand/vendor "Co".
    // The translated/LLM pass may still match the catalog term later.
    const rawUnicodeSpan = unicodeQueryTokens
      .slice(span.start, span.end)
      .join(" ");
    const foldedUnicodeSpan = normalizeQueryText(rawUnicodeSpan);
    const canonicalUnicode = normalizeUnicodeTokens(entry.canonical).join(" ");
    const aliasUnicode = (entry.aliases ?? []).map((alias) =>
      normalizeUnicodeTokens(alias).join(" "),
    );
    const sourceLostDiacritics =
      rawUnicodeSpan &&
      rawUnicodeSpan !== foldedUnicodeSpan &&
      foldedUnicodeSpan === entry.normalized;
    const catalogActuallyUsesSourceSpelling =
      canonicalUnicode === rawUnicodeSpan ||
      aliasUnicode.includes(rawUnicodeSpan);
    if (sourceLostDiacritics && !catalogActuallyUsesSourceSpelling) continue;

    const spanIndexes = Array.from(
      { length: span.end - span.start },
      (_, index) => span.start + index,
    );
    const overlapsPrimaryMatch = spanIndexes.some((index) => occupied.has(index));
    const containingProductIdentity = overlapsPrimaryMatch
      ? matches.find(
          (match) =>
            match.entry.field === "PRODUCT_TYPE" &&
            span.start >= match.start &&
            span.end <= match.end &&
            span.end - span.start < match.end - match.start,
        )
      : null;
    const allowNestedFact = Boolean(
      containingProductIdentity && NESTED_FACT_FIELDS.has(entry.field),
    );

    if (overlapsPrimaryMatch && !allowNestedFact) continue;
    if (
      allowNestedFact &&
      matches.some(
        (match) =>
          match.entry.field === entry.field &&
          match.start === span.start &&
          match.end === span.end,
      )
    ) {
      continue;
    }
    if (!allowNestedFact) {
      for (const index of spanIndexes) occupied.add(index);
    }

    const sourceConfidence = Math.max(0, Math.min(entry.confidence ?? 1, 1));
    matches.push({
      text: entry.normalized,
      entry,
      confidence: (entry.field === "ALIAS" ? 0.94 : 1) * sourceConfidence,
      matchType: entry.field === "ALIAS" ? "ALIAS" : "NORMALIZED",
      ...span,
    });
  }

  for (const [index, token] of queryTokens.entries()) {
    if (token.length < 5 || occupied.has(index)) continue;
    const candidates = dictionary.entries.filter(
      (entry) =>
        ["BRAND", "MODEL"].includes(entry.field) &&
        !entry.normalized.includes(" ") &&
        editDistanceAtMostOne(token, entry.normalized),
    );
    if (candidates.length !== 1) continue;
    const entry = candidates[0];
    const sourceConfidence = Math.max(0, Math.min(entry.confidence ?? 1, 1));
    matches.push({
      text: token,
      entry,
      confidence: 0.9 * sourceConfidence,
      matchType: "FUZZY",
      start: index,
      end: index + 1,
    });
  }

  return matches;
}
