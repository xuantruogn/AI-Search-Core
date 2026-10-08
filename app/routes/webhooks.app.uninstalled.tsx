import type { ActionFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";
import db from "../db.server";
import { recordBillingEvent } from "../services/commerce/billing-state.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  console.log("========== [WEBHOOK] APP_UNINSTALLED RECEIVED ==========");

  const { topic, shop, webhookId, payload } = await authenticate.webhook(request);

  console.log("[LIFECYCLE] Shopify app uninstall webhook:", {
    topic,
    shop,
    webhookId,
  });

  if (!shop) {
    console.error("[LIFECYCLE] APP_UNINSTALLED webhook has no shop.");
    return new Response("OK", { status: 200 });
  }

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

    const currentSubscription = shopRecord.currentSubscriptionGid
      ? await tx.billingSubscription.findUnique({
          where: {
            shopifySubscriptionGid: shopRecord.currentSubscriptionGid,
          },
          select: {
            id: true,
            status: true,
            trialStatus: true,
            trialStartsAt: true,
            trialEndsAt: true,
            currentPeriodStartsAt: true,
            currentPeriodEndsAt: true,
            paymentStatus: true,
            chargeStatus: true,
            refundStatus: true,
          },
        })
      : null;

    // Uninstall during trial is terminal for the trial window. We never
    // restore the remaining trial days on reinstall. Paid subscriptions are
    // different: if the subscription had already entered its paid period,
    // the remaining paid entitlement can be recovered on reinstall.
    if (
      currentSubscription &&
      currentSubscription.status !== "CANCELLED" &&
      currentSubscription.trialEndsAt &&
      now < currentSubscription.trialEndsAt
    ) {
      await tx.billingSubscription.update({
        where: { id: currentSubscription.id },
        data: {
          status: "CANCELLED",
          trialStatus: "CANCELLED",
          cancellationStatus: "EFFECTIVE",
          accessStatus: "NONE",
          cancelledAt: now,
          reconciliationStatus: "SYNCED",
          reconciliationCheckedAt: now,
          reconciliationReason: "TRIAL_FORFEITED_ON_UNINSTALL",
          repairRequiredAt: null,
        },
      });
    }

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

  // Shopify sessions are no longer valid for an uninstalled app. Removing
  // them also prevents delayed background work from treating the shop as
  // authenticated after uninstall.
  await db.session.deleteMany({
    where: { shop },
  });

  console.log("[LIFECYCLE] APP_UNINSTALLED processed:", {
    shop,
    webhookId,
    status: "UNINSTALLED",
  });

  return new Response("OK", { status: 200 });
};
