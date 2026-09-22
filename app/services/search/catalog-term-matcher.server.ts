import { normalizeQueryText } from "./deterministic-query-parser.server";
import type { DictionaryEntry, ShopSearchDictionary } from "./shop-search-dictionary.server";

export type CatalogTermMatch = {
  text: string;
  entry: DictionaryEntry;
  confidence: number;
  matchType: "EXACT" | "NORMALIZED" | "ALIAS" | "FUZZY";
};

function containsPhrase(query: string, phrase: string) {
  return (` ${query} `).includes(` ${phrase} `);
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
  const matches: CatalogTermMatch[] = [];
  const occupied = new Set<string>();

  for (const entry of dictionary.entries.slice().sort((a, b) => b.normalized.length - a.normalized.length)) {
    if (!containsPhrase(normalizedQuery, entry.normalized)) continue;
    if (
      matches.some(
        (match) =>
          match.entry.field === entry.field &&
          containsPhrase(match.text, entry.normalized),
      )
    ) continue;
    const key = `${entry.field}\u0000${entry.normalized}`;
    if (occupied.has(key)) continue;
    occupied.add(key);
    matches.push({
      text: entry.normalized,
      entry,
      confidence: entry.field === "ALIAS" ? 0.94 : 1,
      matchType: entry.field === "ALIAS" ? "ALIAS" : "NORMALIZED",
    });
  }

  const queryTokens = normalizedQuery.split(" ").filter(Boolean);
  for (const token of queryTokens) {
    if (token.length < 5 || matches.some((match) => match.text.split(" ").includes(token))) continue;
    const candidates = dictionary.entries.filter(
      (entry) =>
        ["BRAND", "MODEL"].includes(entry.field) &&
        !entry.normalized.includes(" ") &&
        editDistanceAtMostOne(token, entry.normalized),
    );
    if (candidates.length !== 1) continue;
    matches.push({ text: token, entry: candidates[0], confidence: 0.9, matchType: "FUZZY" });
  }

  return matches;
}
