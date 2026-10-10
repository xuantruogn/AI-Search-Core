import { unauthenticated } from "../../shopify.server";
import db from "../../db.server";
import { recordWorkerPoll } from "../maintenance/worker-heartbeat.server";

import { syncEntireCatalog } from "../products/catalog-sync.server";
import { fetchProductPresenceByIds } from "../products/product-sync.server";
import { enqueueProductSyncJob } from "../products/product-sync-job.server";
import { kickProductSyncQueue } from "../products/product-sync-queue.server";

import {
  listStaleIndexedProducts,
  markIndexedProductCatalogSeen,
  markIndexedProductUnpublished,
  removeIndexedProduct,
} from "../commerce/indexed-products.server";

import {
  deleteProductVectorForShop,
  reconcileOrphanProductVectorsForShop,
  updateProductVectorSearchabilityForShop,
} from "../search/vector-store.server";

import {
  invalidateDerivedProductSearchCaches,
} from "../theme/theme-search-transport-key.server";
import { bumpSearchSemanticRevision } from "../search/search-catalog-revision.server";

import { recordUsageEvent } from "../commerce/usage.server";
import { getShopEntitlement } from "../commerce/entitlement.server";
import { withDistributedLease } from "../commerce/lease-lock.server";
import { recoverBlockedProducts } from "../products/quota-recovery.server";
import {
  backgroundJobsEnabledInThisProcess,
  jitterInterval,
} from "../maintenance/background-runtime.server";

import {
  checkpointCatalogSyncJob,
  claimNextCatalogSyncJob,
  getCatalogSyncJob,
  heartbeatCatalogSyncJob,
  updateCatalogSyncProgress,
  markCatalogSyncDone,
  markCatalogSyncFailed,
} from "./catalog-sync-job.server";

type QueueState = {
  running: boolean;
  scheduled: boolean;
  rerunRequested: boolean;
  timerStarted: boolean;
};

const globalState =
  globalThis as typeof globalThis & {
    aiSearchCatalogQueueState?: QueueState;
  };

const state =
  globalState.aiSearchCatalogQueueState ??
  (globalState.aiSearchCatalogQueueState = {
    running: false,
    scheduled: false,
    rerunRequested: false,
    timerStarted: false,
  });

function readPositiveInteger(
  name: string,
  fallback: number,
) {
  const value =
    Number.parseInt(
      process.env[name] || "",
      10,
    );

  return Number.isSafeInteger(value) &&
    value > 0
    ? value
    : fallback;
}

const MAX_JOBS_PER_DRAIN =
  readPositiveInteger(
    "AI_SEARCH_CATALOG_QUEUE_BATCH_SIZE",
    2,
  );

type CatalogFailurePhase =
  | "LEASE"
  | "AUTH"
  | "SYNC";

async function describeCatalogThrownValue(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  if (
    typeof Response !== "undefined" &&
    error instanceof Response
  ) {
    let body = "";

    try {
      body =
        (await error.clone().text())
          .trim()
          .slice(0, 2_000);
    } catch {
      body = "";
    }

    const statusText =
      error.statusText?.trim();

    return [
      `HTTP ${error.status}${statusText ? ` ${statusText}` : ""}`,
      body ? `body=${body}` : "",
    ]
      .filter(Boolean)
      .join("; ");
  }

  return String(error);
}

