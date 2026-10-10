import type { ActionFunctionArgs } from "react-router";

import db from "../db.server";
import { authenticateUninstallDelivery } from "../services/billing/uninstall-webhook-auth.server";
import { withDistributedLease } from "../services/commerce/lease-lock.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  console.log("========== [WEBHOOK] APP_UNINSTALLED RECEIVED ==========");

  const { topic, shop, webhookId, payload } = await authenticateUninstallDelivery(request, process.env.SHOPIFY_API_SECRET || "").catch(error=>{
    console.error("[LIFECYCLE] Uninstall delivery authentication rejected",{status:error instanceof Response?error.status:500});
    throw error;
  });

  console.log("[LIFECYCLE] Shopify app uninstall webhook:", {
    topic,
    shop,
    webhookId,
  });

  if (!shop) {
    console.error("[LIFECYCLE] APP_UNINSTALLED webhook has no shop.");
    return new Response("OK", { status: 200 });
  }

  return withDistributedLease({shop,resource:"billing:refresh",leaseMs:60000,waitTimeoutMs:10000,task:async()=>{
  const idempotencyKey = `shopify-webhook:${webhookId}`;

  const existingEvent = await db.billingEvent.findUnique({
    where: { idempotencyKey },
    select: { id: true },
  });

  if (existingEvent) {
    console.log("[LIFECYCLE] Duplicate APP_UNINSTALLED webhook ignored:", {
      shop,
      webhookId,
    });
    return new Response("OK", { status: 200 });
  }

  const now = new Date();

  await db.$transaction(async (tx) => {
    const shopRecord = await tx.aiSearchShop.findUnique({
      where: { shop },
      select: {
        status: true,
        currentPlanHandle: true,
        currentSubscriptionGid: true,
        pendingPlanHandle: true,
        pendingSubscriptionGid: true,
        pendingChangeAt: true,
      },
    });

    if (!shopRecord) {
      console.error("[LIFECYCLE] APP_UNINSTALLED received for unknown shop:", {
        shop,
        webhookId,
      });
      return;
    }

    // Uninstall is an app lifecycle event, not a merchant-facing
    // cancellation control. Preserve billing history, but terminate the
    // local entitlement/access for the uninstalled shop.
    await tx.aiSearchShop.update({
      where: { shop },
      data: {
        status: "UNINSTALLED",
        uninstalledAt: now,
        // Preserve commercial/billing pointers. Shopify cancels the provider
        // subscription on uninstall, but the merchant can reinstall and use
        // the remainder of the already-paid billing period.
        currentPlanHandle: shopRecord.currentPlanHandle,
        currentSubscriptionGid: shopRecord.currentSubscriptionGid,
        pendingPlanHandle: shopRecord.pendingPlanHandle,
        pendingSubscriptionGid: shopRecord.pendingSubscriptionGid,
        pendingChangeAt: shopRecord.pendingChangeAt,
      },
    });

    await tx.billingSubscription.updateMany({
      where: {
        shop,
        status: {
          in: ["PENDING", "ACTIVE", "FROZEN"],
        },
      },
      data: {
        status: "CANCELLED",
        cancellationStatus: "EFFECTIVE",
        accessStatus: "NONE",
        cancelledAt: now,
        reconciliationStatus: "SYNCED",
        reconciliationCheckedAt: now,
        reconciliationReason: "SHOP_UNINSTALLED",
        repairRequiredAt: null,
      },
    });

    // Keep the legacy subscription projection aligned with the lifecycle.
    await tx.aiSearchSubscription.updateMany({
      where: { shop },
      data: {
        // Preserve the last commercial snapshot so reinstall can determine
        // whether the original paid/trial window is still valid.
        status: "INACTIVE",
        source: "WEBHOOK",
        lastSyncedAt: now,
      },
    });

    // Commit session cleanup with lifecycle and receipt. A failed cleanup must
    // not leave a processed receipt that causes retries to skip the cleanup.
    await tx.session.deleteMany({where:{shop}});
    await tx.billingEvent.create({
      data: {
        shop,
        subscriptionGid:
          shopRecord.currentSubscriptionGid ??
          shopRecord.pendingSubscriptionGid ??
          null,
        type: "APP_UNINSTALLED",
        source: "WEBHOOK",
        idempotencyKey,
        payload: {
          topic,
          webhookId,
          previousShopStatus: shopRecord.status,
          currentShopStatus: "UNINSTALLED",
          previousCurrentSubscriptionGid:
            shopRecord.currentSubscriptionGid ?? null,
          previousPendingSubscriptionGid:
            shopRecord.pendingSubscriptionGid ?? null,
          payload,
        },
        occurredAt: now,
      },
    });
  });

  console.log("[LIFECYCLE] APP_UNINSTALLED processed:", {
    shop,
    webhookId,
    status: "UNINSTALLED",
  });

  return new Response("OK", { status: 200 });
  }});
};
