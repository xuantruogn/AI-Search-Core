import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { matchCatalogTerms } from "../app/services/search/catalog-term-matcher.server";
import {
  classifyVerifiedFamilyMember,
} from "../app/services/search/pure-family-lookup.server";
import {
  queryFamilyFromSource,
} from "../app/services/search/product-family-taxonomy.server";
import {
  normalizeIndexedVariantSelections,
} from "../app/services/search/product-semantic-profile.server";
import {
  compareTypedColor,
  verifyVariantColorAndSize,
} from "../app/services/search/variant-color-search.server";
import { parseRewrittenQuery } from "../app/services/search/query-rewriter.server";

type Result = {
  group: string;
  case: string;
  ok: boolean;
  detail: string;
};

const results: Result[] = [];
const check = (group: string, name: string, fn: () => void, detail = "") => {
  try {
    fn();
    results.push({ group, case: name, ok: true, detail: detail || "PASS" });
  } catch (error) {
    results.push({
      group,
      case: name,
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  }
};

const bicycleTarget = {
  canonical: "bicycle",
  broadCategory: false,
  taxonomyGroup: "bicycle" as const,
};

check("CATEGORY", "Vietnamese xe đạp maps to bicycle family", () => {
  assert.equal(queryFamilyFromSource("xe đạp"), "bicycle");
});

check("CATEGORY", "Road bicycle is included in bicycle family", () => {
  assert.equal(
    classifyVerifiedFamilyMember(
      [{ kind: "CANONICAL_PRODUCT_TYPE", value: "Road Bicycle" }],
      bicycleTarget,
    ),
    "SUBTYPE",
  );
});

check("CATEGORY", "Bicycle helmet is excluded from bicycle family", () => {
  assert.equal(
    classifyVerifiedFamilyMember(
      [
        { kind: "CANONICAL_PRODUCT_TYPE", value: "Bicycle Helmet" },
        { kind: "PRODUCT_TYPE", value: "Helmet" },
      ],
      bicycleTarget,
    ),
    null,
  );
});

const skuEntry = {
  normalized: "sku abc 123",
  canonical: "SKU-ABC-123",
  aliases: [],
  field: "IDENTIFIER",
  productCount: 1,
  conceptId: "sku-fixture",
  aliasLanguage: null,
  source: "SHOPIFY",
  confidence: 1,
};

const bicycleEntry = {
  normalized: "bicycle",
  canonical: "Bicycle",
  aliases: [],
  field: "PRODUCT_TYPE",
  productCount: 8,
  conceptId: "bicycle-fixture",
  aliasLanguage: null,
  source: "SHOPIFY",
  confidence: 1,
};

const dictionary = {
  shop: "qa.myshopify.com",
  entries: [skuEntry, bicycleEntry],
  version: "qa",
  loadedAt: Date.now(),
  matchIndex: {
    byFirstToken: new Map([
      ["sku", [skuEntry]],
      ["bicycle", [bicycleEntry]],
    ]),
    rank: new Map([
      [skuEntry, 0],
      [bicycleEntry, 1],
    ]),
    fuzzySingleTokenByLength: new Map([
      [7, [bicycleEntry]],
    ]),
  },
} as any;

check("DIRECT", "Exact SKU survives deterministic catalog matching", () => {
  const matches = matchCatalogTerms("sku-abc-123", dictionary);
  assert.ok(matches.some((m) => m.entry.field === "IDENTIFIER" && m.entry.canonical === "SKU-ABC-123"));
});

check("TYPO", "One-character bicycle typo remains retrievable", () => {
  const matches = matchCatalogTerms("bicycl", dictionary);
  assert.ok(matches.some((m) => m.matchType === "FUZZY" && m.entry.canonical === "Bicycle"));
});

const variants = normalizeIndexedVariantSelections([
  {
    id: "gid://shopify/ProductVariant/1",
    selectedOptions: [
      { name: "Color", value: "Red" },
      { name: "Size", value: "M" },
    ],
  },
  {
    id: "gid://shopify/ProductVariant/2",
    selectedOptions: [
      { name: "Color", value: "Blue" },
      { name: "Size", value: "L" },
    ],
  },
]);

check("ATTRIBUTE", "Color + size must match the same variant", () => {
  assert.deepEqual(
    verifyVariantColorAndSize(variants, { color: "red", size: "m" }),
    { state: "MATCH", variantId: "gid://shopify/ProductVariant/1" },
  );
  assert.deepEqual(
    verifyVariantColorAndSize(variants, { color: "red", size: "l" }),
    { state: "MISMATCH" },
  );
});

check("ATTRIBUTE", "Localized Vietnamese color matches canonical red", () => {
  assert.equal(compareTypedColor("Đỏ", "red"), "MATCH");
});

check("CONVERSATIONAL", "Christmas-party context remains semantic, not a hard exact facet", () => {
  const parsed = parseRewrittenQuery(
    JSON.stringify({
      semanticDemand: {
        identity: ["party shoes"],
        desiredOutcomes: [],
        useCases: ["party wear"],
        contexts: ["Christmas party"],
        qualities: [],
        audience: [],
        styles: ["festive"],
        negativeConstraints: [],
        exactConstraints: [],
      },
      detectedLanguage: "vi",
      retrievalMode: "DIRECT",
      referenceTerms: [],
      semanticQuery: "party shoes for a Christmas celebration",
      expansions: ["red pumps", "dress shoes"],
      mandatoryConcepts: [{ target: "party shoes", source: "giày dự tiệc" }],
      mustNotTerms: [],
    }),
    "giày dự tiệc Giáng sinh",
    "en",
    "SIMPLE",
  );
  assert.ok(parsed);
  assert.deepEqual(parsed.analysis.semanticDemand?.contexts, ["Christmas party"]);
  assert.deepEqual(parsed.analysis.semanticDemand?.exactConstraints, []);
});

const proxySource = await readFile(
  new URL("../app/routes/proxy.ai-search.ts", import.meta.url),
  "utf8",
);
const earlyNoResultAt = proxySource.indexOf('if (pipeline.earlyNoResult)');
const familyLookupAt = proxySource.indexOf("retrieveCompleteFamilyCandidates({");

check("ZERO_RESULT", "Pure-family recovery is evaluated before RAW certain-no-result can terminate search", () => {
  assert.ok(earlyNoResultAt >= 0, "earlyNoResult branch missing");
  assert.ok(familyLookupAt >= 0, "pure-family lookup missing");
  assert.ok(
    familyLookupAt < earlyNoResultAt,
    "RAW CERTAIN_NO_RESULT currently terminates before pure-family recovery runs",
  );
});

const indexerSource = await readFile(
  new URL("../app/services/products/product-indexer.server.ts", import.meta.url),
  "utf8",
);
const schemaSource = await readFile(
  new URL("../prisma/schema.prisma", import.meta.url),
  "utf8",
);

check("MULTILINGUAL", "Catalog sync snapshots one language for the whole job", () => {
  const hasJobLanguageSnapshot =
    /model\s+AiSearchCatalogSyncJob[\s\S]*?(?:languageAtStart|catalogLanguageAtStart|indexLanguage)/i.test(schemaSource);
  const rereadsLanguagePerProduct =
    /export\s+async\s+function\s+indexProduct[\s\S]*?getShopSettings\(shop\)/.test(indexerSource);
  assert.ok(
    hasJobLanguageSnapshot && !rereadsLanguagePerProduct,
    "catalog job has no language snapshot and indexProduct re-reads current shop language per product",
  );
});

for (const row of results) {
  console.log(`${row.ok ? "PASS" : "FAIL"} [${row.group}] ${row.case} :: ${row.detail}`);
}

const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({
  total: results.length,
  passed: results.length - failed.length,
  failed: failed.length,
  failedCases: failed.map((r) => ({ group: r.group, case: r.case, detail: r.detail })),
}, null, 2));

if (failed.length) {
  throw new Error(`Search quality acceptance failed: ${failed.length}/${results.length}`);
}