async function classifyCatalogFailure({
  error,
  shop,
  phase,
}: {
  error: unknown;
  shop: string;
  phase: CatalogFailurePhase;
}) {
  const detail =
    await describeCatalogThrownValue(
      error,
    );

  if (phase === "AUTH") {
    let session:
      | {
          expires: Date | null;
          refreshToken: string | null;
          refreshTokenExpires: Date | null;
        }
      | null = null;

    try {
      session =
        await db.session.findUnique({
          where: {
            id: `offline_${shop}`,
          },
          select: {
            expires: true,
            refreshToken: true,
            refreshTokenExpires: true,
          },
        });
    } catch (diagnosticError) {
      const diagnosticDetail =
        await describeCatalogThrownValue(
          diagnosticError,
        );

      return (
        `${detail}; authDiagnosticsFailed=` +
        diagnosticDetail
      );
    }

    if (!session) {
      return (
        `AUTH_REQUIRED: OFFLINE_SESSION_MISSING; shop=${shop}; ` +
        `cause=${detail}`
      );
    }

    const now =
      Date.now();

    const accessExpired =
      Boolean(session.expires) &&
      session.expires!.getTime() <=
        now;

    const refreshExpired =
      Boolean(
        session.refreshTokenExpires,
      ) &&
      session.refreshTokenExpires!.getTime() <=
        now;

    if (accessExpired) {
      const accessExpiredAt =
        session.expires?.toISOString() ??
        "unknown";

      const refreshExpiresAt =
        session.refreshTokenExpires?.toISOString() ??
        "unknown";

      if (!session.refreshToken) {
        return (
          `AUTH_REQUIRED: OFFLINE_REFRESH_TOKEN_MISSING; shop=${shop}; ` +
          `accessExpiredAt=${accessExpiredAt}; cause=${detail}`
        );
      }

      if (refreshExpired) {
        return (
          `AUTH_REQUIRED: OFFLINE_REFRESH_TOKEN_EXPIRED; shop=${shop}; ` +
          `accessExpiredAt=${accessExpiredAt}; refreshExpiresAt=${refreshExpiresAt}; ` +
          `cause=${detail}`
        );
      }

      return (
        `AUTH_REQUIRED: OFFLINE_TOKEN_REFRESH_FAILED; shop=${shop}; ` +
        `accessExpiredAt=${accessExpiredAt}; refreshExpiresAt=${refreshExpiresAt}; ` +
        `cause=${detail}`
      );
    }

    if (
      typeof Response !==
        "undefined" &&
      error instanceof
        Response &&
      (error.status === 401 ||
        error.status === 403)
    ) {
      return (
        `AUTH_REQUIRED: OFFLINE_SESSION_REJECTED; shop=${shop}; ` +
        `cause=${detail}`
      );
    }
  }

  if (
    /GraphQL Client:\s*Not Found/i.test(
      detail,
    ) ||
    /Received an error response \(404 Not Found\) from Shopify/i.test(
      detail,
    )
  ) {
    return (
      `AUTH_REQUIRED: SHOPIFY_ADMIN_GRAPHQL_NOT_FOUND; shop=${shop}; ` +
      `cause=${detail}`
    );
  }

  if (
    /\b(401 Unauthorized|403 Forbidden)\b/i.test(
      detail,
    ) ||
    /invalid_(?:request|subject_token)/i.test(
      detail,
    )
  ) {
    return (
      `AUTH_REQUIRED: SHOPIFY_ADMIN_AUTH_REJECTED; shop=${shop}; ` +
      `cause=${detail}`
    );
  }

  return detail;
}

// ============================================================
// STALE CATALOG CLEANUP
//
// Chỉ chạy sau một FULL scan hoàn tất.
//
// Không chạy khi:
// - INITIAL sync dừng do product limit
// - SLOT_REFILL dừng do product limit
//
// Shopify vẫn là source of truth.
// ============================================================

