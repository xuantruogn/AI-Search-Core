import type { ActionFunctionArgs } from "react-router";

import { authenticate, unauthenticated } from "../shopify.server";
import { reconcileShopifySubscriptionFromAdmin } from "../services/billing/shopify-app-pricing.server";
import { recordBillingEvent } from "../services/commerce/billing-state.server";
// IMPORT THÊM HÀM RECONCILE COMMERCIAL CATALOG
import { reconcileShopCommercialState } from "../services/commerce/reconciliation.server";

import db from "../db.server";

type AppSubscriptionUpdatePayload = {
  app_subscription?: {
    admin_graphql_api_id?: string;
    name?: string;
    status?: string;
    plan_handle?: string | null;
    updated_at?: string;
  };
};

const SHOPIFY_SUBSCRIPTION_STATUSES = new Set([
  "PENDING",
  "ACTIVE",
  "FROZEN",
  "CANCELLED",
  "DECLINED",
  "EXPIRED",
]);

export const action = async ({ request }: ActionFunctionArgs) => {

  console.log("========== [WEBHOOK TEST] APP_SUBSCRIPTIONS_UPDATE RECEIVED ==========");

  const { payload, topic, shop, webhookId } = await authenticate.webhook(request);

  const body = payload as AppSubscriptionUpdatePayload;
  const subscription = body.app_subscription;
  const subscriptionGid = subscription?.admin_graphql_api_id;
  const status = subscription?.status;

  console.log("[BILLING] Received Shopify subscription webhook:", {
    topic,
    shop,
    subscriptionGid,
    status,
    planHandle: subscription?.plan_handle,
    name: subscription?.name,
  });

  if (!subscriptionGid || !status) {
    console.error("[BILLING] Invalid APP_SUBSCRIPTIONS_UPDATE payload:", body);
    return new Response("OK", { status: 200 });
  }

  if (!SHOPIFY_SUBSCRIPTION_STATUSES.has(status)) {
    console.error("[BILLING] Unknown Shopify subscription status:", {
      shop,
      subscriptionGid,
      status,
    });
    return new Response("OK", { status: 200 });
  }

  const webhookIdempotencyKey = `shopify-webhook:${webhookId}`;

  const existingWebhook = await db.billingEvent.findUnique({
    where: { idempotencyKey: webhookIdempotencyKey },
    select: { id: true },
  });

  if (existingWebhook) {
    await recordBillingEvent({
      shop,
      subscriptionGid,
      type: "WEBHOOK_DUPLICATE",
      source: "WEBHOOK",
      idempotencyKey: `webhook-duplicate:${webhookId}`,
      payload: {
        topic,
        webhookId,
        reason: "IDEMPOTENCY_KEY_ALREADY_PROCESSED",
      },
    });

    await recordBillingEvent({
      shop,
      subscriptionGid,
      type: "WEBHOOK_RETRY",
      source: "WEBHOOK",
      idempotencyKey: `webhook-retry:${webhookId}`,
      payload: {
        topic,
        webhookId,
        reason: "DUPLICATE_WEBHOOK_DELIVERY",
      },
    });

    console.log("[BILLING MATRIX] Duplicate/retry webhook ignored:", {
      shop,
      webhookId,
      subscriptionGid,
    });

    return new Response("OK", { status: 200 });
  }

  const localBeforeWebhook = await db.billingSubscription.findUnique({
    where: { shopifySubscriptionGid: subscriptionGid },
    select: {
      status: true,
      shopifyUpdatedAt: true,
    },
  });

  const incomingUpdatedAt = subscription?.updated_at
    ? new Date(subscription.updated_at)
    : null;

  if (
    localBeforeWebhook?.shopifyUpdatedAt &&
    incomingUpdatedAt &&
    !Number.isNaN(incomingUpdatedAt.getTime()) &&
    incomingUpdatedAt.getTime() <
      localBeforeWebhook.shopifyUpdatedAt.getTime()
  ) {
    await recordBillingEvent({
      shop,
      subscriptionGid,
      type: "WEBHOOK_OUT_OF_ORDER",
      source: "WEBHOOK",
      idempotencyKey: `webhook-out-of-order:${webhookId}`,
      payload: {
        webhookId,
        incomingUpdatedAt: incomingUpdatedAt.toISOString(),
        storedUpdatedAt: localBeforeWebhook.shopifyUpdatedAt.toISOString(),
        storedStatus: localBeforeWebhook.status,
        webhookStatus: status,
      },
    });

    console.warn("[BILLING MATRIX] Out-of-order webhook detected:", {
      shop,
      webhookId,
      subscriptionGid,
      incomingUpdatedAt: incomingUpdatedAt.toISOString(),
      storedUpdatedAt: localBeforeWebhook.shopifyUpdatedAt.toISOString(),
    });
  }

  const { admin } = await unauthenticated.admin(shop);

  // Re-query Shopify qua Admin API để làm nguồn sự thật (Source of truth)
  const result = await reconcileShopifySubscriptionFromAdmin({
    shop,
    admin,
    expectedSubscriptionGid: subscriptionGid,
    preferredPlanHandle: subscription?.plan_handle ?? null,
    source: "WEBHOOK",
    observedShopifyStatus: status as
      | "PENDING"
      | "ACTIVE"
      | "FROZEN"
      | "CANCELLED"
      | "DECLINED"
      | "EXPIRED",
  });

  console.log("[BILLING] Shopify subscription webhook reconciled:", {
    shop,
    subscriptionGid,
    webhookStatus: status,
    confirmed: result.confirmed,
    changed: result.changed,
    localStatus: result.subscription.status,
  });

  // KÍCH HOẠT COMMERCIAL RECONCILE NGẦM Ở BACKGROUND (CHÍNH THỨC NHẬN OWNERSHIP)
  if (result.confirmed && result.subscription.status !== "PENDING") {
    void reconcileShopCommercialState({
      shop,
      forceCatalogRefresh: result.subscription.status === "ACTIVE",
    }).catch((error) => {
      console.error(
        "[WEBHOOK] Commercial reconciliation background execution failed:",
        {
          shop,
          subscriptionGid,
          subscriptionStatus: result.subscription.status,
          error: error instanceof Error ? error.message : String(error),
        },
      );
    });
  }

  return new Response("OK", { status: 200 });
};