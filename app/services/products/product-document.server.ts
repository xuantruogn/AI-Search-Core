export type ProductVariantForIndex = {
  title: string;
  sku?: string | null;
  barcode?: string | null;
};

export type ProductForIndex = {
  id: string;
  handle: string;
  title: string;

  description?: string | null;
  vendor?: string | null;
  productType?: string | null;

  tags?: string[];

  variants?: ProductVariantForIndex[];

  // Retrieval metadata only. Price is intentionally excluded from the
  // semantic document, but travels with the Qdrant payload for deterministic
  // filtering/sorting without a second storefront API round-trip.
  priceRange?: {
    min: number;
    max: number;
    currencyCode: string;
  } | null;
};

function readPositiveInteger(name: string, fallback: number) {
  const value = Number.parseInt(process.env[name] || "", 10);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

const MAX_DOCUMENT_CHARS = readPositiveInteger(
  "AI_SEARCH_MAX_PRODUCT_DOCUMENT_CHARS",
  20_000,
);
const MAX_DESCRIPTION_CHARS = readPositiveInteger(
  "AI_SEARCH_MAX_PRODUCT_DESCRIPTION_CHARS",
  12_000,
);
const MAX_TAGS = readPositiveInteger("AI_SEARCH_MAX_PRODUCT_TAGS", 100);
const MAX_VARIANTS = readPositiveInteger("AI_SEARCH_MAX_PRODUCT_VARIANTS", 100);

function truncate(value: string, maxChars: number) {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function cleanText(value: string | null | undefined): string {
  if (!value) {
    return "";
  }

  return value.replace(/\s+/g, " ").trim();
}

function uniqueSorted(values: string[], limit: number) {
  const deduped = new Map<string, string>();

  for (const value of values) {
    const clean = cleanText(value);
    if (!clean) continue;
    const key = clean.toLocaleLowerCase("en-US");
    if (!deduped.has(key)) deduped.set(key, clean);
  }

  return [...deduped.values()]
    .sort((left, right) => {
      const a = left.toLocaleLowerCase("en-US");
      const b = right.toLocaleLowerCase("en-US");
      if (a < b) return -1;
      if (a > b) return 1;
      return left < right ? -1 : left > right ? 1 : 0;
    })
    .slice(0, limit);
}

export function buildProductDocument(product: ProductForIndex): string {
  const parts: string[] = [];

  // --------------------------------------------------
  // TITLE
  // --------------------------------------------------

  parts.push(`Product: ${cleanText(product.title)}.`);

  // --------------------------------------------------
  // PRODUCT TYPE
  // --------------------------------------------------

  if (product.productType) {
    parts.push(`Product type: ${cleanText(product.productType)}.`);
  }

  // --------------------------------------------------
  // VENDOR
  // --------------------------------------------------

  if (product.vendor) {
    parts.push(`Vendor: ${cleanText(product.vendor)}.`);
  }

  // --------------------------------------------------
  // TAGS
  // --------------------------------------------------

  if (product.tags && product.tags.length > 0) {
    // Tag order is not semantically meaningful. Normalize/dedupe/sort so a
    // merchant reordering the same tags does not trigger a paid re-embedding.
    const tags = uniqueSorted(product.tags, MAX_TAGS).join(", ");

    if (tags) {
      parts.push(`Tags: ${tags}.`);
    }
  }

  // --------------------------------------------------
  // DESCRIPTION
  // --------------------------------------------------

  if (product.description) {
    const description = cleanText(product.description);

    if (description) {
      parts.push(
        `Description: ${truncate(description, MAX_DESCRIPTION_CHARS)}`,
      );
    }
  }

  // --------------------------------------------------
  // VARIANTS
  // --------------------------------------------------

  if (product.variants && product.variants.length > 0) {
    // Variant presentation order can change independently from product
    // meaning. Stable semantic lists avoid needless hash churn while keeping
    // the same title/SKU information used by the original design.
    const variantTitles = uniqueSorted(
      product.variants
        .map((variant) => cleanText(variant.title))
        .filter((title) => title !== "Default Title"),
      MAX_VARIANTS,
    );

    if (variantTitles.length > 0) {
      parts.push(`Variants: ${variantTitles.join(", ")}.`);
    }

    const skus = uniqueSorted(
      product.variants.map((variant) => cleanText(variant.sku)),
      MAX_VARIANTS,
    );

    if (skus.length > 0) {
      parts.push(`SKUs: ${skus.join(", ")}.`);
    }

    const barcodes = uniqueSorted(
      product.variants.map((variant) => cleanText(variant.barcode)),
      MAX_VARIANTS,
    );

    if (barcodes.length > 0) {
      parts.push(`Barcodes: ${barcodes.join(", ")}.`);
    }
  }

  return truncate(parts.join("\n"), MAX_DOCUMENT_CHARS);
}
