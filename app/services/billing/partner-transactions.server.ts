import { createHash } from "node:crypto";
import db from "../../db.server";
import { withDistributedLease } from "../commerce/lease-lock.server";
import { fetchPartnerTransactionPage, visitPartnerTransactionPages } from "./partner-transactions";

export function partnerTransactionsConfig() {
  const organizationId = process.env.SHOPIFY_PARTNER_ORGANIZATION_ID;
  const appId = process.env.SHOPIFY_PARTNER_APP_ID;
  const token = process.env.SHOPIFY_PARTNER_ACCESS_TOKEN;
  if (!organizationId || !appId || !token) return null;
  if (!/^\d+$/.test(organizationId) || !/^gid:\/\/partners\/App\/\d+$/.test(appId)) throw new Error("PARTNER_TRANSACTIONS_INVALID_CONFIG");
  return { organizationId, appId, token };
}
function scopeKey(organizationId: string, appId: string) {
  return createHash("sha256").update(`${organizationId}:${appId}`).digest("hex").slice(0, 24);
}
export async function reconcilePartnerTransactions(shop: string) {
  const config = partnerTransactionsConfig();
  if (!config) return { configured: false, imported: 0 };
  const scope = scopeKey(config.organizationId, config.appId);
  return withDistributedLease({shop,resource:`billing:transactions:${scope}`,leaseMs:60000,waitTimeoutMs:1000,task:async()=>{
    const checkpointKey = `partner-checkpoint:${scope}:${shop}`;
    const checkpoint = await db.billingEvent.findUnique({where:{idempotencyKey:checkpointKey}});
    const saved = checkpoint?.payload as { after?: string | null; until?: string; complete?: boolean } | null;
    const after = saved?.complete ? null : saved?.after ?? null;
    const until = !saved?.complete && saved?.until ? saved.until : new Date().toISOString();
    let imported = 0;
    // Full-history rescans also catch delayed transactions and old adjustments.
    // Five pages per shop/run; restart resumes the cursor, never drops backlog.
    await visitPartnerTransactionPages(after, cursor => fetchPartnerTransactionPage(config, shop, cursor, until), async page => {
      await db.$transaction(async tx => {
        for (const {node} of page.edges) {
          const transactionKey = `partner-transaction:${scope}:${createHash("sha256").update(node.id).digest("hex")}`;
          const existing = await tx.billingEvent.findUnique({where:{idempotencyKey:transactionKey},select:{id:true}});
          if (existing) continue;
          // Preserve exact provider IDs and decimal strings. No guessed period,
          // PAID projection, refund classification, or access change.
          await tx.billingEvent.create({data:{shop,type:"BILLING_RECONCILED",source:"RECONCILIATION",occurredAt:new Date(node.createdAt),idempotencyKey:transactionKey,
            payload:{provider:"SHOPIFY_PARTNER",kind:node.__typename,transactionId:node.id,chargeId:node.chargeId,appId:node.app.id,providerRecordedAt:node.createdAt,grossAmount:node.grossAmount,netAmount:node.netAmount,shopifyFee:node.shopifyFee,allocation:"UNALLOCATED_PROVIDER_TRANSACTION",usage:"ANALYTICS_ONLY"}}});
          imported++;
        }
        const payload = { after:page.pageInfo.endCursor, until, complete:!page.pageInfo.hasNextPage, nextRetryAt:null, provider:"SHOPIFY_PARTNER",kind:"TRANSACTION_SYNC_CHECKPOINT" };
        await tx.billingEvent.upsert({where:{idempotencyKey:checkpointKey},create:{shop,type:"BILLING_RECONCILED",source:"RECONCILIATION",occurredAt:new Date(),idempotencyKey:checkpointKey,payload},update:{payload,occurredAt:new Date()}});
      });
    });
    return {configured:true,imported};
  }});
}
export async function runDuePartnerTransactions() {
  const config = partnerTransactionsConfig();
  if (!config) return {configured:false,checked:0};
  const scope = scopeKey(config.organizationId, config.appId);
  const due = new Date(Date.now() - 6 * 3600000);
  const now = new Date().toISOString();
  // Includes uninstalled shops: refunds/adjustments may arrive after uninstall.
  const rows = await db.$queryRaw<Array<{shop:string}>>`
    SELECT s.shop FROM AiSearchShop s LEFT JOIN billing_events e
      ON e.shop=s.shop AND e.idempotencyKey=CONCAT(${`partner-checkpoint:${scope}:`},s.shop)
    WHERE (e.occurredAt IS NULL OR e.occurredAt < ${due}
      OR JSON_UNQUOTE(JSON_EXTRACT(e.payload, '$.complete')) = 'false')
      AND (JSON_EXTRACT(e.payload, '$.nextRetryAt') IS NULL
        OR JSON_TYPE(JSON_EXTRACT(e.payload, '$.nextRetryAt')) = 'NULL'
        OR JSON_UNQUOTE(JSON_EXTRACT(e.payload, '$.nextRetryAt')) <= ${now})
    ORDER BY e.occurredAt ASC, s.shop ASC LIMIT 25
  `;
  for (const {shop} of rows) {
    try { await reconcilePartnerTransactions(shop); }
    catch (error) {
      console.error("[Billing] Partner transaction sync failed",{shop,error:error instanceof Error?error.message:"UNKNOWN"});
      // Do not advance checkpoints or change entitlements on API/DB failure.
      await withDistributedLease({shop,resource:`billing:transactions:${scope}`,leaseMs:60000,waitTimeoutMs:1000,task:async()=>{
        const key = `partner-checkpoint:${scope}:${shop}`;
        const previous = await db.billingEvent.findUnique({where:{idempotencyKey:key},select:{payload:true}});
        const saved = previous?.payload as Record<string,unknown> | null;
        const payload = JSON.parse(JSON.stringify({...saved,provider:"SHOPIFY_PARTNER",kind:"TRANSACTION_SYNC_CHECKPOINT",complete:false,nextRetryAt:new Date(Date.now()+30*60000).toISOString()}));
        await db.billingEvent.upsert({where:{idempotencyKey:key},create:{shop,type:"BILLING_RECONCILED",source:"RECONCILIATION",occurredAt:new Date(),idempotencyKey:key,payload},update:{payload,occurredAt:new Date()}});
      }}).catch(()=>console.error("[Billing] Partner retry checkpoint unavailable",{shop}));
    }
  }
  return {configured:true,checked:rows.length};
}
