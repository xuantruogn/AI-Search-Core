import { createHash } from "node:crypto";
import { getShopSettings } from "../commerce/shop-registry.server";

import type { ProductForIndex } from "./product-document.server";
import { buildProductDocument } from "./product-document.server";
import { composeProductSparseDocument } from "./product-sparse-document.server";
import {
  isProductEnrichmentEnabled,
  prepareProductEmbeddingInput,
  PRODUCT_ENRICHMENT_VERSION,
} from "./product-embedding-input.server";
import { createEmbedding, getEmbeddingDimensions } from "../search/embeddings.server";
import {
  collectProductContextTerms,
  ensureProductShopContext,
  replaceProductShopContextWithTerms,
  replaceProductWithDeterministicShopContext,
} from "../search/shop-context-index.server";
import {
  buildProductVectorSemanticPayload,
  getSemanticProfileForProduct,
  getSemanticProfileState,
  PRODUCT_SEMANTIC_PROFILE_SCHEMA_VERSION,
  PRODUCT_VECTOR_SEMANTIC_PAYLOAD_VERSION,
} from "../search/product-semantic-profile.server";
import {
  bumpSearchCatalogRevision,
  bumpSearchSemanticRevision,
} from "../search/search-catalog-revision.server";
import {
  getProductVectorForShop,
  migrateProductVectorPointIdIfNeeded,
  updateProductVectorPayloadByPointId,
  upsertProductVector,
} from "../search/vector-store.server";
import { getTenantProductVectorPointId } from "../search/vector-id.server";
import { getShopEntitlement } from "../commerce/entitlement.server";
import {
  invalidateDerivedProductSearchCaches,
} from "../theme/theme-search-transport-key.server";
import {
  getIndexedProduct,
  markIneligibleProductMetadata,
  markIndexedProductBlocked,
  markIndexedProductSemanticSourceChanged,
  releaseProductSlotReservation,
  reserveProductSlot,
  stageIndexedProductVectorUpdate,
  upsertIndexedProduct,
  updateIndexedProductEnrichmentState,
} from "../commerce/indexed-products.server";
import {
  commitProductEmbeddingUsage,
  markUsageReservationEffectApplied,
  recordProductEmbeddingConsumed,
  recordUsageEvent,
  reserveProductEmbeddingUsage,
  rollbackProductEmbeddingUsage,
} from "../commerce/usage.server";

export type ProductIndexReason =
  | "INITIAL_SYNC"
  | "WEBHOOK"
  | "PRODUCT_LIMIT_RECOVERY"
  | "SUBSCRIPTION_RECOVERY"
  | "POLICY_RECOVERY"
  | "MANUAL_REINDEX";

export type IndexProductInput = {
  shop: string;
  product: ProductForIndex;
  reason?: ProductIndexReason;
};

export type IndexedProductResult = {
  productId: string;
  handle: string;
  title: string;
  action: "indexed" | "skipped" | "blocked";
  blockedReason?:
    | "PRODUCT_LIMIT"
    | "VECTOR_UPDATE_LIMIT"
    | "SUBSCRIPTION_INACTIVE";
  vectorDimensions: number | null;
  documentHash: string;
};

export function getQdrantPointId(
  shop: string,
  productId: string,
): string {
  return getTenantProductVectorPointId(
    shop,
    productId,
  );
}

export const PRODUCT_EMBEDDING_PIPELINE_VERSION =
  "semantic-product-v9-supply-demand-dense-bm25";

const ENRICHMENT_RETRY_DELAY_MS = 6 * 60 * 60 * 1_000;

function createLegacyProductDocumentHash(
  document: string,
): string {
  return createHash("sha256")
    .update(document, "utf8")
    .digest("hex");
}

export function createProductDocumentHash(
  document: string,
  language: string | null = null,
): string {
  return createProductDocumentHashForVersion(
    document,
    language,
    PRODUCT_EMBEDDING_PIPELINE_VERSION,
  );
}

function createProductDocumentHashForVersion(
  document: string,
  language: string | null,
  pipelineVersion: string,
) {
  return createHash("sha256")
    .update(
      `merchant-language-v1:${
        language ?? "original"
      }:${pipelineVersion}\u0000${document}`,
      "utf8",
    )
    .digest("hex");
}

