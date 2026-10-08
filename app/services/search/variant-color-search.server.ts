import type { QueryRewriteResult } from "./query-rewriter.server";
import { normalizeSemanticValue } from "./semantic-normalization.server";
import { currentTargetColors } from "./shop-context-index.server";
import {
  loadProductVariantSelections,
  type IndexedVariantSelection,
} from "./product-semantic-profile.server";
import { parseDeterministicQuery } from "./deterministic-query-parser.server";

const COLOR_NAMES = new Set([
  "red", "blue", "green", "black", "white", "yellow", "pink", "purple",
  "orange", "brown", "grey", "gray", "beige", "navy", "burgundy",
  "gold", "silver", "cream", "ivory", "khaki", "teal", "turquoise",
]);
const TRANSLATED_COLORS: Record<string, string> = {
  "do": "red", "mau do": "red", "đỏ": "red",
  "den": "black", "mau den": "black",
  "trang": "white", "mau trang": "white",
  "xanh duong": "blue", "xanh da troi": "blue",
  "xanh la": "green", "xanh la cay": "green",
  "vang": "yellow", "hong": "pink", "tim": "purple",
  "cam": "orange", "nau": "brown", "xam": "gray",
  "gris": "gray", "rouge": "red", "rojo": "red",
  "azul": "blue", "bleu": "blue", "negro": "black",
};
const COLOR_OPTION_NAME = /^(?:color|colour|mau|màu|couleur|farbe)$/i;
const SIZE_OPTION_NAME = /^(?:size|co|cỡ|taille|shoe size|sizes)$/i;

function canonicalColor(raw: string): string {
  const key = normalizeSemanticValue(raw);
  const mapped = TRANSLATED_COLORS[key] ?? key;
  return mapped === "grey" ? "gray" : mapped;
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
  const vocabulary = new Set(
    (rewrite as QueryRewriteResult & {
      context?: { typedColorVocabulary?: string[] };
    }).context?.typedColorVocabulary ?? [],
  );
  if (!vocabulary.size) return null;
  const colors = currentTargetColors(originalQuery, rewrite, vocabulary)
    .map(canonicalColor)
    .filter((color) => COLOR_NAMES.has(color));
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
    .filter((item) => name.test(item.name))
    .map((item) => item.value);
}

export type VariantProductVerdict =
  | { state: "MATCH"; variantId: string }
  | { state: "MISMATCH" }
  | { state: "UNKNOWN" };

/** A match must come from ONE real Shopify variant, never unioned product facets. */
export function verifyVariantColorAndSize(
  variants: IndexedVariantSelection[],
  request: VariantRequest,
): VariantProductVerdict {
  if (!variants.length) return { state: "UNKNOWN" };
  let hasTypedColor = false;
  for (const variant of variants) {
    const colors = valueOfOption(variant, COLOR_OPTION_NAME);
    if (colors.length) hasTypedColor = true;
    if (!colors.some((v) => canonicalColor(v) === request.color)) continue;
    if (request.size !== null) {
      const sizes = valueOfOption(variant, SIZE_OPTION_NAME);
      if (!sizes.length) continue;
      if (!sizes.some((v) => canonicalSize(v) === request.size)) continue;
    }
    return { state: "MATCH", variantId: variant.id };
  }
  return { state: hasTypedColor ? "MISMATCH" : "UNKNOWN" };
}

export type VariantColorDiagnostics = {
  request: VariantRequest | null;
  verifiedMatches: number;
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
): Promise<Array<T & { matchedVariantId?: string }>> {
  const request = requestedVariantFacets(args.query, args.rewrite);
  if (!request || !args.results.length) {
    args.onDiagnostics?.({
      request, verifiedMatches: 0, incompatible: 0,
      unknown: args.results.length, removed: 0,
    });
    return args.results;
  }
  const selections = await loadSelections(
    args.shop, args.results.map((result) => result.productId),
  );
  const verified: Array<T & { matchedVariantId?: string }> = [];
  const unknown: T[] = [];
  let incompatible = 0;
  for (const result of args.results) {
    const verdict = verifyVariantColorAndSize(
      selections.get(result.productId) ?? [],
      request,
    );
    if (verdict.state === "MATCH") {
      verified.push({ ...result, matchedVariantId: verdict.variantId });
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
    verifiedMatches: verified.length,
    incompatible,
    unknown: unknown.length,
    removed: incompatible,
  });
  return [...verified, ...unknown];
}
