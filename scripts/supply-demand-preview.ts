/** Local-only profile/text inspection. Does not write vectors or indexed products. */
import { readFileSync, writeFileSync } from "node:fs";
import db from "../app/db.server";
import { parseStoredSemanticProfile } from "../app/services/search/product-semantic-profile.server";
import { prepareProductEmbeddingInput } from "../app/services/products/product-embedding-input.server";
import { rewriteSearchQuery } from "../app/services/search/query-rewriter.server";

if (process.env.NODE_ENV === "production" || !["127.0.0.1", "localhost"].includes(new URL(process.env.DATABASE_URL!).hostname)) throw new Error("Local database required");
const shop = "dev-app-6fvh2isn.myshopify.com";
const handles = ["acs-crossfire-headset", "buckshot-bluetooth-speaker", "summer-casual-dress", "s14-vrb-se-111-black-blue", "classic-doc-bag-black", "snow-peak-mola-headlamp"];
const queries = ["bicycle headset", "Bluetooth speaker", "summer clothing", "waterproof footwear", "bag for daily office use and carrying a laptop", "hands-free lighting for hiking", "clothing for hot weather", "clothing for cold weather", "wireless headphones", "tai nghe", "smart watch", "printer for paper documents at home"];
process.env.AI_SEARCH_PRODUCT_LLM_MAX_OUTPUT_TOKENS = "3200";
process.env.AI_SEARCH_PRODUCT_LLM_RETRY_MAX_OUTPUT_TOKENS = "3600";
const snapshots = JSON.parse(readFileSync(".tmp/v6-source-products.json", "utf8")) as Array<{ id: string; handle: string; title: string; productType: string; description: string }>;
const output: { products: unknown[]; queries: unknown[] } = { products: [], queries: [] };
try {
  for (const handle of handles) {
    const product = snapshots.find(p => p.handle === handle)!;
    if (!product) throw new Error(`Missing cached product: ${handle}`);
    const row = await db.aiSearchProductSemanticProfile.findUnique({ where: { shop_productId: { shop, productId: product.id } } });
    if (!row) throw new Error(`Missing cached PSF: ${handle}`);
    const profile = parseStoredSemanticProfile(row.profile);
    // Original merchant descriptions were unavailable in the prior v6 snapshot.
    // Inspect real catalog PSF facts, explicitly excluding old recall inferences.
    const source = [`Product: ${product.title}`, ...profile.terms.filter(t => !["SOFT_CONTEXT", "INFERRED_AUDIENCE", "ALIAS", "SEARCH_TERM", "TRANSLATED_TERM"].includes(t.kind)).map(t => `${t.kind}: ${t.value}`)].join("\n");
    const result = await prepareProductEmbeddingInput(source, "en", shop, product);
    const entry = { handle, sourceKind: "cached catalog PSF facts; original merchant prose unavailable", status: result.enrichmentStatus, error: result.enrichmentError, supply: result.analysis?.semanticSupply, embeddingText: result.document };
    output.products.push(entry);
    writeFileSync(".tmp/supply-demand-preview.json", JSON.stringify(output, null, 2));
    console.log("PRODUCT", JSON.stringify(entry));
  }
  for (const query of queries) {
    const result = await rewriteSearchQuery({ shop, query, searchLanguage: "en" });
    const entry = { query, fallbackReason: result.fallbackReason, demand: result.analysis.semanticDemand, embeddingText: result.query };
    output.queries.push(entry);
    writeFileSync(".tmp/supply-demand-preview.json", JSON.stringify(output, null, 2));
    console.log("QUERY", JSON.stringify(entry));
  }
} finally { await db.$disconnect(); }