function refreshDerivedRenderTransportForShop(
  shop: string,
): void {
  invalidateDerivedProductSearchCaches(shop);
}

async function bumpProductSearchRevision(args: {
  shop: string;
  semanticChanged: boolean;
  catalogChanged?: boolean;
}) {
  if (args.semanticChanged) {
    await bumpSearchSemanticRevision(args.shop);
    return;
  }
  if (args.catalogChanged) {
    await bumpSearchCatalogRevision(args.shop);
  }
}

async function ensureDeterministicProductProfile(
  shop: string,
  product: ProductForIndex,
) {
  await ensureProductShopContext({ shop, product });
  refreshDerivedRenderTransportForShop(shop);
}

async function replaceStaleSemanticProfileWithCurrentSource({
  shop,
  product,
  sourceDocumentHash,
}: {
  shop: string;
  product: ProductForIndex;
  sourceDocumentHash: string;
}) {
  await replaceProductWithDeterministicShopContext({ shop, product });
  await markIndexedProductSemanticSourceChanged({
    shop,
    productId: product.id,
    sourceDocumentHash,
  });
  refreshDerivedRenderTransportForShop(shop);
}

export async function indexProduct({
  shop,
  product,
  reason = "WEBHOOK",
}: IndexProductInput): Promise<IndexedProductResult> {
  const document =
    buildProductDocument(product);

  if (!document.trim()) {
    throw new Error(
      `Product document is empty: ${product.id}`,
    );
  }

  const {
    searchLanguage,
  } = await getShopSettings(shop);

  const documentHash =
    createProductDocumentHash(
      document,
      searchLanguage,
    );
  const sourceDocumentHash = createHash("sha256")
    .update(document, "utf8")
    .digest("hex");

  const pointId =
    getQdrantPointId(
      shop,
      product.id,
    );

  const [
    rawExistingVector,
    registryProduct,
    semanticProfileState,
  ] = await Promise.all([
    // Normal sync only needs payload metadata. Pulling the 768D vector for
    // every unchanged webhook/catalog pass wastes Qdrant bandwidth and heap.
    getProductVectorForShop({
      shop,
      productId: product.id,
      withVector: false,
    }),

    getIndexedProduct(
      shop,
      product.id,
    ),

    getSemanticProfileState(
      shop,
      product.id,
    ),
  ]);

  let existingRecord = rawExistingVector;
  if (
    rawExistingVector &&
    String(rawExistingVector.pointId) !== pointId
  ) {
    // Legacy point-id migration is the only path that needs the stored vector.
    // Fetch it lazily instead of making every product sync carry vector bytes.
    const migratableRecord = await getProductVectorForShop({
      shop,
      productId: product.id,
      withVector: true,
    });
    existingRecord = await migrateProductVectorPointIdIfNeeded({
      shop,
      productId: product.id,
      record: migratableRecord,
    });
  } else {
    existingRecord = await migrateProductVectorPointIdIfNeeded({
      shop,
      productId: product.id,
      record: rawExistingVector,
    });
  }

  const existingVector =
    existingRecord?.payload ?? null;
  const semanticSourceChanged =
    registryProduct?.sourceDocumentHash !== sourceDocumentHash;
  const semanticProfileCurrent = Boolean(
    semanticProfileState &&
      semanticProfileState.schemaVersion >=
        PRODUCT_SEMANTIC_PROFILE_SCHEMA_VERSION &&
      registryProduct?.sourceDocumentHash === sourceDocumentHash,
  );
  const existingVectorMetadataNeedsRefresh = (searchable?: boolean) =>
    Boolean(
      existingVector && (
        existingVector.handle !== product.handle ||
        existingVector.title !== product.title ||
        (typeof searchable === "boolean" && existingVector.searchable !== searchable) ||
        (product.priceRange
          ? (
              existingVector.minVariantPrice !== product.priceRange.min ||
              existingVector.maxVariantPrice !== product.priceRange.max ||
              existingVector.currencyCode !== product.priceRange.currencyCode
            )
          : (
              existingVector.minVariantPrice != null ||
              existingVector.maxVariantPrice != null ||
              Boolean(existingVector.currencyCode)
            ))
      ),
    );
  const syncExistingVectorMetadata = async (searchable?: boolean) => {
    if (!existingVector || !existingVectorMetadataNeedsRefresh(searchable)) {
      return false;
    }
    await updateProductVectorPayloadByPointId({
      pointId: existingRecord!.pointId,
      payload: {
        handle: product.handle,
        title: product.title,
        ...(typeof searchable === "boolean" ? { searchable } : {}),
        ...(product.priceRange
          ? {
              minVariantPrice: product.priceRange.min,
              maxVariantPrice: product.priceRange.max,
              currencyCode: product.priceRange.currencyCode,
            }
          : {
              minVariantPrice: null,
              maxVariantPrice: null,
              currencyCode: "",
            }),
      },
    });
    return true;
  };
  const syncExistingVectorSearchable = async (searchable: boolean) => {
    await syncExistingVectorMetadata(searchable);
  };
  const syncExistingVectorSemanticPayload = async () => {
    if (!existingVector) return false;

    if (
      existingVector.semanticPayloadVersion ===
        PRODUCT_VECTOR_SEMANTIC_PAYLOAD_VERSION &&
      semanticProfileCurrent &&
      !semanticSourceChanged
    ) {
      return false;
    }

    const profile = await getSemanticProfileForProduct(shop, product.id);
    const terms =
      profile?.parsed.terms ??
      collectProductContextTerms(product, null);
    const semanticPayload = buildProductVectorSemanticPayload(terms);

    if (
      existingVector.semanticPayloadVersion ===
        semanticPayload.semanticPayloadVersion &&
      existingVector.semanticPayloadHash === semanticPayload.semanticPayloadHash
    ) {
      return false;
    }

    await updateProductVectorPayloadByPointId({
      pointId: existingRecord!.pointId,
      payload: semanticPayload,
    });
    return true;
  };
  const refreshDeterministicProfile = async () => {
    if (semanticSourceChanged) {
      await replaceStaleSemanticProfileWithCurrentSource({
        shop,
        product,
        sourceDocumentHash,
      });
      return true;
    }
    if (!semanticProfileCurrent) {
      await ensureDeterministicProductProfile(shop, product);
      return true;
    }
    return false;
  };

  if (
    registryProduct &&
    !Boolean(registryProduct.searchable) &&
    ["PRODUCT_LIMIT", "SUBSCRIPTION"].includes(registryProduct.blockedReason ?? "")
  ) {
    await markIneligibleProductMetadata({
      shop, productId: product.id, handle: product.handle,
      title: product.title, documentHash,
    });
    await refreshDeterministicProfile();
    await syncExistingVectorSemanticPayload();
    await syncExistingVectorSearchable(false);
    return {
      productId: product.id, handle: product.handle, title: product.title,
      action: "blocked",
      blockedReason: registryProduct.blockedReason === "SUBSCRIPTION"
        ? "SUBSCRIPTION_INACTIVE" : "PRODUCT_LIMIT",
      vectorDimensions: null, documentHash,
    };
  }

  const isPipelineMigration =
    Boolean(
      existingVector &&
        [
          createLegacyProductDocumentHash(
            document,
          ),

          createProductDocumentHashForVersion(
            document,
            searchLanguage,
            "semantic-product-v2",
          ),

          createProductDocumentHashForVersion(
            document,
            searchLanguage,
            "semantic-product-v3-shop-context",
          ),

          createProductDocumentHashForVersion(
            document,
            searchLanguage,
            "semantic-product-v4-general-commerce",
          ),
        ].includes(
          existingVector.documentHash ??
            "",
        ),
    );

  const entitlement =
    await getShopEntitlement(shop);

  const alreadyIndexed =
    existingVector?.shop === shop ||
    Boolean(
      registryProduct?.hasVector,
    );
  const retryAt = registryProduct?.enrichmentRetryAt
    ? new Date(registryProduct.enrichmentRetryAt).getTime()
    : null;
  const enrichmentMigrationDue = Boolean(
    registryProduct?.hasVector &&
      Boolean(registryProduct.searchable) &&
      searchLanguage?.trim() &&
      isProductEnrichmentEnabled() &&
      (
        registryProduct.enrichmentStatus === "BASE_ONLY" ||
        registryProduct.enrichmentVersion !== PRODUCT_ENRICHMENT_VERSION
      ),
  );

  const enrichmentRetryDue = Boolean(
    registryProduct?.hasVector &&
      (
        (
          ["PENDING", "FALLBACK", "FAILED"].includes(
            registryProduct.enrichmentStatus,
          ) &&
          (retryAt === null || retryAt <= Date.now())
        ) ||
        enrichmentMigrationDue
      ),
  );

  // Subscription state is authoritative even when the semantic document has
  // not changed. Keeping a stale registry row marked INDEXED after uninstall,
  // cancellation, or billing suspension makes recovery/accounting misleading.
  if (!entitlement.active) {
    const wasSearchable = Boolean(registryProduct?.searchable);
    await markIndexedProductBlocked({
      shop,
      productId: product.id,
      handle: product.handle,
      title: product.title,
      documentHash,
      reason:
        "SUBSCRIPTION_INACTIVE",
      hasVector: alreadyIndexed,
    });

    await refreshDeterministicProfile();
    await syncExistingVectorSemanticPayload();
    await syncExistingVectorSearchable(false);
    if (wasSearchable) {
      await bumpProductSearchRevision({
        shop,
        semanticChanged: true,
      });
    }

    return {
      productId: product.id,
      handle: product.handle,
      title: product.title,
      action: "blocked",
      blockedReason:
        "SUBSCRIPTION_INACTIVE",
      vectorDimensions: null,
      documentHash,
    };
  }

  if (
    existingVector &&
    existingVector.shop === shop &&
    existingVector.documentHash ===
      documentHash &&
    !enrichmentRetryDue
  ) {
    // Phase-1 -> commercial migration can find Qdrant vectors before the DB
    // registry exists. Reserve a plan slot before adopting that vector so a
    // Basic shop can never silently keep more than its 500-product allowance.
    if (
      !Boolean(registryProduct?.searchable)
    ) {
      const slot =
        await reserveProductSlot({
          shop,

          productId:
            product.id,

          handle:
            product.handle,

          title:
            product.title,

          documentHash,

          productLimit:
            entitlement.limits
              .productLimit,
        });

      if (!slot.allowed) {
        await markIndexedProductBlocked({
          shop,

          productId:
            product.id,

          handle:
            product.handle,

          title:
            product.title,

          documentHash,

          reason:
            "PRODUCT_LIMIT",

          hasVector: true,
        });

        await refreshDeterministicProfile();
        await syncExistingVectorSearchable(false);

        return {
          productId:
            product.id,

          handle:
            product.handle,

          title:
            product.title,

          action:
            "blocked",

          blockedReason:
            "PRODUCT_LIMIT",

          vectorDimensions:
            null,

          documentHash,
        };
      }
    }

    const payloadNeedsRefresh =
      existingVectorMetadataNeedsRefresh(true);

    const registryNeedsRefresh =
      !registryProduct ||
      registryProduct.handle !== product.handle ||
      registryProduct.title !== product.title ||
      registryProduct.status !== "INDEXED" ||
      !Boolean(registryProduct.hasVector) ||
      registryProduct.vectorStatus !== "READY" ||
      !Boolean(registryProduct.searchable) ||
      registryProduct.blockedReason !== null ||
      registryProduct.documentHash !== documentHash;

    // Repair/upgrade the semantic source before re-publishing a previously
    // hidden/stale vector. This is also the crash-recovery path for the
    // two-phase vector publish below.
    const profileRefreshed = await refreshDeterministicProfile();
    const semanticPayloadRefreshed =
      await syncExistingVectorSemanticPayload();

    if (payloadNeedsRefresh) {
      await updateProductVectorPayloadByPointId({
        pointId: existingRecord!.pointId,
        payload: {
          handle: product.handle,
          title: product.title,
          searchable: true,
          ...(product.priceRange
            ? {
                minVariantPrice: product.priceRange.min,
                maxVariantPrice: product.priceRange.max,
                currencyCode: product.priceRange.currencyCode,
              }
            : {
                minVariantPrice: null,
                maxVariantPrice: null,
                currencyCode: "",
              }),
        },
      });
    }

    // Publish the DB registry only after the profile and Qdrant metadata are
    // coherent. This is also the recovery path for a prior STAGING crash.
    await upsertIndexedProduct({
      shop,
      productId: product.id,
      handle: product.handle,
      title: product.title,
      documentHash,
      vectorWritten: false,
      touchSearchState:
        registryNeedsRefresh ||
        payloadNeedsRefresh ||
        profileRefreshed ||
        semanticPayloadRefreshed,
    });

    await bumpProductSearchRevision({
      shop,
      semanticChanged:
        registryNeedsRefresh ||
        profileRefreshed ||
        semanticPayloadRefreshed,
      catalogChanged: payloadNeedsRefresh,
    });

    console.log(
      "[AI Search] Embedding unchanged, skipping:",
      product.handle,
    );

    return {
      productId:
        product.id,

      handle:
        product.handle,

      title:
        product.title,

      action:
        "skipped",

      vectorDimensions:
        null,

      documentHash,
    };
  }

  // New products reserve a Basic-plan catalog slot before any paid OpenAI
  // work. The reservation status is persisted, so concurrent workers count it.
  let productSlotReserved =
    false;

  if (!Boolean(registryProduct?.searchable)) {
    const slot =
      await reserveProductSlot({
        shop,

        productId:
          product.id,

        handle:
          product.handle,

        title:
          product.title,

        documentHash,

        productLimit:
          entitlement.limits
            .productLimit,
      });

    if (!slot.allowed) {
      await markIndexedProductBlocked({
        shop,

        productId:
          product.id,

        handle:
          product.handle,

        title:
          product.title,

        documentHash,

        reason:
          "PRODUCT_LIMIT",

        hasVector:
          false,
      });

      await refreshDeterministicProfile();

      console.log(
        "[AI Search] Product blocked by plan product limit:",
        {
          shop,

          productId:
            product.id,

          handle:
            product.handle,

          limit:
            entitlement.limits
              .productLimit,
        },
      );

      return {
        productId:
          product.id,

        handle:
          product.handle,

        title:
          product.title,

        action:
          "blocked",

        blockedReason:
          "PRODUCT_LIMIT",

        vectorDimensions:
          null,

        documentHash,
      };
    }

    productSlotReserved =
      slot.reserved;
  }

  // Re-embedding unchanged product data for this pipeline migration does not
  // consume the merchant's monthly product-update quota.
  // Product capacity controls how many products may own vectors. Creating the
  // first vector for any product inside that capacity is catalog bootstrap,
  // not a vector update. The monthly vector-update quota applies only when an
  // existing vector must be regenerated after product data changes.
  const countAsVectorUpdate =
    alreadyIndexed &&
    reason !==
      "INITIAL_SYNC" &&
    !isPipelineMigration &&
    !enrichmentRetryDue;

  // If the monthly vector-update quota is already exhausted, keep serving a
  // retained cached vector instead of creating another blocked reservation.
  // The vector remains STALE and can be refreshed after quota recovery.
  if (
    countAsVectorUpdate &&
    alreadyIndexed &&
    !entitlement.vectorUpdateAllowed
  ) {
    await markIndexedProductBlocked({
      shop,
      productId: product.id,
      handle: product.handle,
      title: product.title,
      documentHash:
        registryProduct?.documentHash ??
        existingVector?.documentHash ??
        documentHash,
      reason: "VECTOR_UPDATE_LIMIT",
      hasVector: true,
    });

    const profileRefreshed = await refreshDeterministicProfile();
    const semanticPayloadRefreshed =
      await syncExistingVectorSemanticPayload();
    const payloadRefreshed = await syncExistingVectorMetadata(true);
    await bumpProductSearchRevision({
      shop,
      semanticChanged:
        profileRefreshed ||
        semanticPayloadRefreshed ||
        registryProduct?.handle !== product.handle ||
        registryProduct?.title !== product.title,
      catalogChanged: payloadRefreshed,
    });

    console.log("[AI Search] Product vector refresh deferred; cached vector retained:", {
      shop,
      productId: product.id,
      handle: product.handle,
      indexReason: reason,
    });

    return {
      productId: product.id,
      handle: product.handle,
      title: product.title,
      action: "skipped",
      vectorDimensions: null,
      documentHash,
    };
  }

  const reservationResult =
    await reserveProductEmbeddingUsage({
      shop,

      periodId:
        entitlement.usage.id,

      vectorUpdateLimit:
        entitlement.limits
          .vectorUpdateLimit,

      productId:
        product.id,

      countAsVectorUpdate,
    });

  if (
    !reservationResult.allowed
  ) {
    if (
      productSlotReserved
    ) {
      await releaseProductSlotReservation(
        shop,
        product.id,
      );
    }

    await markIndexedProductBlocked({
      shop,

      productId:
        product.id,

      handle:
        product.handle,

      title:
        product.title,

      documentHash,

      reason:
        "VECTOR_UPDATE_LIMIT",

      hasVector:
        alreadyIndexed,
    });

    const profileRefreshed = await refreshDeterministicProfile();
    const semanticPayloadRefreshed = alreadyIndexed
      ? await syncExistingVectorSemanticPayload()
      : false;
    const payloadRefreshed = alreadyIndexed
      ? await syncExistingVectorMetadata(true)
      : false;
    if (alreadyIndexed) {
      await bumpProductSearchRevision({
        shop,
        semanticChanged:
          profileRefreshed ||
          semanticPayloadRefreshed ||
          registryProduct?.handle !== product.handle ||
          registryProduct?.title !== product.title,
        catalogChanged: payloadRefreshed,
      });
    }

    console.log(
      "[AI Search] Product vector update blocked by quota:",
      {
        shop,

        productId:
          product.id,

        handle:
          product.handle,

        indexReason:
          reason,

        countAsVectorUpdate,
      },
    );

    return {
      productId:
        product.id,

      handle:
        product.handle,

      title:
        product.title,

      action:
        "blocked",

      blockedReason:
        "VECTOR_UPDATE_LIMIT",

      vectorDimensions:
        null,

      documentHash,
    };
  }

  const reservation =
    reservationResult.reservation;

  let vectorWriteSucceeded =
    false;
  let preparedEmbeddingInput:
    | Awaited<ReturnType<typeof prepareProductEmbeddingInput>>
    | null = null;
  let preparedSemanticTerms:
    | ReturnType<typeof collectProductContextTerms>
    | null = null;

  try {
    console.log(
      "[AI Search] Embedding product:",
      product.handle,
    );

    preparedEmbeddingInput =
      await prepareProductEmbeddingInput(
        document,
        searchLanguage,
        shop,
        product,
      );
    const embeddingInput = preparedEmbeddingInput;
    preparedSemanticTerms = collectProductContextTerms(
      product,
      embeddingInput.analysis,
    );
    const sparseDocument = composeProductSparseDocument({
      product,
      analysis: embeddingInput.analysis,
    });
    const semanticPayload =
      buildProductVectorSemanticPayload(preparedSemanticTerms);

    const logEmbeddingInput =
      process.env
        .AI_SEARCH_LOG_EMBEDDING_INPUT
        ?.trim()
        .toLowerCase() ??
      "";

    if (
      [
        "1",
        "true",
        "yes",
        "on",
      ].includes(
        logEmbeddingInput,
      )
    ) {
      console.log(
        "[AI Search][PRODUCT EMBEDDING INPUT]",
        {
          shop,

          productId:
            product.id,

          handle:
            product.handle,

          enriched:
            embeddingInput.enriched,

          enrichmentModel:
            embeddingInput.model,

          analysis:
            embeddingInput.analysis,

          input:
            embeddingInput.document,
        },
      );
    }

    const vector =
      await createEmbedding(
        embeddingInput.document,
      {
          usageContext: {
            shop,
            operation: "PRODUCT_EMBEDDING",
          },
        },
      );

    try {
      await recordProductEmbeddingConsumed(
        reservation,
      );
    } catch (usageError) {
      // Cost telemetry is important but should not discard a valid OpenAI
      // response. The core index operation can continue and the operational
      // log makes the accounting gap visible.
      console.error(
        "[AI Search] Product embedding usage logging failed:",
        {
          shop,

          productId:
            product.id,

          error:
            usageError instanceof
            Error
              ? usageError.message
              : String(
                  usageError,
                ),
        },
      );
    }

    if (
      vector.length !== getEmbeddingDimensions()
    ) {
      throw new Error(
        `Unexpected embedding size: ${vector.length}`,
      );
    }

    await upsertProductVector({
      pointId,
      vector,
      sparseDocument,

      payload: {
        shop,

        productId:
          product.id,

        handle:
          product.handle,

        title:
          product.title,

        documentHash,

        // Publish in two phases. The vector stays hidden until the registry,
        // semantic profile and enrichment state are durable.
        searchable: false,

        indexedAt:
          new Date().toISOString(),

        usageReservationId:
          reservation.id,

        ...semanticPayload,

        ...(product.priceRange
          ? {
              minVariantPrice:
                product
                  .priceRange
                  .min,

              maxVariantPrice:
                product
                  .priceRange
                  .max,

              currencyCode:
                product
                  .priceRange
                  .currencyCode,
            }
          : {}),
      },
    });

    vectorWriteSucceeded =
      true;

    // Persist that the billable/effective vector write happened before any
    // secondary registry/event work. If the process dies after this point,
    // the usage reservation reconciler will commit rather than refund quota.
    await markUsageReservationEffectApplied(
      reservation,
    );

    // Stage the DB registry as non-searchable while the profile is being
    // committed. This closes the old race where structured DB retrieval could
    // observe a new registry state together with an old/missing profile.
    await stageIndexedProductVectorUpdate({
      shop,
      productId: product.id,
      handle: product.handle,
      title: product.title,
      documentHash,
    });

    await replaceProductShopContextWithTerms({
      shop,
      productId: product.id,
      analysis: embeddingInput.analysis,
      terms: preparedSemanticTerms,
    });

    await updateIndexedProductEnrichmentState({
      shop,
      productId: product.id,
      sourceDocumentHash,
      embeddingPipelineVersion: PRODUCT_EMBEDDING_PIPELINE_VERSION,
      enrichmentVersion: PRODUCT_ENRICHMENT_VERSION,
      enrichmentStatus: embeddingInput.enrichmentStatus,
      enrichmentLastError: embeddingInput.enrichmentError,
      enrichmentRetryAt:
        embeddingInput.enrichmentStatus === "FALLBACK"
          ? new Date(Date.now() + ENRICHMENT_RETRY_DELAY_MS)
          : null,
    });

    // Native-render transport keys are derived from the updated semantic
    // profile, so only the per-shop derived cache needs invalidation.
    refreshDerivedRenderTransportForShop(shop);

    // Phase 2 publish: expose Qdrant only after the authoritative DB profile
    // is durable, then publish the DB registry. Advance the semantic revision
    // only AFTER both stores are searchable; otherwise another process could
    // rebuild the new revision while this product is still staged/hidden and
    // keep an incomplete semantic cache until its safety TTL expires.
    await updateProductVectorPayloadByPointId({
      pointId,
      payload: { searchable: true },
    });

    await upsertIndexedProduct({
      shop,
      productId: product.id,
      handle: product.handle,
      title: product.title,
      documentHash,
    });

    await bumpProductSearchRevision({
      shop,
      semanticChanged: true,
    });

    try {
      await commitProductEmbeddingUsage(
        reservation,
        {
          reason,

          vectorDimensions:
            vector.length,
        },
      );
    } catch (usageError) {
      // Vector + registry are already durable. Do not create a retry storm just
      // because analytics/event logging failed after the core operation.
      console.error(
        "[AI Search] Product usage commit logging failed:",
        {
          shop,

          productId:
            product.id,

          error:
            usageError instanceof
            Error
              ? usageError.message
              : String(
                  usageError,
                ),
        },
      );
    }

    console.log(
      "[AI Search] Product vector updated:",
      product.handle,
    );

    return {
      productId:
        product.id,

      handle:
        product.handle,

      title:
        product.title,

      action:
        "indexed",

      vectorDimensions:
        vector.length,

      documentHash,
    };
  } catch (error) {
    if (
      vectorWriteSucceeded
    ) {
      // The billable vector write already happened. Never expose the DB
      // registry before the profile is repaired: structured retrieval reads the
      // DB profile while vector retrieval reads Qdrant, so publication must
      // remain fail-closed across both stores.
      try {
        await stageIndexedProductVectorUpdate({
          shop,
          productId: product.id,
          handle: product.handle,
          title: product.title,
          documentHash,
        });
      } catch (registryError) {
        console.error("[AI Search] Post-vector staging repair failed:", {
          shop,
          productId: product.id,
          error:
            registryError instanceof Error
              ? registryError.message
              : String(registryError),
        });
      }

      if (preparedEmbeddingInput && preparedSemanticTerms) {
        try {
          await replaceProductShopContextWithTerms({
            shop,
            productId: product.id,
            analysis: preparedEmbeddingInput.analysis,
            terms: preparedSemanticTerms,
          });
          await updateIndexedProductEnrichmentState({
            shop,
            productId: product.id,
            sourceDocumentHash,
            embeddingPipelineVersion: PRODUCT_EMBEDDING_PIPELINE_VERSION,
            enrichmentVersion: PRODUCT_ENRICHMENT_VERSION,
            enrichmentStatus: preparedEmbeddingInput.enrichmentStatus,
            enrichmentLastError: preparedEmbeddingInput.enrichmentError,
            enrichmentRetryAt:
              preparedEmbeddingInput.enrichmentStatus === "FALLBACK"
                ? new Date(Date.now() + ENRICHMENT_RETRY_DELAY_MS)
                : null,
          });
          refreshDerivedRenderTransportForShop(shop);
          await updateProductVectorPayloadByPointId({
            pointId,
            payload: { searchable: true },
          });
          await upsertIndexedProduct({
            shop,
            productId: product.id,
            handle: product.handle,
            title: product.title,
            documentHash,
          });
        } catch (profileRepairError) {
          // If any publication step fails, hide Qdrant again. The durable sync
          // job will retry and the registry remains STAGING/non-searchable.
          try {
            await updateProductVectorPayloadByPointId({
              pointId,
              payload: { searchable: false },
            });
          } catch {
            // Preserve the original post-processing error.
          }
          console.error("[AI Search] Post-vector semantic-profile repair failed:", {
            shop,
            productId: product.id,
            error:
              profileRepairError instanceof Error
                ? profileRepairError.message
                : String(profileRepairError),
          });
        }
      } else {
        try {
          await updateProductVectorPayloadByPointId({
            pointId,
            payload: { searchable: false },
          });
        } catch {
          // The next durable retry reconciles both stores.
        }
      }

      try {
        await bumpProductSearchRevision({
          shop,
          semanticChanged: true,
        });
      } catch (revisionError) {
        console.error("[AI Search] Post-vector catalog revision bump failed:", {
          shop,
          productId: product.id,
          error:
            revisionError instanceof Error
              ? revisionError.message
              : String(revisionError),
        });
      }

      try {
        await commitProductEmbeddingUsage(
          reservation,
          {
            reason,

            recoveredFromPostprocessError:
              true,
          },
        );
      } catch (
        usageCommitError
      ) {
        console.error(
          "[AI Search] Post-vector usage commit failed:",
          {
            shop,

            productId:
              product.id,

            error:
              usageCommitError instanceof
              Error
                ? usageCommitError.message
                : String(
                    usageCommitError,
                  ),
          },
        );
      }

      try {
        await recordUsageEvent({
          shop,

          periodId:
            reservation.periodId,

          type:
            "VECTOR_WRITE_POSTPROCESS_ERROR",

          success:
            false,

          productId:
            product.id,

          metadata: {
            reason,

            error:
              error instanceof
              Error
                ? error.message
                : String(
                    error,
                  ),
          },
        });
      } catch {
        // Preserve the original failure; usage event logging is best effort in
        // this narrow post-write recovery path.
      }
    } else {
      await rollbackProductEmbeddingUsage(
        reservation,
        error,
      );

      if (
        productSlotReserved
      ) {
        await releaseProductSlotReservation(
          shop,
          product.id,
        );
      }
    }

    throw error;
  }
}
