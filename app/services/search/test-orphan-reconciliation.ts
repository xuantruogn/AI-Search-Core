import db from "../../db.server";

import {
  deleteProductVectorForShop,
  getProductVectorForShop,
  reconcileOrphanProductVectorsForShop,
  upsertProductVector,
} from "./vector-store.server";

import {
  getTenantProductVectorPointId,
} from "./vector-id.server";

const SHOP =
  "add-get-d-test.myshopify.com";

const FAKE_PRODUCT_ID =
  "gid://shopify/Product/999999999999991";

async function main() {
  console.log(
    "\n=== FIND VALID SOURCE VECTOR ===",
  );

  const sourceRegistry =
    await db.aiSearchIndexedProduct.findFirst({
      where: {
        shop: SHOP,
        status: "INDEXED",
        hasVector: true,
      },

      select: {
        productId: true,
        handle: true,
        title: true,
      },
    });

  if (!sourceRegistry) {
    throw new Error(
      "No valid indexed product found for reconciliation test",
    );
  }

  console.log(
    "SOURCE REGISTRY:",
    sourceRegistry,
  );

  const sourceVector =
    await getProductVectorForShop({
      shop: SHOP,
      productId:
        sourceRegistry.productId,
      withVector: true,
    });

  if (
    !sourceVector ||
    !sourceVector.vector ||
    sourceVector.vector.length === 0
  ) {
    throw new Error(
      `Source vector missing for ${sourceRegistry.productId}`,
    );
  }

  console.log({
    sourceProductId:
      sourceRegistry.productId,

    vectorExists:
      true,

    dimensions:
      sourceVector.vector.length,
  });

  // ============================================================
  // ENSURE TEST PRODUCT DOES NOT EXIST IN REGISTRY
  // ============================================================

  const accidentalRegistry =
    await db.aiSearchIndexedProduct.findFirst({
      where: {
        shop: SHOP,
        productId:
          FAKE_PRODUCT_ID,
      },
    });

  if (accidentalRegistry) {
    throw new Error(
      `Fake reconciliation product unexpectedly exists in DB: ${FAKE_PRODUCT_ID}`,
    );
  }

  // ============================================================
  // CLEAN ANY OLD TEST POINT
  // ============================================================

  await deleteProductVectorForShop({
    shop: SHOP,
    productId:
      FAKE_PRODUCT_ID,
  });

  // ============================================================
  // CREATE CONTROLLED ORPHAN
  //
  // Reuse a valid vector so no OpenAI call is needed.
  //
  // indexedAt is deliberately older than the default 5-minute
  // grace period so reconciler is allowed to remove it.
  // ============================================================

  const oldIndexedAt =
    new Date(
      Date.now() -
        60 * 60 * 1000,
    ).toISOString();

  await upsertProductVector({
    pointId:
      getTenantProductVectorPointId(
        SHOP,
        FAKE_PRODUCT_ID,
      ),

    vector:
      sourceVector.vector,

    payload: {
      shop:
        SHOP,

      productId:
        FAKE_PRODUCT_ID,

      handle:
        "__ai_orphan_reconciliation_test__",

      title:
        "AI Orphan Reconciliation Test",

      documentHash:
        "orphan-reconciliation-test",

      indexedAt:
        oldIndexedAt,
    },
  });

  const orphanBefore =
    await getProductVectorForShop({
      shop: SHOP,
      productId:
        FAKE_PRODUCT_ID,
      withVector: false,
    });

  console.log(
    "\n=== CONTROLLED ORPHAN BEFORE ===",
  );

  console.log({
    productId:
      FAKE_PRODUCT_ID,

    exists:
      Boolean(
        orphanBefore,
      ),

    indexedAt:
      orphanBefore
        ?.payload
        .indexedAt ??
      null,
  });

  if (!orphanBefore) {
    throw new Error(
      "Failed to create controlled orphan vector",
    );
  }

  // ============================================================
  // RUN PRODUCTION RECONCILER
  // ============================================================

  console.log(
    "\n=== RUN RECONCILIATION ===",
  );

  const result =
    await reconcileOrphanProductVectorsForShop({
      shop:
        SHOP,

      batchSize:
        100,
    });

  console.dir(
    result,
    {
      depth: null,
    },
  );

  // ============================================================
  // VERIFY ORPHAN WAS DELETED
  // ============================================================

  const orphanAfter =
    await getProductVectorForShop({
      shop:
        SHOP,

      productId:
        FAKE_PRODUCT_ID,

      withVector:
        false,
    });

  // Also prove the real source vector survived.
  const sourceAfter =
    await getProductVectorForShop({
      shop:
        SHOP,

      productId:
        sourceRegistry.productId,

      withVector:
        false,
    });

  console.log(
    "\n=== VERIFY ===",
  );

  console.log({
    orphanProductId:
      FAKE_PRODUCT_ID,

    orphanExistsAfter:
      Boolean(
        orphanAfter,
      ),

    sourceProductId:
      sourceRegistry.productId,

    sourceStillExists:
      Boolean(
        sourceAfter,
      ),

    removedPoints:
      result.removedPoints,

    removedProductIds:
      result.removedProductIds,

    scannedPoints:
      result.scannedPoints,

    validPoints:
      result.validPoints,

    malformedPointsRemoved:
      result.malformedPointsRemoved,

    recentPointsSkipped:
      result.recentPointsSkipped,
  });

  if (orphanAfter) {
    throw new Error(
      "FAIL: controlled orphan survived reconciliation",
    );
  }

  if (!sourceAfter) {
    throw new Error(
      "FAIL: valid source vector was deleted",
    );
  }

  if (
    !result.removedProductIds.includes(
      FAKE_PRODUCT_ID,
    )
  ) {
    throw new Error(
      "FAIL: reconciliation result did not report controlled orphan",
    );
  }

  console.log(
    "\nPASS: orphan reconciliation works and valid vector survived.",
  );
}

main()
  .catch(
    async (
      error,
    ) => {
      console.error(
        "\nTEST FAILED:",
        error,
      );

      // Best-effort cleanup so a failed test does not leave
      // the synthetic orphan in Qdrant.
      try {
        await deleteProductVectorForShop({
          shop:
            SHOP,

          productId:
            FAKE_PRODUCT_ID,
        });
      } catch (
        cleanupError
      ) {
        console.error(
          "Test cleanup failed:",
          cleanupError,
        );
      }

      process.exitCode =
        1;
    },
  )
  .finally(
    async () => {
      await db.$disconnect();
    },
  );