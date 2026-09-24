import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { planProductEligibility, type ProductEligibilityInput } from "../app/services/commerce/indexed-products.server";

function rows(count: number, active: number, staleFrom = Number.POSITIVE_INFINITY): ProductEligibilityInput[] {
  return Array.from({ length: count }, (_, index) => ({
    productId: `gid://shopify/Product/${index + 1}`,
    searchable: index < active,
    hasVector: true,
    vectorStatus: index >= staleFrom ? "STALE" : "READY",
    blockedReason: index < active ? null : "PRODUCT_LIMIT",
    status: index < active ? "INDEXED" : "PRODUCT_LIMIT_BLOCKED",
    createdAt: new Date(index * 1000),
  }));
}

const down = planProductEligibility(rows(1283, 1283), true, 100);
assert.equal(down.filter((row) => row.searchable).length, 100);
assert.equal(down.filter((row) => row.blockedReason === "PRODUCT_LIMIT").length, 1183);
assert.equal(down.filter((row) => row.hasVector).length, 1283);

const upReady = planProductEligibility(rows(1283, 100), true, 500);
assert.equal(upReady.filter((row) => row.searchable).length, 500);
assert.equal(upReady.filter((row) => row.requiresReindex).length, 0);

const upStale = planProductEligibility(rows(500, 100, 470), true, 500);
assert.equal(upStale.filter((row) => row.searchable).length, 470);
assert.equal(upStale.filter((row) => row.requiresReindex).length, 30);

const inactive = planProductEligibility(rows(500, 500), false, 500);
assert.equal(inactive.filter((row) => row.searchable).length, 0);
assert.equal(inactive.filter((row) => row.hasVector).length, 500);
const activeAgain = planProductEligibility(inactive, true, 500);
assert.equal(activeAgain.filter((row) => row.searchable).length, 500);

const first = planProductEligibility(rows(200, 100), true, 100);
assert.deepEqual(planProductEligibility(first, true, 100), first);

const recoverySource = readFileSync("app/services/products/quota-recovery.server.ts", "utf8");
const indexerSource = readFileSync("app/services/products/product-indexer.server.ts", "utf8");
const processorSource = readFileSync("app/services/products/product-sync-job-processor.server.ts", "utf8");
const webhookSource = readFileSync("app/services/products/product-webhook-sync.server.ts", "utf8");
const registrySource = readFileSync("app/services/commerce/indexed-products.server.ts", "utf8");
assert.doesNotMatch(recoverySource, /topic:\s*["']PRODUCTS_UPDATE["']/);
assert.match(recoverySource, /topic:\s*["']REINDEX_PRODUCT["']/);
assert.doesNotMatch(readFileSync("app/services/commerce/reconciliation.server.ts", "utf8"), /deleteProductVectorForShop/);
const vectorSource = readFileSync("app/services/search/vector-store.server.ts", "utf8");
assert.ok(vectorSource.includes("AND \\`searchable\\` = true"));
assert.match(vectorSource, /match:\s*\{\s*any:\s*eligibleProductIds/);
assert.match(registrySource, /FOR UPDATE/);

// D: blocked webhooks update metadata and return before paid AI work.
assert.ok(indexerSource.indexOf("markIneligibleProductMetadata") < indexerSource.indexOf("getShopEntitlement(shop)"));
// F: a queued reindex job must match both the current policy generation and eligibility.
assert.match(processorSource, /jobPolicyVersion\s*!==\s*currentPolicyVersion/);
assert.match(processorSource, /!eligible\s*\|\|/);
assert.match(processorSource, /resource:\s*["']product-policy:reconcile["']/);
// G: slot reservation and policy reconciliation both serialize through DB row locks.
assert.ok((registrySource.match(/FOR UPDATE/g) ?? []).length >= 2);
// H: eligibility is applied in Qdrant retrieval, before top-K is consumed.
assert.match(vectorSource, /match:\s*\{\s*any:\s*eligibleProductIds/);
// I: only an explicit delete webhook reaches physical vector deletion.
assert.match(webhookSource, /export async function deleteProductFromWebhook/);
assert.match(webhookSource, /await deleteProductFromAiIndex/);
assert.match(webhookSource, /markIndexedProductUnpublished/);

console.log("Product lifecycle self-test: PASS");
