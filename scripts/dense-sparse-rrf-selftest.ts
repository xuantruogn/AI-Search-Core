import assert from "node:assert/strict";
import { composeProductSparseDocument } from "../app/services/products/product-sparse-document.server";
import { fuseHybridRetrieval } from "../app/services/search/hybrid-retrieval-fusion.server";

const sparseDoc = composeProductSparseDocument({
  product: {
    handle: "speaker",
    title: "Buckshot Bluetooth Speaker",
    vendor: "Acme",
    productType: "Speaker",
    tags: ["portable", "outdoor"],
    variants: [{
      title: "Black",
      sku: "SECRET-SKU",
      barcode: "123456",
      selectedOptions: [{ name: "Color", value: "Black" }],
    }],
  },
  analysis: {
    sourceLanguage: "en",
    canonicalProductType: "speaker",
    shopLanguageProductType: "speaker",
    category: "audio",
    brandTerms: ["Acme"],
    modelTerms: ["Buckshot"],
    identifiers: ["SECRET-SKU"],
    audiences: [],
    compatibility: ["Some phone"],
    exactAttributes: ["Bluetooth", "water-resistant"],
    measurements: ["10 cm"],
    explicitContexts: [],
    variantAttributes: [],
    inferredAudiences: [],
    compatibleContexts: [],
    aliases: ["portable speaker"],
    sourceLanguageTerms: ["speaker"],
    shopLanguageTerms: [],
    factualSummary: "",
  },
});
assert.match(sparseDoc, /Buckshot Bluetooth Speaker/);
assert.match(sparseDoc, /portable speaker/);
assert.match(sparseDoc, /water-resistant/);
assert.ok(!sparseDoc.includes("SECRET-SKU"));
assert.ok(!sparseDoc.includes("123456"));
assert.ok(!sparseDoc.includes("Some phone"));
assert.ok(!sparseDoc.includes("10 cm"));

const base = (id: string, score: number) => ({
  productId: id,
  handle: id,
  title: id,
  score,
});
const fused = fuseHybridRetrieval({
  plan: null,
  semantic: [base("semantic-only", 0.9), base("both", 0.8)],
  sparse: [
    { ...base("both", 12), sparseScore: 12, sparseRank: 1 },
    { ...base("sparse-only", 10), sparseScore: 10, sparseRank: 2 },
  ],
  structured: [],
  lexical: [],
  semanticNoEvidence: false,
  semanticThreshold: 0.35,
  limit: 10,
});
assert.equal(fused.results[0]?.productId, "both");
assert.ok((fused.results[0]?.rrfScore ?? 0) > (fused.results[1]?.rrfScore ?? 0));
assert.deepEqual(
  new Set(fused.results[0]?.retrievalSources),
  new Set(["SEMANTIC", "SPARSE"]),
);
assert.equal(fused.diagnostics.rrfConfirmedCount, 1);

const guarded = fuseHybridRetrieval({
  plan: null,
  semantic: [],
  sparse: [
    { ...base("token-neighbor", 20), sparseScore: 20, sparseRank: 1 },
  ],
  structured: [],
  lexical: [],
  semanticNoEvidence: true,
  semanticThreshold: 0.5,
  limit: 10,
});
assert.equal(
  guarded.results.length,
  1,
  "dense no-evidence must not erase the independent BM25 recall lane",
);
assert.equal(guarded.results[0]?.productId, "token-neighbor");

const absentFamily = fuseHybridRetrieval({
  plan: null,
  semantic: [],
  sparse: [
    { ...base("wrong-family", 20), sparseScore: 20, sparseRank: 1 },
  ],
  structured: [],
  lexical: [],
  semanticNoEvidence: false,
  sourceProductClassAbsent: true,
  semanticThreshold: 0.5,
  limit: 10,
});
assert.equal(
  absentFamily.results.length,
  0,
  "BM25 overlap must not resurrect an absent product family",
);

console.log("PASS: sparse document isolation and dense+sparse RRF fusion");
