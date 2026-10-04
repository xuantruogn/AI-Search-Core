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

function identityTokenVariants(token: string) {
  const variants = new Set([token]);
  if (token.length < 4) return variants;
  if (token.endsWith("ies") && token.length > 4) {
    variants.add(token.slice(0, -3) + "y");
  }
  if (token.endsWith("es") && token.length > 4) {
    variants.add(token.slice(0, -2));
  }
  if (token.endsWith("s") && !token.endsWith("ss") && token.length > 3) {
    variants.add(token.slice(0, -1));
  }
  return variants;
}

function identityTokenEquals(left: string, right: string) {
  if (left === right) return true;
  const leftVariants = identityTokenVariants(left);
  const rightVariants = identityTokenVariants(right);
  return [...leftVariants].some((value) => rightVariants.has(value));
}

function phraseTokenSpan(
  queryTokens: string[],
  phrase: string,
  allowIdentityMorphology = false,
) {
  const phraseTokens = phrase.split(" ").filter(Boolean);
  if (phraseTokens.length === 0) return null;
  for (let start = 0; start <= queryTokens.length - phraseTokens.length; start += 1) {
    if (
      phraseTokens.every((token, offset) =>
        allowIdentityMorphology
          ? identityTokenEquals(queryTokens[start + offset], token)
          : queryTokens[start + offset] === token,
      )
    ) {
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

  const candidateSet = new Set<DictionaryEntry>();
  for (const token of queryTokens) {
    for (const key of identityTokenVariants(token)) {
      for (const entry of dictionary.matchIndex.byFirstToken.get(key) ?? []) {
        candidateSet.add(entry);
      }
    }
  }
  const candidates = [...candidateSet].sort(
    (left, right) =>
      (dictionary.matchIndex.rank.get(left) ?? Number.MAX_SAFE_INTEGER) -
      (dictionary.matchIndex.rank.get(right) ?? Number.MAX_SAFE_INTEGER),
  );

  for (const entry of candidates) {
    const span = phraseTokenSpan(
      queryTokens,
      entry.normalized,
      ["PRODUCT_TYPE", "CATEGORY"].includes(entry.field),
    );
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
      // Preserve the actual query span. entry.normalized can differ through
      // identity morphology ("basket" -> "baskets"); using the catalog form
      // here leaves the real source token falsely unresolved and triggers an
      // unnecessary LLM rewrite.
      text: queryTokens.slice(span.start, span.end).join(" "),
      entry,
      confidence: (entry.field === "ALIAS" ? 0.94 : 1) * sourceConfidence,
      matchType: entry.field === "ALIAS" ? "ALIAS" : "NORMALIZED",
      ...span,
    });
  }

  for (const [index, token] of queryTokens.entries()) {
    if (token.length < 5 || occupied.has(index)) continue;
    const fuzzySafeFields = new Set([
      "PRODUCT_TYPE", "CATEGORY", "ALIAS",
    ]);
    const fuzzyCandidates = [
      ...(dictionary.matchIndex.fuzzySingleTokenByLength.get(token.length - 1) ?? []),
      ...(dictionary.matchIndex.fuzzySingleTokenByLength.get(token.length) ?? []),
      ...(dictionary.matchIndex.fuzzySingleTokenByLength.get(token.length + 1) ?? []),
    ].filter(
      (entry) =>
        fuzzySafeFields.has(entry.field) &&
        editDistanceAtMostOne(token, entry.normalized),
    );
    const uniqueCandidates = [...new Set(fuzzyCandidates)];
    if (uniqueCandidates.length !== 1) continue;
    const entry = uniqueCandidates[0];
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
