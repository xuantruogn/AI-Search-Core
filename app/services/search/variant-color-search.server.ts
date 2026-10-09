import type { QueryRewriteResult } from "./query-rewriter.server";
import { normalizeSemanticValue } from "./semantic-normalization.server";
import { currentTargetColors } from "./shop-context-index.server";
import {
  loadProductVariantSelections,
  loadProductSemanticRows,
  type IndexedVariantSelection,
} from "./product-semantic-profile.server";
import { parseDeterministicQuery } from "./deterministic-query-parser.server";

const TRANSLATED_COLORS: Record<string, string> = {
  "do": "red", "đo": "red", "mau do": "red", "mau đo": "red",
  "den": "black", "mau den": "black",
  "trang": "white", "mau trang": "white",
  "xanh duong": "blue", "xanh da troi": "blue",
  "xanh la": "green", "xanh la cay": "green",
  "vang": "yellow", "hong": "pink", "tim": "purple",
  "cam": "orange", "nau": "brown", "xam": "gray",
  "gris": "gray", "rouge": "red", "rojo": "red",
  "azul": "blue", "bleu": "blue", "negro": "black",
};
const COLOR_OPTION_NAME = /^(?:color|colour|shade|colorway|mau|mau sac|couleur|farbe)$/i;
const SIZE_OPTION_NAME = /^(?:size|co|kich co|taille|shoe size|sizes)$/i;

function canonicalColor(raw: string): string {
  const key = normalizeSemanticValue(raw);
  const mapped = TRANSLATED_COLORS[key] ?? key;
  return mapped === "grey" ? "gray" : mapped;
}

// Base-color requests can include explicit shades/patterns, not arbitrary
// merchant shade names. Specific shades remain exact (navy != sky blue).
const BASE_COLORS = new Set(['red', 'blue', 'green', 'black', 'white', 'yellow', 'pink', 'purple', 'orange', 'brown', 'gray']);
const SHADE_FAMILIES: Record<string, string> = {
  navy: 'blue', maroon: 'red', burgundy: 'red', olive: 'green', charcoal: 'gray',
  cream: 'white', ivory: 'white', rose: 'pink', tan: 'brown', beige: 'brown', khaki: 'brown',
};
export function compareTypedColor(actual: string, requested: string): 'MATCH' | 'MISMATCH' | 'UNKNOWN' {
  const value = canonicalColor(actual), target = canonicalColor(requested);
  if (value === target) return 'MATCH';
  const tokens = value.split(' ');
  // Preserve a named shade inside a pattern/composite without equating it
  // with another shade (Navy/White contains Navy, Sky Blue does not).
  if (!BASE_COLORS.has(target)) return (` ${value} `.includes(` ${target} `)) ? 'MATCH' : 'MISMATCH';
  const families = tokens.map(token => SHADE_FAMILIES[token] ?? token).filter(token => BASE_COLORS.has(token));
  if (families.includes(target)) return 'MATCH';
  return families.length ? 'MISMATCH' : 'UNKNOWN';
}

export function verifyTypedProductColor(
  terms: Array<{ kind: string; value: string }>, request: VariantRequest,
): VariantProductVerdict {
  const readColors = (kind: string) => terms.filter(t => t.kind === kind).flatMap(t => {
    const match = t.value.match(/^\s*(.+?)\s*[=:]\s*(.+?)\s*$/);
    return match && COLOR_OPTION_NAME.test(normalizeSemanticValue(match[1])) ? [match[2]] : [];
  });
  const optionColors = readColors('VARIANT_OPTION');
  // Raw Shopify options outrank possibly stale/enriched ATTRIBUTE colors.
  const colors = optionColors.length ? optionColors : readColors('ATTRIBUTE');
  if (!colors.length) return { state: 'UNKNOWN' };
  const verdicts = colors.map(value => compareTypedColor(value, request.color));
  if (verdicts.includes('MATCH')) {
    // Product-level facets cannot prove color+size share one variant.
    return request.size === null ? { state: 'COLOR_MATCH' } : { state: 'UNKNOWN' };
  }
  return verdicts.includes('UNKNOWN') ? { state: 'UNKNOWN' } : { state: 'MISMATCH' };
}
function canonicalSize(raw: string): string {
  const value = normalizeSemanticValue(raw)
    .replace(/^(?:size|cỡ|co|taille)\s*[=:]?\s*/i, "")
    .trim();
  const common: Record<string, string> = {
    small: "s", medium: "m", large: "l",
    "extra large": "xl", "extra small": "xs",
  };
  return common[value] ?? value;
}

