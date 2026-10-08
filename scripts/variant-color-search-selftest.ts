import assert from "node:assert/strict";
import {
  normalizeIndexedVariantSelections,
} from "../app/services/search/product-semantic-profile.server";
import {
  verifyVariantColorAndSize,
  rankByVerifiedVariantColor,
  requestedVariantFacets,
} from "../app/services/search/variant-color-search.server";

const gid = (n: number) => "gid://shopify/ProductVariant/" + n;
const variants = normalizeIndexedVariantSelections([
  { id: gid(101), selectedOptions: [{ name: "Color", value: "Red" }, { name: "Size", value: "M" }] },
  { id: gid(102), selectedOptions: [{ name: "Color", value: "Blue" }, { name: "Size", value: "L" }] },
  { id: gid(103), selectedOptions: [{ name: "Color", value: "Green" }, { name: "Size", value: "S" }] },
]);
assert.deepEqual(verifyVariantColorAndSize(variants, { color: "red", size: null }),
  { state: "MATCH", variantId: gid(101) });
assert.deepEqual(verifyVariantColorAndSize(variants, { color: "red", size: "m" }),
  { state: "MATCH", variantId: gid(101) });
assert.deepEqual(verifyVariantColorAndSize(variants, { color: "red", size: "l" }),
  { state: "MISMATCH" }, "Color and size from different variants must never combine");
assert.deepEqual(verifyVariantColorAndSize(variants, { color: "blue", size: "l" }),
  { state: "MATCH", variantId: gid(102) });
assert.deepEqual(verifyVariantColorAndSize(variants, { color: "black", size: null }),
  { state: "MISMATCH" });
assert.deepEqual(verifyVariantColorAndSize([], { color: "red", size: null }),
  { state: "UNKNOWN" });
assert.deepEqual(verifyVariantColorAndSize(normalizeIndexedVariantSelections([
  { id: gid(199), selectedOptions: [{ name: "Màu", value: "Đỏ" }, { name: "Cỡ", value: "M" }] },
]), { color: "red", size: "m" }), { state: "MATCH", variantId: gid(199) },
  "Localized Color and Size options must be matched on the same Shopify variant");
assert.deepEqual(verifyVariantColorAndSize(normalizeIndexedVariantSelections([
  { id: gid(200), selectedOptions: [{ name: "Fabric", value: "Red cotton" }] },
]), { color: "red", size: null }), { state: "UNKNOWN" }, "Fabric is not Color");

const palette = ["red", "blue", "black", "green", "white"];
const rewrite = (color: string, mode: "DIRECT" | "COMPLEMENT" = "DIRECT") => ({
  query: "Looking for a red shirt",
  analysis: {
    requiredAttributes: [], optionalPreferences: [color], attributes: [color],
    sourceOwnedExactConstraints: [color], semanticDemand: null, negativeTerms: [],
    negativeAttributes: [],
  },
  planning: {
    retrievalMode: mode,
    resolvedSegments: [{ text: "đỏ", field: "ATTRIBUTE", canonicalValue: color, confidence: 1, start: 1, end: 2 }],
  },
  context: { typedColorVocabulary: palette },
}) as any;
assert.deepEqual(requestedVariantFacets("áo đỏ size M", rewrite("red")), { color: "red", size: "m" });
assert.equal(requestedVariantFacets("áo đỏ", rewrite("red"))?.color, "red");
const localizedRewrite = {
  ...rewrite("red"), context: { typedColorVocabulary: ["Đỏ", "Xanh dương"] },
} as any;
assert.equal(requestedVariantFacets("áo đỏ", localizedRewrite)?.color, "red",
  "Translated Red must match merchant's Đỏ color vocabulary");
assert.equal(requestedVariantFacets("shirt from Red brand", {
  ...rewrite("red"),
  planning: { resolvedSegments: [{ text: "Red", field: "BRAND", canonicalValue: "Red" }] },
  analysis: {
    ...rewrite("red").analysis,
    requiredAttributes: [], optionalPreferences: [], attributes: [], sourceOwnedExactConstraints: [],
  },
} as any), null, "Vendor Red cannot become color Red");

const blue = normalizeIndexedVariantSelections([
  { id: gid(300), selectedOptions: [{ name: "Color", value: "Blue" }, { name: "Size", value: "M" }] },
]);
const records = new Map([
  ["gid://shopify/Product/1", variants],
  ["gid://shopify/Product/2", blue],
  ["gid://shopify/Product/3", []],
]);
let diagnostics: any;
const ranked = await rankByVerifiedVariantColor({
  shop: "test.myshopify.com",
  query: "áo đỏ",
  rewrite: rewrite("red"),
  results: [
    { productId: "gid://shopify/Product/2", score: 0.99, handle: "blue-shirt" },
    { productId: "gid://shopify/Product/3", score: 0.85, handle: "legacy-shirt" },
    { productId: "gid://shopify/Product/1", score: 0.72, handle: "red-blue-green-shirt" },
  ],
  onDiagnostics: value => { diagnostics = value; },
}, async () => records);
assert.deepEqual(ranked.map(x => x.productId), [
  "gid://shopify/Product/1", "gid://shopify/Product/3",
]);
assert.equal(ranked[0].matchedVariantId, gid(101));
assert.equal(diagnostics.incompatible, 1);
assert.equal(diagnostics.verifiedMatches, 1);
console.log("PASS: same-variant color/size, exact shade, vendor isolation, verified-first ranking");
