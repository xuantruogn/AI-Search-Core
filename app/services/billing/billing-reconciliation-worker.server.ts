import db from "../../db.server";
import { withDistributedLease } from "../commerce/lease-lock.server";
import { backgroundJobsEnabledInThisProcess, jitterInterval } from "../maintenance/background-runtime.server";
import { reconcileShopifySubscriptionFromAdmin } from "./shopify-app-pricing.server";
import { reconcileShopCommercialState } from "../commerce/reconciliation.server";
import { runDuePartnerTransactions } from "./partner-transactions.server";

export async function runDueBillingReconciliations() {
  const dueBefore = new Date(Date.now() - 60 * 60000);
  const retryBefore = new Date(Date.now() - 5 * 60000);
  const now = new Date();
  const rows = await db.$queryRaw<Array<{ shop: string }>>`
    SELECT s.shop FROM AiSearchShop s JOIN billing_subscriptions b ON b.shop = s.shop
    WHERE s.status = 'ACTIVE' AND (b.status IN ('ACTIVE','FROZEN','PENDING') OR b.cancellationStatus = 'NON_RENEWING')
      AND (b.reconciliationCheckedAt IS NULL OR b.reconciliationCheckedAt < ${retryBefore})
      AND (b.reconciliationCheckedAt IS NULL OR b.reconciliationCheckedAt < ${dueBefore}
        OR (b.trialStatus = 'ACTIVE' AND b.trialEndsAt <= ${now})
        OR (b.status = 'ACTIVE' AND b.currentPeriodEndsAt <= ${now})
        OR (b.cancellationStatus = 'NON_RENEWING' AND b.currentPeriodEndsAt <= ${now}))
    GROUP BY s.shop ORDER BY MIN(b.reconciliationCheckedAt) ASC, s.shop ASC LIMIT 25
  `;
  const { unauthenticated } = await import("../../shopify.server");
  let reconciled = 0;
  for (const row of rows) {
    try {
      await withDistributedLease({shop:row.shop,resource:"billing:refresh",leaseMs:60000,waitTimeoutMs:1000,pollMs:100,task:async()=>{
        const { admin } = await unauthenticated.admin(row.shop);
        const result = await reconcileShopifySubscriptionFromAdmin({shop:row.shop,admin,source:"RECONCILIATION"});
        // Confirmed cancellations retain access only until their provider end,
        // even if the cancelled record is no longer returned by Admin.
        const expired = await db.billingSubscription.findMany({where:{shop:row.shop,status:"CANCELLED",cancellationStatus:"NON_RENEWING",currentPeriodEndsAt:{lte:new Date()}},select:{id:true,shopifySubscriptionGid:true}});
        for (const subscription of expired) {
          await db.$transaction(async tx => {
            const changed = await tx.billingSubscription.updateMany({where:{id:subscription.id,status:"CANCELLED",cancellationStatus:"NON_RENEWING"},data:{cancellationStatus:"EFFECTIVE",accessStatus:"NONE",reconciliationCheckedAt:new Date()}});
            if (changed.count) await tx.billingEvent.upsert({where:{idempotencyKey:`cancellation-effective:${subscription.shopifySubscriptionGid}`},update:{},create:{shop:row.shop,subscriptionGid:subscription.shopifySubscriptionGid,type:"CANCELLATION_EFFECTIVE",source:"RECONCILIATION",occurredAt:new Date(),idempotencyKey:`cancellation-effective:${subscription.shopifySubscriptionGid}`,payload:{reason:"CONFIRMED_CANCELLATION_WINDOW_EXPIRED"}}});
          });
        }
        if (result.changed || expired.length) await reconcileShopCommercialState({shop:row.shop,forceCatalogRefresh:result.changed && result.subscription.status === "ACTIVE"});
        reconciled++;
      }});
    } catch (error) {
      // Durable retry backoff, not a successful reconciliation. Never grant
      // access or invent a payment when the provider is unreachable.
      await db.billingSubscription.updateMany({where:{shop:row.shop},data:{reconciliationCheckedAt:new Date(),reconciliationStatus:"REPAIR_REQUIRED",reconciliationReason:"PERIODIC_PROVIDER_RECONCILIATION_FAILED"}});
      console.error("[Billing] Periodic reconciliation failed",{shop:row.shop,error:error instanceof Error?error.message:String(error)});
    }
  }
  return {checked:rows.length,reconciled};
}

const state = globalThis as typeof globalThis & { buyenseBillingWorkerStarted?: boolean; buyenseBillingWorkerRunning?: boolean };
export function startBillingReconciliationWorker() {
  if (!backgroundJobsEnabledInThisProcess() || state.buyenseBillingWorkerStarted) return;
  state.buyenseBillingWorkerStarted = true;
  const run = () => {
    if (state.buyenseBillingWorkerRunning) return;
    state.buyenseBillingWorkerRunning = true;
    void runDueBillingReconciliations().catch(error=>console.error("[Billing] Lifecycle worker failed",error instanceof Error?error.message:String(error)))
      .then(()=>runDuePartnerTransactions()).catch(error=>console.error("[Billing] Transaction worker failed",error instanceof Error?error.message:String(error)))
      .finally(()=>{state.buyenseBillingWorkerRunning=false;});
  };
  const timer = setInterval(run,jitterInterval(5*60000)); timer.unref?.();
  const first = setTimeout(run,120000); first.unref?.();
}
