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
  ATTRIBUTE: 50,
  COMPATIBILITY: 45,
  CONTEXT: 30,
  ALIAS: 20,
};

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
  const matches: CatalogTermMatch[] = [];
  const occupied = new Set<number>();

  for (const entry of dictionary.entries.slice().sort((a, b) => {
    const tokenDelta = b.normalized.split(" ").length - a.normalized.split(" ").length;
    return tokenDelta || (FIELD_PRIORITY[b.field] ?? 0) - (FIELD_PRIORITY[a.field] ?? 0);
  })) {
    const span = phraseTokenSpan(queryTokens, entry.normalized);
    if (!span) continue;
    if (Array.from({ length: span.end - span.start }, (_, index) => span.start + index)
      .some((index) => occupied.has(index))) continue;
    for (let index = span.start; index < span.end; index += 1) occupied.add(index);
    matches.push({
      text: entry.normalized,
      entry,
      confidence: entry.field === "ALIAS" ? 0.94 : 1,
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
    matches.push({ text: token, entry: candidates[0], confidence: 0.9, matchType: "FUZZY", start: index, end: index + 1 });
  }

  return matches;
}
