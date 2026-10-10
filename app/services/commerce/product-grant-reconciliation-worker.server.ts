import db from "../../db.server";
import { backgroundJobsEnabledInThisProcess, jitterInterval } from "../maintenance/background-runtime.server";
import { reconcileShopCommercialState } from "./reconciliation.server";
import { QUOTA_GRANT_KIND } from "./quota-grants.server";

/**
 * A PRODUCT grant changes eligibility twice: at creation and at expiry.
 * An unsuccessful immediate reconciliation remains durable here for retry.
 * No vectors are deleted when a limit shrinks.
 */
export async function runDueProductGrantReconciliations() {
  const now = new Date();
  const due = await db.aiSearchQuotaGrant.findMany({
    where: {
      kind: QUOTA_GRANT_KIND.product,
      OR: [
        { productPolicyReconciledAt: null },
        { revokedAt: null, expiresAt: { lte: now }, productExpiryReconciledAt: null },
      ],
    },
    select: {
      id: true, shop: true, expiresAt: true, revokedAt: true,
      productPolicyReconciledAt: true, productExpiryReconciledAt: true,
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: 100,
  });
  const byShop = new Map<string, typeof due>();
  for (const item of due) {
    const values = byShop.get(item.shop) ?? [];
    values.push(item);
    byShop.set(item.shop, values);
  }
  let reconciled = 0;
  let failed = 0;
  for (const [shop, grants] of byShop) {
    // Expansion only applies to a newly granted, still-active capacity increase.
    const capacityExpanded = grants.some((g) =>
      g.productPolicyReconciledAt === null &&
      g.revokedAt === null &&
      (!g.expiresAt || g.expiresAt > now)
    );
    try {
      await reconcileShopCommercialState({ shop, productCapacityExpanded: capacityExpanded });
      const finishedAt = new Date();
      for (const grant of grants) {
        const expiryDue = Boolean(grant.revokedAt || (grant.expiresAt && grant.expiresAt <= now));
        // Do not mark a concurrent revoke as reconciled based on an older snapshot.
        await db.aiSearchQuotaGrant.updateMany({
          where: { id: grant.id, revokedAt: grant.revokedAt },
          data: {
            productPolicyReconciledAt: finishedAt,
            ...(expiryDue ? { productExpiryReconciledAt: finishedAt } : {}),
          },
        });
      }
      reconciled++;
    } catch (error) {
      failed++;
      console.error("[Quota] Durable product grant reconciliation failed", {
        shop, reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { examined: due.length, shops: byShop.size, reconciled, failed };
}

const runtime = globalThis as typeof globalThis & {
  aiSearchProductGrantWorkerStarted?: boolean;
  aiSearchProductGrantWorkerRunning?: boolean;
};

export function startProductGrantReconciliationWorker() {
  if (!backgroundJobsEnabledInThisProcess() || runtime.aiSearchProductGrantWorkerStarted) return;
  runtime.aiSearchProductGrantWorkerStarted = true;
  const run = () => {
    if (runtime.aiSearchProductGrantWorkerRunning) return;
    runtime.aiSearchProductGrantWorkerRunning = true;
    void runDueProductGrantReconciliations()
      .catch((error) => console.error("[Quota] Product grant worker failed", error instanceof Error ? error.message : String(error)))
      .finally(() => { runtime.aiSearchProductGrantWorkerRunning = false; });
  };
  const interval = setInterval(run, jitterInterval(60_000, 0.1));
  interval.unref?.();
  const initial = setTimeout(run, 5_000);
  initial.unref?.();
}