async function cleanupStaleRegistryEntries({
  admin,
  shop,
  scanStartedAt,
}: {
  admin: {
    graphql: (
      query: string,
      options?: {
        variables?: Record<
          string,
          unknown
        >;
      },
    ) => Promise<Response>;
  };

  shop: string;
  scanStartedAt: Date;
}) {
  const entitlement =
    await getShopEntitlement(shop);

  let removed = 0;

  let revalidatedSearchable =
    0;

  for (;;) {
    const stale =
      await listStaleIndexedProducts(
        shop,
        scanStartedAt,
        100,
      );

    if (
      stale.length === 0
    ) {
      break;
    }

    // Shopify remains authoritative.
    //
    // Một product có thể trở thành ACTIVE sau khi cursor full scan
    // đã đi qua ID của nó.
    //
    // Nếu chỉ nhìn lastCatalogSeenAt thì có thể xóa nhầm product
    // vừa được webhook làm live lại.
    //
    // Vì vậy revalidate toàn stale batch bằng Shopify trước khi xóa.
    const presence =
      await fetchProductPresenceByIds(
        admin,

        stale.map(
          (product) =>
            product.productId,
        ),
      );

    let batchSearchStateChanged = false;

    for (
      const product
      of stale
    ) {
      const shopifyPresence =
        presence.get(
          product.productId,
        ) ??
        "MISSING";

      // --------------------------------------------------------
      // PRODUCT VẪN SEARCHABLE
      //
      // Không xóa.
      // Đánh dấu lại catalog-seen để row không bị lấy lại trong
      // vòng stale cleanup tiếp theo.
      // --------------------------------------------------------

      if (
        shopifyPresence ===
        "SEARCHABLE"
      ) {
        await markIndexedProductCatalogSeen({
          shop,

          productId:
            product.productId,
        });

        revalidatedSearchable +=
          1;

        continue;
      }

      if (shopifyPresence === "NOT_SEARCHABLE") {
        const changed = await markIndexedProductUnpublished(shop, product.productId);
        await updateProductVectorSearchabilityForShop({
          shop,
          productIds: [product.productId],
          searchable: false,
        });
        invalidateDerivedProductSearchCaches(shop, product.productId);
        if (changed > 0) {
          batchSearchStateChanged = true;
        }
        await markIndexedProductCatalogSeen({ shop, productId: product.productId });
        continue;
      }

      // --------------------------------------------------------
      // PRODUCT KHÔNG CÒN STOREFRONT SEARCHABLE
      //
      // Có thể là:
      //
      // - deleted
      // - DRAFT
      // - ARCHIVED
      // - unpublished
      // - missing
      //
      // Cleanup order:
      //
      // 1. Remove Qdrant vector.
      // 2. Remove IndexedProduct registry (semantic profile cascades).
      // 3. Invalidate semantic/derived transport caches.
      //
      // Transport candidates are derived in memory and are not persisted.
      // --------------------------------------------------------

      // Fail closed first so a partial cleanup cannot leave a searchable
      // registry row pointing at a missing/stale vector.
      await markIndexedProductUnpublished(shop, product.productId);
      invalidateDerivedProductSearchCaches(shop, product.productId);
      batchSearchStateChanged = true;

      if (product.hasVector) {
        await updateProductVectorSearchabilityForShop({
          shop,
          productIds: [product.productId],
          searchable: false,
        });
        await deleteProductVectorForShop({
          shop,
          productId: product.productId,
        });
      }

      await removeIndexedProduct(
        shop,
        product.productId,
      );

      invalidateDerivedProductSearchCaches(shop, product.productId);

      // --------------------------------------------------------
      // Usage / operational telemetry
      // --------------------------------------------------------

      await recordUsageEvent({
        shop,

        periodId:
          entitlement.usage.id,

        type:
          "CATALOG_STALE_ENTRY_REMOVED",

        productId:
          product.productId,

        metadata: {
          previousStatus:
            product.status,

          shopifyPresence,
        },
      });

      removed += 1;

      console.log(
        "[AI Search] Stale catalog product removed:",
        {
          shop,

          productId:
            product.productId,

          previousStatus:
            product.status,

          shopifyPresence,
        },
      );
    }

    if (batchSearchStateChanged) {
      await bumpSearchSemanticRevision(shop);
    }
  }

  return {
    removed,

    revalidatedSearchable,
  };
}

// ============================================================
// PROCESS ONE CATALOG JOB
// ============================================================

