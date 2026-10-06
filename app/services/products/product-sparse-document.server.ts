import type { ProductForIndex } from "./product-document.server";
import type { ProductSemanticAnalysis } from "./product-embedding-input.server";

function clean(value: string | null | undefined) {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function unique(values: Array<string | null | undefined>, limit: number) {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const text = clean(value);
    if (!text) continue;
    const key = text.toLocaleLowerCase("en-US");
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(text);
    if (result.length >= limit) break;
  }
  return result;
}

/**
 * Sparse/BM25 representation.
 * Dense vectors own meaning/intent. This document intentionally keeps
 * source-grounded lexical vocabulary: names, type, brand/model, aliases,
 * merchant tags/options and exact attributes. SKU/barcode/identifiers,
 * compatibility, price and measurements remain structured/exact authority.
 */
export function composeProductSparseDocument(args: {
  product: Pick<
    ProductForIndex,
    "title" | "handle" | "vendor" | "productType" | "tags" | "variants"
  >;
  analysis: ProductSemanticAnalysis | null;
}) {
  const { product, analysis } = args;
  const variantTitles = (product.variants ?? []).map((variant) =>
    variant.title === "Default Title" ? "" : variant.title,
  );
  const variantOptions = (product.variants ?? []).flatMap((variant) =>
    (variant.selectedOptions ?? []).flatMap((option) => [
      option.name,
      option.value,
      `${option.name} ${option.value}`,
    ]),
  );

  // Qdrant BM25 currently receives one sparse text field, so approximate
  // field weights through bounded term-frequency repetition. Exact product
  // naming/type/brand/model should dominate tags and generic attributes.
  const title = clean(product.title);
  const productType = clean(product.productType);
  const vendor = clean(product.vendor);
  const brands = unique(analysis?.brandTerms ?? [], 8);
  const models = unique(analysis?.modelTerms ?? [], 12);
  const aliases = unique(analysis?.aliases ?? [], 20);
  const attributes = unique(analysis?.exactAttributes ?? [], 24);
  const tags = unique(product.tags ?? [], 32);
  const languageTerms = unique([
    ...(analysis?.sourceLanguageTerms ?? []),
    ...(analysis?.shopLanguageTerms ?? []),
  ], 32);
  const lowerWeight = unique([
    ...aliases,
    ...attributes,
    ...tags,
    ...variantTitles,
    ...variantOptions,
    ...languageTerms,
  ], 96);

  const parts = [
    title, title, title,
    productType, productType,
    vendor, vendor,
    ...brands, ...brands,
    ...models, ...models,
    ...lowerWeight,
  ].filter(Boolean);

  return parts.join(" ").slice(0, 4_000).trim();
}
