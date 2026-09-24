import { getShopEntitlement } from "./entitlement.server";
import { withDistributedLease } from "./lease-lock.server";
import { recoverBlockedProducts } from "../products/quota-recovery.server";
import {
  enqueueCatalogRefresh,
  enqueueInitialCatalogSyncIfNeeded,
  getLatestCatalogSyncJob,
} from "../catalog/catalog-sync-job.server";
import { kickCatalogSyncQueue } from "../catalog/catalog-sync-queue.server";

async function reconcileShopCommercialStateUnlocked({
  shop,
  forceCatalogRefresh = false,
}: {
  shop: string;
  forceCatalogRefresh?: boolean;
}) {
  let entitlement = await getShopEntitlement(shop);

  const recovery = await recoverBlockedProducts(shop);
  entitlement = await getShopEntitlement(shop);

  // A fresh catalog pass is required after an upgrade (the Basic scan may have
  // stopped at 500 and therefore never created registry rows for later items).
  // Basic slot refill after a delete is scheduled explicitly by the product
  // webhook service, avoiding a full catalog scan on every Admin page load.
  const latestCatalogJob = await getLatestCatalogSyncJob(shop);
  const needsInitialCatalogSync =
    !latestCatalogJob && entitlement.indexedProducts === 0;
  const planNeedsExpansionScan =
    entitlement.limits.productLimit === null &&
    Boolean(latestCatalogJob) &&
    latestCatalogJob?.planAtStart !== entitlement.plan;

  const shouldRefreshCatalog =
    !needsInitialCatalogSync && (forceCatalogRefresh || planNeedsExpansionScan);

  let catalogJobId: number | null = null;
  if (needsInitialCatalogSync) {
    // First install / Phase-1 migration must use INITIAL_SYNC semantics so the
    // one-time catalog bootstrap does not consume the Basic plan's 50 monthly
    // vector-update allowance.
    catalogJobId = await enqueueInitialCatalogSyncIfNeeded(shop);
  } else if (shouldRefreshCatalog) {
    catalogJobId = await enqueueCatalogRefresh(
      shop,
      forceCatalogRefresh || planNeedsExpansionScan
        ? "PLAN_RECONCILE"
        : "SLOT_REFILL",
    );
  }

  if (catalogJobId) kickCatalogSyncQueue();

  return {
    pruned: 0,
    recovered: recovery.queued,
    catalogJobId,
    reason: "RECONCILED",
  } as const;
}

export async function reconcileShopCommercialState({
  shop,
  forceCatalogRefresh = false,
}: {
  shop: string;
  forceCatalogRefresh?: boolean;
}) {
  return withDistributedLease({
    shop,
    resource: "commercial:reconcile",
    leaseMs: 120_000,
    waitTimeoutMs: 30_000,
    pollMs: 150,
    task: () =>
      reconcileShopCommercialStateUnlocked({
        shop,
        forceCatalogRefresh,
      }),
  });
}