async function processOne() {
  const job =
    await claimNextCatalogSyncJob();

  if (!job) {
    return false;
  }

  let failurePhase: CatalogFailurePhase =
    "LEASE";

  try {
    await withDistributedLease({
      shop:
        job.shop,

      resource:
        "catalog:process",

      // The lease helper heartbeats while the scan runs.
      // This prevents two app instances from processing different
      // catalog jobs for the same shop at the same time.
      leaseMs:
        Math.max(
          10 * 60_000,

          readPositiveInteger(
            "AI_SEARCH_CATALOG_PROCESS_LOCK_MS",
            10 * 60_000,
          ),
        ),

      waitTimeoutMs:
        readPositiveInteger(
          "AI_SEARCH_CATALOG_PROCESS_LOCK_WAIT_MS",
          60_000,
        ),

      pollMs:
        200,

      task:
        async () => {
          // A job can become stale and be reclaimed while this worker
          // is waiting for the per-shop lease.
          //
          // Never execute an obsolete attempt.
          const current =
            await getCatalogSyncJob(
              job.id,
            );

          if (
            !current ||
            current.status !==
              "PROCESSING" ||
            current.attempts !==
              job.attempts
          ) {
            console.warn(
              "[AI Search] Catalog attempt superseded; skipping:",
              {
                jobId:
                  job.id,

                shop:
                  job.shop,

                claimedAttempt:
                  job.attempts,

                currentStatus:
                  current?.status ??
                  null,

                currentAttempt:
                  current?.attempts ??
                  null,
              },
            );

            return;
          }

          // ====================================================
          // HEARTBEAT
          // ====================================================

          const heartbeatMs =
            Math.max(
              5_000,

              Math.min(
                Math.max(
                  5_000,

                  Math.floor(
                    readPositiveInteger(
                      "AI_SEARCH_CATALOG_LEASE_MS",
                      5 * 60_000,
                    ) /
                      3,
                  ),
                ),

                readPositiveInteger(
                  "AI_SEARCH_CATALOG_HEARTBEAT_MS",
                  30_000,
                ),
              ),
            );

          let heartbeatLost =
            false;

          let heartbeatRunning =
            false;

          const heartbeat =
            async () => {
              if (
                heartbeatRunning ||
                heartbeatLost
              ) {
                return;
              }

              heartbeatRunning =
                true;

              try {
                const alive =
                  await heartbeatCatalogSyncJob(
                    job.id,
                    job.attempts,
                  );

                if (!alive) {
                  heartbeatLost =
                    true;

                  console.warn(
                    "[AI Search] Catalog attempt heartbeat lost:",
                    {
                      jobId:
                        job.id,

                      shop:
                        job.shop,

                      attempt:
                        job.attempts,
                    },
                  );
                }
              } catch (
                error
              ) {
                // A transient DB error should not immediately kill a scan;
                // the next heartbeat/checkpoint can renew the lease.
                console.error(
                  "[AI Search] Catalog heartbeat failed:",
                  {
                    jobId:
                      job.id,

                    shop:
                      job.shop,

                    error:
                      error instanceof
                      Error
                        ? error.message
                        : String(
                            error,
                          ),
                  },
                );
              } finally {
                heartbeatRunning =
                  false;
              }
            };

          const heartbeatTimer =
            setInterval(
              () => {
                void heartbeat();
              },
              heartbeatMs,
            );

          heartbeatTimer.unref?.();

          try {
            failurePhase =
              "AUTH";

            const {
              admin,
            } =
              await unauthenticated.admin(
                job.shop,
              );

            failurePhase =
              "SYNC";

            let retryJobs =
              0;

            // ==================================================
            // FULL CATALOG SCAN
            // ==================================================

            let lastLiveProgressCheckpointAt = 0;

            const progress =
              await syncEntireCatalog({
                admin,
                catalogLanguage: job.languageAtStart,

                shop:
                  job.shop,

                pageSize:
                  50,

                after:
                  job.cursor,

                indexReason:
                  job.reason ===
                  "INITIAL"
                    ? "INITIAL_SYNC"
                    : job.reason === "PLAN_RECONCILE"
                      ? "POLICY_RECOVERY"
                      : job.reason === "SLOT_REFILL"
                        ? "PRODUCT_LIMIT_RECOVERY"
                    : "MANUAL_REINDEX",

                // Initial bootstrap and Basic-plan slot refill
                // only need to scan until product capacity is full.
                //
                // A manual/plan reconciliation still scans the
                // complete catalog to repair stale state.
                stopWhenProductLimitReached:
                  job.reason ===
                    "INITIAL" ||
                  job.reason ===
                    "SLOT_REFILL",

                initialProgress: {
                  pagesProcessed:
                    job.pagesProcessed,

                  productsProcessed:
                    job.productsProcessed,

                  productsIndexed:
                    job.productsIndexed,

                  productsSkipped:
                    job.productsSkipped,

                  productsBlocked:
                    job.productsBlocked,

                  productsFailed:
                    job.productsFailed,
                },

                // ==============================================
                // PAGE CHECKPOINT
                // ==============================================

                onPageCompleted:
                  async (
                    cursor,
                    currentProgress,
                  ) => {
                    if (
                      heartbeatLost
                    ) {
                      throw new Error(
                        "CATALOG_ATTEMPT_SUPERSEDED",
                      );
                    }

                    const checkpointed =
                      await checkpointCatalogSyncJob(
                        job.id,

                        job.attempts,

                        cursor,

                        currentProgress,
                      );

                    if (
                      !checkpointed
                    ) {
                      heartbeatLost =
                        true;

                      throw new Error(
                        "CATALOG_ATTEMPT_SUPERSEDED",
                      );
                    }
                  },

                // ==============================================
                // LIVE PROGRESS CHECKPOINT
                // ==============================================

                onProgress:
                  async (currentProgress) => {
                    const now = Date.now();
                    if (now - lastLiveProgressCheckpointAt < 1_000) {
                      return;
                    }

                    lastLiveProgressCheckpointAt = now;

                    if (heartbeatLost) {
                      throw new Error(
                        "CATALOG_ATTEMPT_SUPERSEDED",
                      );
                    }

                    const persisted =
                      await updateCatalogSyncProgress(
                        job.id,
                        job.attempts,
                        currentProgress,
                      );

                    if (!persisted) {
                      heartbeatLost = true;
                      throw new Error(
                        "CATALOG_ATTEMPT_SUPERSEDED",
                      );
                    }
                  },

                // ==============================================
                // PRODUCT RETRY
                // ==============================================

                onProductFailed:
                  async (
                    failure,
                  ) => {
                    if (
                      heartbeatLost
                    ) {
                      throw new Error(
                        "CATALOG_ATTEMPT_SUPERSEDED",
                      );
                    }

                    const queued =
                      await enqueueProductSyncJob({
                        shop:
                          job.shop,

                        webhookId:
                          `catalog-product-retry:${job.id}:${job.attempts}:${failure.productId}`,

                        topic:
                          "PRODUCTS_UPDATE",

                        productId:
                          failure.productId,
                      });

                    if (
                      queued.created
                    ) {
                      retryJobs +=
                        1;

                      kickProductSyncQueue();
                    }
                  },
              });

            if (
              heartbeatLost
            ) {
              throw new Error(
                "CATALOG_ATTEMPT_SUPERSEDED",
              );
            }

            // ==================================================
            // STALE CLEANUP
            //
            // Chỉ chạy nếu full scan thực sự hoàn tất.
            //
            // Nếu INITIAL/SLOT_REFILL dừng vì Basic product limit,
            // những page phía sau chưa được scan.
            //
            // Vì vậy tuyệt đối không dùng missing timestamp để xóa
            // trong trường hợp đó.
            // ==================================================

            let staleRemoved =
              0;

            let staleRevalidatedSearchable =
              0;

            let orphanVectorsScanned =
              0;

            let orphanVectorsRemoved =
              0;

            let orphanMalformedVectorsRemoved =
              0;

            let orphanRecentVectorsSkipped =
              0;

            if (
              !progress.stoppedByProductLimit
            ) {
              const stableScanStart =
                job.scanStartedAt instanceof
                Date
                  ? job.scanStartedAt
                  : job.scanStartedAt
                    ? new Date(
                        job.scanStartedAt,
                      )
                    : job.createdAt instanceof
                        Date
                      ? job.createdAt
                      : new Date(
                          job.createdAt,
                        );

              const staleCleanup =
                await cleanupStaleRegistryEntries({
                  admin,

                  shop:
                    job.shop,

                  scanStartedAt:
                    stableScanStart,
                });

              staleRemoved =
                staleCleanup.removed;

              staleRevalidatedSearchable =
                staleCleanup.revalidatedSearchable;

              try {
                const orphanCleanup =
                  await reconcileOrphanProductVectorsForShop({
                    shop:
                      job.shop,

                    batchSize:
                      100,
                  });

                orphanVectorsScanned =
                  orphanCleanup.scannedPoints;

                orphanVectorsRemoved =
                  orphanCleanup.removedPoints;

                orphanMalformedVectorsRemoved =
                  orphanCleanup.malformedPointsRemoved;

                orphanRecentVectorsSkipped =
                  orphanCleanup.recentPointsSkipped;
              } catch (error) {
                console.error(
                  "[AI Search] Qdrant orphan reconciliation failed:",
                  {
                    jobId:
                      job.id,

                    shop:
                      job.shop,

                    error:
                      error instanceof Error
                        ? error.message
                        : String(
                            error,
                          ),
                  },
                );
              }
            }

            if (
              heartbeatLost
            ) {
              throw new Error(
                "CATALOG_ATTEMPT_SUPERSEDED",
              );
            }

            // ==================================================
            // COMPLETE JOB
            // ==================================================

            const completed =
              await markCatalogSyncDone(
                job.id,

                job.attempts,

                progress,
              );

            if (
              !completed
            ) {
              return;
            }

            // Product cleanup may have freed Basic-plan slots.
            // Recover blocked products only after the catalog job
            // is durably marked complete.
            const recovery =
              await recoverBlockedProducts(
                job.shop,
              );

            console.log(
              "[AI Search] Catalog sync job completed:",
              {
                jobId:
                  job.id,

                shop:
                  job.shop,

                attempt:
                  job.attempts,

                indexed:
                  progress.productsIndexed,

                skipped:
                  progress.productsSkipped,

                blocked:
                  progress.productsBlocked,

                failed:
                  progress.productsFailed,

                retryJobs,

                staleRemoved,

                staleRevalidatedSearchable,

                orphanVectorsScanned,

                orphanVectorsRemoved,

                orphanMalformedVectorsRemoved,

                orphanRecentVectorsSkipped,

                recovered:
                  recovery.queued,
              },
            );
          } finally {
            clearInterval(
              heartbeatTimer,
            );
          }
        },
    });
  } catch (error) {
    const failure =
      await classifyCatalogFailure({
        error,
        shop: job.shop,
        phase: failurePhase,
      });

    await markCatalogSyncFailed(
      job.id,
      job.attempts,
      failure,
    );
  }

  return true;
}

