import assert from "node:assert/strict";
import db from "../app/db.server";
import {
  buildProductVectorSemanticPayload,
  parseStoredSemanticProfile,
  replaceProductSemanticProfile,
} from "../app/services/search/product-semantic-profile.server";
import {
  getSearchCatalogRevisionCached,
  invalidateSearchCatalogRevisionCache,
} from "../app/services/search/search-catalog-revision.server";

// No live DB or external services: exercise the actual writer/reader boundary.
const profileDelegate = db.aiSearchProductSemanticProfile;
const settingsDelegate = db.aiSearchShopSettings;
const originalUpsert = profileDelegate.upsert;
const originalFind = settingsDelegate.findUnique;
let stored: unknown;
try {
  profileDelegate.upsert = (async (args: any) => {
    stored = args.create.profile;
    assert.deepEqual(args.create.profile, args.update.profile);
    return { updatedAt: new Date(), productRecord: { searchable: true, hasVector: true } };
  }) as unknown as typeof originalUpsert;
  const terms = Array.from({ length: 120 }, (_, index) => ({
    kind: "SKU", value: `sku-${index}`, normalizedValue: `sku ${index}`,
  }));
  await replaceProductSemanticProfile({
    shop: "fixture.myshopify.com", productId: "gid://shopify/Product/1",
    analysis: null, terms,
  });
  const loaded = parseStoredSemanticProfile(stored as any);
  assert.equal(loaded.terms.length, 120, "compact JSON must retain terms beyond 64 per kind");
  assert.deepEqual(buildProductVectorSemanticPayload(loaded.terms),
    buildProductVectorSemanticPayload(terms), "DB and Qdrant semantic tokens must agree");
  assert.equal(parseStoredSemanticProfile({ schemaVersion: 2,
    values: { SKU: Array.from({ length: 400 }, (_, i) => `sku-${i}`) },
  }).terms.length, 320, "storage safety ceiling remains bounded");
  assert.equal(parseStoredSemanticProfile({ schemaVersion: 1, terms }).terms.length, 120);

  const shop = "revision-fixture.myshopify.com";
  let reads = 0;
  let releaseOld!: (value: any) => void;
  const row = (revision: bigint) => ({
    catalogRevision: revision, semanticRevision: revision,
    catalogUpdatedAt: null, semanticUpdatedAt: null, productPolicyVersion: 0,
    searchLanguage: "en", updatedAt: new Date(), shopRecord: { shopifyShopId: "1" },
  });
  settingsDelegate.findUnique = (() => {
    reads++;
    if (reads === 1) return new Promise((resolve) => { releaseOld = resolve; });
    return Promise.resolve(row(2n));
  }) as unknown as typeof originalFind;
  const old = getSearchCatalogRevisionCached(shop);
  const shared = getSearchCatalogRevisionCached(shop);
  assert.equal(reads, 1, "concurrent cold readers must share one DB SELECT");
  invalidateSearchCatalogRevisionCache(shop);
  assert.equal((await getSearchCatalogRevisionCached(shop))?.catalogRevision, "2");
  releaseOld(row(1n));
  await Promise.all([old, shared]);
  assert.equal((await getSearchCatalogRevisionCached(shop))?.catalogRevision, "2",
    "an old in-flight read must not overwrite the writer's new revision");
  assert.equal(reads, 2);
  invalidateSearchCatalogRevisionCache(shop);
  let attempts = 0;
  settingsDelegate.findUnique = (() => {
    attempts++;
    return attempts === 1 ? Promise.reject(new Error("transient DB failure"))
      : Promise.resolve(row(3n));
  }) as unknown as typeof originalFind;
  await assert.rejects(getSearchCatalogRevisionCached(shop), /transient DB failure/);
  assert.equal((await getSearchCatalogRevisionCached(shop))?.catalogRevision, "3",
    "failed revision reads must not poison future retries");
  assert.equal(attempts, 2);
  invalidateSearchCatalogRevisionCache(shop);
  console.log("PASS: compact profile round-trip, payload parity, bounded storage, revision single-flight/invalidation");
} finally {
  profileDelegate.upsert = originalUpsert;
  settingsDelegate.findUnique = originalFind;
  await db.$disconnect();
}
