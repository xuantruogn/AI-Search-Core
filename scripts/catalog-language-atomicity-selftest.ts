import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import db from "../app/db.server";
import {
  activateCompletedCatalogLanguage,
  catalogLanguageProofCompatible,
  catalogLanguageSearchReady,
  readCatalogLanguageState,
  requestCatalogLanguageChange,
  resolveCatalogIndexLanguage,
  tryActivatePendingCatalogLanguage,
} from "../app/services/catalog/catalog-language.server";
import { PRODUCT_ENRICHMENT_VERSION } from "../app/services/products/product-embedding-input.server";
import { PRODUCT_EMBEDDING_PIPELINE_VERSION } from "../app/services/products/product-index-version.server";

const shop = `language-regression-${Date.now()}.myshopify.com`;

try {
  await db.$executeRaw`
    INSERT INTO AiSearchShop (shop, createdAt, updatedAt)
    VALUES (${shop}, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))
  `;
  await db.$executeRaw`
    INSERT INTO AiSearchShopSettings (
      shop, searchLanguage, pendingCatalogLanguage, createdAt, updatedAt
    ) VALUES (
      ${shop}, 'en', 'vi', UTC_TIMESTAMP(3), UTC_TIMESTAMP(3)
    )
  `;
  await db.$executeRaw`
    INSERT INTO AiSearchCatalogSyncJob (
      shop, reason, languageAtStart, status, createdAt, updatedAt
    ) VALUES (
      ${shop}, 'LANGUAGE_CHANGE', 'vi', 'DONE', UTC_TIMESTAMP(3), UTC_TIMESTAMP(3)
    )
  `;

  const jobs = await db.$queryRaw<Array<{ id: number }>>`
    SELECT id FROM AiSearchCatalogSyncJob WHERE shop = ${shop}
  `;
  const id = jobs[0].id;

  await db.$executeRaw`
    INSERT INTO AiSearchIndexedProduct (
      shop, productId, handle, title, searchable, hasVector, vectorStatus,
      catalogLanguage, enrichmentVersion, embeddingPipelineVersion,
      createdAt, updatedAt
    ) VALUES (
      ${shop}, 'gid://shopify/Product/1', 'fixture', 'Fixture', true, true, 'READY',
      'en', ${PRODUCT_ENRICHMENT_VERSION}, ${PRODUCT_EMBEDDING_PIPELINE_VERSION},
      UTC_TIMESTAMP(3), UTC_TIMESTAMP(3)
    )
  `;

  assert.equal(
    await activateCompletedCatalogLanguage(id),
    false,
    "mixed index cannot activate",
  );
  assert.equal((await readCatalogLanguageState(shop)).searchLanguage, "en");
  assert.equal(await catalogLanguageSearchReady(shop), false);

  assert.equal(
    resolveCatalogIndexLanguage("en", {
      searchLanguage: "en",
      pendingCatalogLanguage: null,
    }),
    "en",
  );
  assert.equal(
    resolveCatalogIndexLanguage("en", {
      searchLanguage: "vi",
      pendingCatalogLanguage: "vi",
    }),
    "en",
    "job snapshot survives live setting changes",
  );
  assert.equal(
    resolveCatalogIndexLanguage(null, {
      searchLanguage: "vi",
      pendingCatalogLanguage: null,
    }),
    null,
    "null snapshot must not reread current language",
  );

  await assert.rejects(
    requestCatalogLanguageChange(shop, "fr"),
    /subscription/,
    "inactive entitlement must not silently schedule or change language",
  );
  assert.equal(
    await catalogLanguageProofCompatible(shop),
    false,
    "pending index cannot prove absence",
  );

  // The full scan may finish with a failed item. Its catalog-specific retry is
  // durable and must keep activation pending until that retry completes.
  await db.$executeRaw`
    UPDATE AiSearchIndexedProduct
    SET catalogLanguage = 'vi'
    WHERE shop = ${shop}
  `;
  await db.$executeRaw`
    UPDATE AiSearchCatalogSyncJob
    SET productsFailed = 1
    WHERE id = ${id}
  `;
  const retryWebhook = `catalog-product-retry:${id}:1:gid://shopify/Product/1`;
  await db.$executeRaw`
    INSERT INTO AiSearchSyncJob (
      shop, webhookId, topic, productId, status, attempts, createdAt, updatedAt
    ) VALUES (
      ${shop}, ${retryWebhook}, 'PRODUCTS_UPDATE',
      'gid://shopify/Product/1', 'PENDING', 0, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3)
    )
  `;
  assert.equal(
    await activateCompletedCatalogLanguage(id),
    false,
    "unfinished catalog retry must block activation",
  );

  await db.$executeRaw`
    UPDATE AiSearchSyncJob
    SET status = 'DONE', processedAt = UTC_TIMESTAMP(3), updatedAt = UTC_TIMESTAMP(3)
    WHERE webhookId = ${retryWebhook}
  `;

  // A currently eligible recovery/staging row must also block publication even
  // after the historical failed retry has completed.
  await db.$executeRaw`
    UPDATE AiSearchIndexedProduct
    SET status = 'VECTOR_QUOTA_BLOCKED',
        searchable = false,
        hasVector = false,
        vectorStatus = 'MISSING',
        blockedReason = NULL
    WHERE shop = ${shop}
  `;
  assert.equal(
    await tryActivatePendingCatalogLanguage(shop),
    false,
    "eligible vector recovery must finish before activation",
  );

  await db.$executeRaw`
    UPDATE AiSearchIndexedProduct
    SET status = 'INDEXED',
        searchable = true,
        hasVector = true,
        vectorStatus = 'READY',
        blockedReason = NULL,
        catalogLanguage = 'vi',
        enrichmentVersion = ${PRODUCT_ENRICHMENT_VERSION},
        embeddingPipelineVersion = ${PRODUCT_EMBEDDING_PIPELINE_VERSION}
    WHERE shop = ${shop}
  `;

  assert.equal(
    await tryActivatePendingCatalogLanguage(shop),
    true,
    "completed product recovery must automatically make a DONE language scan publishable",
  );

  const historical = await db.$queryRaw<Array<{ productsFailed: number }>>`
    SELECT productsFailed FROM AiSearchCatalogSyncJob WHERE id = ${id}
  `;
  assert.equal(
    historical[0]?.productsFailed,
    1,
    "historical scan diagnostics remain intact after recovery",
  );

  const activated = await readCatalogLanguageState(shop);
  assert.equal(activated.searchLanguage, "vi");
  assert.equal(activated.pendingCatalogLanguage, null);
  assert.ok(activated.catalogLanguageVerifiedAt);
  assert.equal(await catalogLanguageProofCompatible(shop), true);
  assert.equal(await catalogLanguageSearchReady(shop), true);

  await db.$executeRaw`
    UPDATE AiSearchIndexedProduct
    SET catalogLanguage = NULL
    WHERE shop = ${shop}
  `;
  assert.equal(
    await catalogLanguageProofCompatible(shop),
    false,
    "legacy metadata cannot prove absence",
  );
  assert.equal(
    await catalogLanguageSearchReady(shop),
    false,
    "stale retained vector recovery fails open after activation",
  );

  await db.$executeRaw`
    UPDATE AiSearchIndexedProduct
    SET catalogLanguage = 'vi',
        enrichmentVersion = 'obsolete'
    WHERE shop = ${shop}
  `;
  assert.equal(
    await catalogLanguageProofCompatible(shop),
    false,
    "obsolete version cannot prove absence",
  );

  await db.$executeRaw`
    UPDATE AiSearchIndexedProduct
    SET searchable = false,
        blockedReason = 'PRODUCT_LIMIT'
    WHERE shop = ${shop}
  `;
  assert.equal(
    await catalogLanguageProofCompatible(shop),
    true,
    "retained over-limit vectors are not search-eligible",
  );

  const pipeline = readFileSync(
    "app/services/search/parallel-query-pipeline.server.ts",
    "utf8",
  );
  assert.ok(
    !pipeline.includes("earlyNoResult: true"),
    "RAW proof must not terminate before family recovery",
  );

  const proxy = readFileSync("app/routes/proxy.ai-search.ts", "utf8");
  assert.ok(
    proxy.indexOf(
      "const completeFamilyLookup = await retrieveCompleteFamilyCandidates",
    ) < proxy.indexOf('finalProof?.status === "CERTAIN_NO_RESULT"'),
  );

  const languageService = readFileSync(
    "app/services/catalog/catalog-language.server.ts",
    "utf8",
  );
  assert.match(
    languageService,
    /resource:\s*"catalog:enqueue"/,
    "language changes must serialize through the normal catalog enqueue lease",
  );

  const productJobs = readFileSync(
    "app/services/products/product-sync-job.server.ts",
    "utf8",
  );
  assert.match(
    productJobs,
    /webhookId: cleanWebhookId/,
    "each distinct Shopify delivery or catalog retry retains a durable unique webhook ID",
  );
  assert.doesNotMatch(
    productJobs,
    /pendingLiveStateJob/,
    "new product updates must never be dropped during a worker PENDING-to-PROCESSING race",
  );

  const processor = readFileSync(
    "app/services/products/product-sync-job-processor.server.ts",
    "utf8",
  );
  assert.match(
    processor,
    /tryActivatePendingCatalogLanguage/,
    "successful product recovery must recheck pending language activation",
  );

  console.log(
    "Catalog language activation / recovery / enqueue serialization / zero-result regressions PASS",
  );
} finally {
  await db.$executeRaw`DELETE FROM AiSearchShop WHERE shop = ${shop}`;
  await db.$disconnect();
}