// ============================================================
// DRAIN QUEUE
// ============================================================

export async function drainCatalogSyncQueue() {
  if (
    state.running
  ) {
    state.rerunRequested =
      true;

    return;
  }

  state.running =
    true;

  let processed =
    0;

  try {
    while (
      processed <
        MAX_JOBS_PER_DRAIN &&
      (await processOne())
    ) {
      processed +=
        1;
    }
  } finally {
    state.running =
      false;

    const rerun =
      state.rerunRequested ||
      processed >=
        MAX_JOBS_PER_DRAIN;

    state.rerunRequested =
      false;

    if (rerun) {
      kickCatalogSyncQueue();
    }
  }
}

// ============================================================
// KICK QUEUE
// ============================================================

export function kickCatalogSyncQueue() {
  if (!backgroundJobsEnabledInThisProcess()) return;

  if (
    state.running
  ) {
    state.rerunRequested =
      true;

    return;
  }

  if (
    state.scheduled
  ) {
    return;
  }

  state.scheduled =
    true;

  const timer =
    setTimeout(
      () => {
        state.scheduled =
          false;

        void drainCatalogSyncQueue().catch(
          (error) => {
            console.error(
              "[AI Search] Catalog queue drain failed:",
              error,
            );
          },
        );
      },
      0,
    );

  timer.unref?.();
}

// ============================================================
// WORKER
// ============================================================

export function startCatalogSyncQueueWorker() {
  if (!backgroundJobsEnabledInThisProcess()) return;

  if (
    state.timerStarted
  ) {
    return;
  }

  state.timerStarted =
    true;

  const pollMs =
    Math.max(
      10_000,

      readPositiveInteger(
        "AI_SEARCH_CATALOG_QUEUE_POLL_MS",
        60_000,
      ),
    );

  const timer =
    setInterval(
      () => { recordWorkerPoll("catalog", pollMs); kickCatalogSyncQueue(); },
      jitterInterval(pollMs),
    );

  timer.unref?.();

  const startDelayMs =
    Math.max(
      0,
      Math.min(
        readPositiveInteger(
          "AI_SEARCH_CATALOG_QUEUE_START_DELAY_MS",
          5_000,
        ),
        60_000,
      ),
    );

  const startupTimer =
    setTimeout(
      () => { recordWorkerPoll("catalog", pollMs); kickCatalogSyncQueue(); },
      startDelayMs,
    );

  startupTimer.unref?.();
}