export type VariantRequest = { color: string; size: string | null };
export function requestedVariantFacets(
  originalQuery: string,
  rewrite: QueryRewriteResult,
): VariantRequest | null {
  // Source-target role is evaluated by currentTargetColors: a referenced
  // black skirt must never color-filter the requested shirt.
  const typedColors = (rewrite as QueryRewriteResult & {
    context?: { typedColorVocabulary?: string[] };
  }).context?.typedColorVocabulary ?? [];
  // Index and shopper language may differ. Canonicalize the typed palette
  // without letting a Vendor or plain untyped term become a color.
  const vocabulary = new Set([
    ...typedColors.map(normalizeSemanticValue),
    ...typedColors.map(canonicalColor),
    ...typedColors.flatMap(v => canonicalColor(v).split(' ').filter(t => BASE_COLORS.has(t) || Boolean(SHADE_FAMILIES[t]))),
  ]);
  if (!vocabulary.size) return null;
  // Trust only source-owned catalog color signals. The palette is built
  // from typed Color options, so store-specific shades (olive, cherry, teal)
  // must work without a hard-coded English color whitelist.
  const sourceBrandTerms = (rewrite.planning?.resolvedSegments ?? [])
    .filter((segment) => ["BRAND", "VENDOR"].includes(segment.field))
    .map((segment) => normalizeSemanticValue(segment.canonicalValue));
  const sourceColorSegments = (rewrite.planning?.resolvedSegments ?? [])
    .filter((segment) => segment.field === "ATTRIBUTE")
    .map((segment) => normalizeSemanticValue(segment.canonicalValue));
  const colors = currentTargetColors(originalQuery, rewrite, vocabulary)
    .filter((raw) => {
      const normalized = normalizeSemanticValue(raw);
      return !sourceBrandTerms.includes(normalized) ||
        sourceColorSegments.includes(normalized);
    })
    .map(canonicalColor);
  const distinct = [...new Set(colors)];
  if (distinct.length !== 1) return null;
  // A negated color is an exclusion, not a requested variant selection.
  const parsed = parseDeterministicQuery(originalQuery);
  if (parsed.negatives.some((v) =>
    canonicalColor(v.value) === distinct[0])) return null;
  const sizes = parsed.measurements
    .filter((m) => m.name === "size")
    .map((m) => canonicalSize(m.value))
    .filter(Boolean);
  // An ambiguous size request must not be applied as a guessed conjunction.
  return {
    color: distinct[0],
    size: sizes.length === 1 ? sizes[0] : null,
  };
}

function valueOfOption(variant: IndexedVariantSelection, name: RegExp) {
  return variant.selectedOptions
    .filter((item) => name.test(normalizeSemanticValue(item.name)))
    .map((item) => item.value);
}

export type VariantProductVerdict =
  | { state: "MATCH"; variantId: string }
  | { state: "COLOR_MATCH" }
  | { state: "MISMATCH" }
  | { state: "UNKNOWN" };

/** A match must come from ONE real Shopify variant, never unioned product facets. */
export function verifyVariantColorAndSize(
  variants: IndexedVariantSelection[],
  request: VariantRequest,
): VariantProductVerdict {
  if (!variants.length) return { state: "UNKNOWN" };
  let hasTypedColor = false;
  let unknownMatch = false;
  for (const variant of variants) {
    const colors = valueOfOption(variant, COLOR_OPTION_NAME);
    if (colors.length) hasTypedColor = true;
    if (!colors.length) { unknownMatch = true; continue; }
    const verdicts = colors.map(v => compareTypedColor(v, request.color));
    if (!verdicts.includes('MATCH')) {
      if (verdicts.includes('UNKNOWN')) unknownMatch = true;
      continue;
    }
    if (request.size !== null) {
      const sizes = valueOfOption(variant, SIZE_OPTION_NAME);
      if (!sizes.length) { unknownMatch = true; continue; }
      if (!sizes.some((v) => canonicalSize(v) === request.size)) continue;
    }
    return { state: "MATCH", variantId: variant.id };
  }
  return { state: hasTypedColor && !unknownMatch ? "MISMATCH" : "UNKNOWN" };
}

export type VariantColorDiagnostics = {
  request: VariantRequest | null;
  verifiedMatches: number;
  typedColorMatches: number;
  incompatible: number;
  unknown: number;
  removed: number;
};

export async function rankByVerifiedVariantColor<
  T extends { productId: string; score: number },
>(
  args: {
    shop: string;
    query: string;
    rewrite: QueryRewriteResult;
    results: T[];
    onDiagnostics?: (value: VariantColorDiagnostics) => void;
  },
  loadSelections: typeof loadProductVariantSelections = loadProductVariantSelections,
  loadFacts: typeof loadProductSemanticRows = loadProductSemanticRows,
): Promise<Array<T & { matchedVariantId?: string }>> {
  const request = requestedVariantFacets(args.query, args.rewrite);
  if (!request || !args.results.length) {
    args.onDiagnostics?.({
      request, verifiedMatches: 0, typedColorMatches: 0, incompatible: 0,
      unknown: args.results.length, removed: 0,
    });
    return args.results;
  }
  const selections = await loadSelections(
    args.shop, args.results.map((result) => result.productId),
  );
  const legacyIds = args.results.filter(r => !(selections.get(r.productId)?.length)).map(r => r.productId);
  const facts = legacyIds.length ? await loadFacts(args.shop, legacyIds) : [];
  const factsByProduct = new Map<string, typeof facts>();
  for (const fact of facts) {
    const rows = factsByProduct.get(fact.productId) ?? [];
    rows.push(fact); factsByProduct.set(fact.productId, rows);
  }
  const verified: Array<T & { matchedVariantId?: string }> = [];
  const unknown: T[] = [];
  let incompatible = 0;
  let typedColorMatches = 0;
  for (const result of args.results) {
    const variants = selections.get(result.productId) ?? [];
    const verdict = variants.length ? verifyVariantColorAndSize(variants, request)
      : verifyTypedProductColor(factsByProduct.get(result.productId) ?? [], request);
    if (verdict.state === "MATCH") {
      verified.push({ ...result, matchedVariantId: verdict.variantId });
    } else if (verdict.state === 'COLOR_MATCH') {
      typedColorMatches += 1;
      verified.push(result);
    } else if (verdict.state === "UNKNOWN") {
      unknown.push(result);
    } else {
      incompatible += 1;
    }
  }
  // A known Blue-only product must not satisfy Red. Unknown legacy profiles
  // can be retained for recall but always rank below verified matches.
  args.onDiagnostics?.({
    request,
    verifiedMatches: verified.length - typedColorMatches,
    typedColorMatches,
    incompatible,
    unknown: unknown.length,
    removed: incompatible,
  });
  return [...verified, ...unknown];
}
