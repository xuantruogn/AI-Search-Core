import { createHash } from "node:crypto";
import { getShopSettings } from "../commerce/shop-registry.server";

import type { ProductForIndex } from "./product-document.server";
import { buildProductDocument } from "./product-document.server";
import { prepareProductEmbeddingInput } from "./product-embedding-input.server";
import { createEmbedding } from "../search/embeddings.server";
import {
  ensureProductShopContext,
  replaceProductShopContext,
} from "../search/shop-context-index.server";
import {
  deleteProductVectorForShop,
  getProductVectorForShop,
  migrateProductVectorPointIdIfNeeded,
  updateProductVectorPayloadForShop,
  upsertProductVector,
} from "../search/vector-store.server";
import { getTenantProductVectorPointId } from "../search/vector-id.server";
import { getShopEntitlement } from "../commerce/entitlement.server";
import {
  replaceProductThemeSearchTransportKeys,
} from "../theme/theme-search-transport-key.server";
import {
  getIndexedProduct,
  markIndexedProductBlocked,
  releaseProductSlotReservation,
  reserveProductSlot,
  upsertIndexedProduct,
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

const PRODUCT_EMBEDDING_PIPELINE_VERSION =
  "semantic-product-v5-canonical-shop-type";

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

async function replaceRenderTransportKeysForProduct(
  shop: string,
  product: ProductForIndex,
): Promise<void> {
  await replaceProductThemeSearchTransportKeys({
    shop,

    product: {
      productId: product.id,
      handle: product.handle,
      title: product.title,
      vendor: product.vendor,
      productType: product.productType,
      tags: product.tags,
      variants: product.variants,
    },
  });
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

  const pointId =
    getQdrantPointId(
      shop,
      product.id,
    );

  const [
    rawExistingVector,
    registryProduct,
  ] = await Promise.all([
    getProductVectorForShop({
      shop,
      productId: product.id,
      withVector: true,
    }),

    getIndexedProduct(
      shop,
      product.id,
    ),
  ]);

  const existingRecord =
    await migrateProductVectorPointIdIfNeeded({
      shop,
      productId: product.id,
      record: rawExistingVector,
    });

  const existingVector =
    existingRecord?.payload ?? null;

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

  // Subscription state is authoritative even when the semantic document has
  // not changed. Keeping a stale registry row marked INDEXED after uninstall,
  // cancellation, or billing suspension makes recovery/accounting misleading.
  if (!entitlement.active) {
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
      documentHash
  ) {
    // Phase-1 -> commercial migration can find Qdrant vectors before the DB
    // registry exists. Reserve a plan slot before adopting that vector so a
    // Basic shop can never silently keep more than its 500-product allowance.
    if (
      !registryProduct?.hasVector
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
        await deleteProductVectorForShop({
          shop,
          productId:
            product.id,
        });

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

    await upsertIndexedProduct({
      shop,

      productId:
        product.id,

      handle:
        product.handle,

      title:
        product.title,

      documentHash,
    });

    const payloadNeedsRefresh =
      existingVector.handle !==
        product.handle ||
      existingVector.title !==
        product.title ||
      (
        product.priceRange !==
          null &&
        product.priceRange !==
          undefined &&
        (
          existingVector
            .minVariantPrice !==
            product.priceRange.min ||
          existingVector
            .maxVariantPrice !==
            product.priceRange.max ||
          existingVector
            .currencyCode !==
            product.priceRange
              .currencyCode
        )
      );

    if (
      payloadNeedsRefresh
    ) {
      await updateProductVectorPayloadForShop({
        shop,

        productId:
          product.id,

        payload: {
          handle:
            product.handle,

          title:
            product.title,

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
    }

    await ensureProductShopContext({
      shop,
      product,
    });

    // Render Transport Key không phụ thuộc document hash.
    // Dù embedding không đổi, SKU / barcode / vendor /
    // productType / tags vẫn phải được refresh.
    await replaceRenderTransportKeysForProduct(
      shop,
      product,
    );

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

  if (!alreadyIndexed) {
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
  const countAsVectorUpdate =
    reason !==
      "INITIAL_SYNC" &&
    !isPipelineMigration;

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

    console.log(
      "[AI Search] Product vector update blocked by quota:",
      {
        shop,

        productId:
          product.id,

        handle:
          product.handle,
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

  try {
    console.log(
      "[AI Search] Embedding product:",
      product.handle,
    );

    const embeddingInput =
      await prepareProductEmbeddingInput(
        document,
        searchLanguage,
      );

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
      vector.length !== 768
    ) {
      throw new Error(
        `Unexpected embedding size: ${vector.length}`,
      );
    }

    await upsertProductVector({
      pointId,
      vector,

      payload: {
        shop,

        productId:
          product.id,

        handle:
          product.handle,

        title:
          product.title,

        documentHash,

        indexedAt:
          new Date().toISOString(),

        usageReservationId:
          reservation.id,

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

    await upsertIndexedProduct({
      shop,

      productId:
        product.id,

      handle:
        product.handle,

      title:
        product.title,

      documentHash,
    });

    await replaceProductShopContext({
      shop,
      product,
      analysis:
        embeddingInput.analysis,
    });

    // Product đã được index thành công.
    // Tạo lại các search transport signature dùng cho
    // native Section Rendering transport.
    await replaceRenderTransportKeysForProduct(
      shop,
      product,
    );

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
      // The billable work and actual vector update already happened. Keep the
      // reserved counters so retries cannot double-discount real usage. Make a
      // best-effort repair of the registry; the next retry will hash-skip.
      try {
        await upsertIndexedProduct({
          shop,

          productId:
            product.id,

          handle:
            product.handle,

          title:
            product.title,

          documentHash,
        });
      } catch (
        registryError
      ) {
        console.error(
          "[AI Search] Post-vector registry repair failed:",
          {
            shop,

            productId:
              product.id,

            error:
              registryError instanceof
              Error
                ? registryError.message
                : String(
                    registryError,
                  ),
          },
        );
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