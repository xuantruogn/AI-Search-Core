import db from "../../db.server";
import type {
  BillingAccessStatus,
  BillingCancellationStatus,
  BillingChargeStatus,
  BillingPaymentStatus,
  BillingPlanChangeStatus,
  BillingReconciliationStatus,
  BillingRefundStatus,
  BillingTrialStatus,
} from "@prisma/client";
import type { SubscriptionSnapshot } from "./types.server";
import {
  AI_SEARCH_PLAN,
  getDevPlanOverride,
  PLAN_DEFINITIONS,
  type AiSearchPlan,
  type PlanLimits,
} from "./plans.server";

const BILLING_PLAN_SEEDS = [
  {
    handle: "basic",
    name: "Basic",
    price: 9.9,
    maxIndexedProducts: 505,
    maxMonthlySearches: 3_000,
    maxMonthlyVectorUpdates: 1_000,
    sortOrder: 10,
    trialDays: 7,
  },
  {
    handle: "pro",
    name: "Pro",
    price: 29.9,
    maxIndexedProducts: null,
    maxMonthlySearches: null,
    maxMonthlyVectorUpdates: null,
    sortOrder: 20,
    trialDays: 7,
  },
] as const;

type LegacySubscription = {
  shop: string;
  plan: string;
  status: string;
  planHandle: string | null;
  shopifySubscriptionId: string | null;
  billingPeriodStart: Date | null;
  billingPeriodEnd: Date | null;
  source: string;
  lastSyncedAt: Date | null;
};

function mapPlanHandleToKey(handle: string | null | undefined): AiSearchPlan {
  const clean = handle?.trim().toLowerCase();

  if (clean === "basic" || clean === "basic_plan" || clean === "ai_search_basic") {
    return AI_SEARCH_PLAN.basic;
  }

  if (clean === "pro" || clean === "pro_plan" || clean === "ai_search_pro") {
    return AI_SEARCH_PLAN.pro;
  }

  return AI_SEARCH_PLAN.custom;
}

export type BillingCommercialStatus =
  | "INACTIVE"
  | "PENDING"
  | "TRIAL"
  | "PAID"
  | "FROZEN";

function getTrialStatus(
  trialStartsAt: Date | null,
  trialEndsAt: Date | null,
  subscriptionStatus: string | null,
  now = new Date(),
): BillingTrialStatus {
  if (!trialStartsAt || !trialEndsAt) return "NONE";
  if (
    subscriptionStatus === "CANCELLED" ||
    subscriptionStatus === "DECLINED" ||
    subscriptionStatus === "EXPIRED"
  ) {
    return now < trialEndsAt ? "CANCELLED" : "ENDED";
  }
  return now < trialEndsAt ? "ACTIVE" : "ENDED";
}

function getCommercialStatus(
  status: string | null,
  trialStatus: BillingTrialStatus,
): BillingCommercialStatus {
  if (status === "PENDING") return "PENDING";
  if (status === "FROZEN") return "FROZEN";
  if (status === "ACTIVE") return trialStatus === "ACTIVE" ? "TRIAL" : "PAID";
  return "INACTIVE";
}

function getAccessStatus(
  status: string | null,
  plan: AiSearchPlan,
): BillingAccessStatus {
  if (status === "FROZEN") return "SUSPENDED";
  if (status !== "ACTIVE") return "NONE";
  if (plan === AI_SEARCH_PLAN.basic) return "BASIC";
  if (plan === AI_SEARCH_PLAN.pro) return "PRO";
  if (plan === AI_SEARCH_PLAN.custom) return "CUSTOM";
  return "NONE";
}

function getPlanChangeStatus(
  subscriptionStatus: string | null,
  storedStatus: BillingPlanChangeStatus,
  pendingSubscriptionGid: string | null,
): BillingPlanChangeStatus {
  if (
    storedStatus !== "NONE" &&
    storedStatus !== "PENDING"
  ) {
    return storedStatus;
  }

  if (subscriptionStatus === "PENDING" && pendingSubscriptionGid) {
    return "PENDING";
  }
  if (subscriptionStatus === "DECLINED") return "DECLINED";
  if (subscriptionStatus === "EXPIRED") return "EXPIRED";
  return storedStatus;
}

function limitsFromPlan(plan: {
  maxIndexedProducts: number | null;
  maxMonthlySearches: number | null;
  maxMonthlyVectorUpdates: number | null;
}): PlanLimits {
  return {
    productLimit: plan.maxIndexedProducts,
    searchLimit: plan.maxMonthlySearches,
    vectorUpdateLimit: plan.maxMonthlyVectorUpdates,
  };
}

const billingStateGlobal = globalThis as typeof globalThis & {
  aiSearchBillingPublicPlansPromise?: Promise<void>;
};

async function ensurePublicPlans() {
  const existing = billingStateGlobal.aiSearchBillingPublicPlansPromise;
  if (existing) return existing;

  const task = (async () => {
    for (const seed of BILLING_PLAN_SEEDS) {
    await db.plan.upsert({
      where: { handle: seed.handle },
      create: {
        handle: seed.handle,
        name: seed.name,
        price: seed.price,
        currencyCode: "USD",
        interval: "EVERY_30_DAYS",
        billingMode: "MANUAL_BILLING",
        visibility: "PUBLIC",
        maxIndexedProducts: seed.maxIndexedProducts,
        maxMonthlySearches: seed.maxMonthlySearches,
        maxMonthlyVectorUpdates: seed.maxMonthlyVectorUpdates,
        sortOrder: seed.sortOrder,
        trialDays: seed.trialDays,
        isActive: true,
      },
      update: {
        trialDays: seed.trialDays,
        billingMode: "MANUAL_BILLING",
      },
      });
    }
  })();

  billingStateGlobal.aiSearchBillingPublicPlansPromise = task;

  try {
    await task;
  } catch (error) {
    if (billingStateGlobal.aiSearchBillingPublicPlansPromise === task) {
      billingStateGlobal.aiSearchBillingPublicPlansPromise = undefined;
    }
    throw error;
  }
}

async function readLegacySubscription(shop: string) {
  const row = await db.aiSearchSubscription.findUnique({
    where: { shop },
    select: {
      shop: true,
      plan: true,
      status: true,
      planHandle: true,
      shopifySubscriptionId: true,
      billingPeriodStart: true,
      billingPeriodEnd: true,
      source: true,
      lastSyncedAt: true,
    },
  });

  return row as LegacySubscription | null;
}

async function migrateLegacySubscription(
  legacy: LegacySubscription,
) {
  if (
    legacy.status !== "ACTIVE" ||
    (legacy.plan !== AI_SEARCH_PLAN.basic &&
      legacy.plan !== AI_SEARCH_PLAN.pro)
  ) {
    return null;
  }

  const plan = await db.plan.findUnique({
    where: { handle: legacy.plan.toLowerCase() },
  });

  if (!plan) return null;

  const existing = legacy.shopifySubscriptionId
    ? await db.billingSubscription.findUnique({
        where: { shopifySubscriptionGid: legacy.shopifySubscriptionId },
      })
    : await db.billingSubscription.findFirst({
        where: {
          shop: legacy.shop,
          status: "ACTIVE",
        },
        orderBy: { updatedAt: "desc" },
      });

  if (existing) return existing;

  return db.billingSubscription.create({
    data: {
      shop: legacy.shop,
      planId: plan.id,
      shopifySubscriptionGid: legacy.shopifySubscriptionId,
      shopifyPlanHandle: legacy.planHandle ?? plan.handle,
      status: "ACTIVE",
      planNameSnapshot: plan.name,
      priceSnapshot: plan.price,
      currencySnapshot: plan.currencyCode,
      intervalSnapshot: plan.interval,
      currentPeriodStartsAt: legacy.billingPeriodStart,
      currentPeriodEndsAt: legacy.billingPeriodEnd,
      activatedAt: legacy.lastSyncedAt ?? new Date(),
      rawResponse: {
        migratedFrom: "AiSearchSubscription",
        source: legacy.source,
      },
    },
  });
}

export async function ensureBillingV2State(shop: string) {
  await ensurePublicPlans();

  const legacy = await readLegacySubscription(shop);

  const explicitDevOverride = Boolean(
    process.env.AI_SEARCH_DEV_PLAN?.trim(),
  );

  // DEV_OVERRIDE chỉ có hiệu lực khi AI_SEARCH_DEV_PLAN
  // thực sự được khai báo trong môi trường hiện tại.
  if (explicitDevOverride && legacy?.source === "DEV_OVERRIDE") {
    return {
      subscription: null,
      legacy,
      devOverride: true,
    } as const;
  }

  // Current entitlement is anchored by AiSearchShop.currentSubscriptionGid.
  // A newly-created PENDING subscription must never displace the currently
  // active/frozen entitlement merely because it has a newer updatedAt.
  const shopPointer = await db.aiSearchShop.findUnique({
    where: { shop },
    select: { currentSubscriptionGid: true },
  });

  let subscription = shopPointer?.currentSubscriptionGid
    ? await db.billingSubscription.findUnique({
        where: {
          shopifySubscriptionGid: shopPointer.currentSubscriptionGid,
        },
      })
    : null;

  // If the pointer is stale/missing, recover from an actual ACTIVE record.
  // FROZEN is also a current lifecycle state, so allow it as a fallback only
  // after an ACTIVE lookup has been exhausted.
  if (
        !subscription ||
        (subscription.status !== "ACTIVE" &&
          subscription.status !== "FROZEN")
      ) {
    subscription = await db.billingSubscription.findFirst({
      where: { shop, status: "ACTIVE" },
      orderBy: { updatedAt: "desc" },
    });
  }

  // A brand-new shop may legitimately have only a PENDING subscription.
  // Only use PENDING when there is no current ACTIVE/FROZEN entitlement.
  if (!subscription) {
    subscription = await db.billingSubscription.findFirst({
      where: { shop, status: "PENDING" },
      orderBy: { updatedAt: "desc" },
    });
  }

  if (
      !subscription &&
      legacy &&
      legacy.source !== "DEV_OVERRIDE"
    ) {
      subscription = await migrateLegacySubscription(legacy);
    }

  return {
    subscription,
    legacy,
    devOverride: false,
  } as const;
}

export async function getBillingSubscriptionSnapshot(
  shop: string,
): Promise<SubscriptionSnapshot> {
  const state = await ensureBillingV2State(shop);

  if (state.devOverride && state.legacy) {
  const devPlan = getDevPlanOverride();

  const plan =
    devPlan ??
    (state.legacy.plan === AI_SEARCH_PLAN.basic
      ? AI_SEARCH_PLAN.basic
      : state.legacy.plan === AI_SEARCH_PLAN.pro
        ? AI_SEARCH_PLAN.pro
        : AI_SEARCH_PLAN.none);

  return {
    shop: state.legacy.shop,
    plan,
    planId: null,
    planLabel:
      PLAN_DEFINITIONS[plan]?.label ?? PLAN_DEFINITIONS.NONE.label,
    limits:
      PLAN_DEFINITIONS[plan]?.limits ?? PLAN_DEFINITIONS.NONE.limits,
    status: state.legacy.status,
    planHandle: state.legacy.planHandle,
    shopifySubscriptionId: state.legacy.shopifySubscriptionId,
    billingPeriodStart: state.legacy.billingPeriodStart,
    billingPeriodEnd: state.legacy.billingPeriodEnd,
    billingInterval: null,
    commercialStatus: getCommercialStatus(state.legacy.status, "NONE"),
    trialStatus: "NONE",
    trialStartsAt: null,
    trialEndsAt: null,
    cancellationStatus: "NONE",
    planChangeStatus: "NONE",
    chargeStatus: "NONE",
    paymentStatus: "NONE",
    refundStatus: "NONE",
    accessStatus: getAccessStatus(state.legacy.status, plan),
    reconciliationStatus: "SYNCED",
    reconciliationReason: null,
    source: state.legacy.source,
    lastSyncedAt: state.legacy.lastSyncedAt,
  };
}

  const subscription = state.subscription;

  if (!subscription) {
    return {
      shop,
      plan: AI_SEARCH_PLAN.none,
      planId: null,
      planLabel: PLAN_DEFINITIONS.NONE.label,
      limits: PLAN_DEFINITIONS.NONE.limits,
      status: "INACTIVE",
      planHandle: null,
      shopifySubscriptionId: null,
      billingPeriodStart: null,
      billingPeriodEnd: null,
      billingInterval: null,
      commercialStatus: "INACTIVE",
      trialStatus: "NONE",
      trialStartsAt: null,
      trialEndsAt: null,
      cancellationStatus: "NONE",
      planChangeStatus: "NONE",
      chargeStatus: "NONE",
      paymentStatus: "NONE",
      refundStatus: "NONE",
      accessStatus: "NONE",
      reconciliationStatus: "SYNCED",
      reconciliationReason: null,
      source: "BILLING_V2",
      lastSyncedAt: null,
    };
  }

  let plan = subscription.planId
    ? await db.plan.findUnique({
        where: { id: subscription.planId },
      })
    : null;

  // A custom shop plan may be assigned independently of the Shopify handle.
  if (!plan) {
    const assignment = await db.planAssignment.findFirst({
      where: {
        shop,
        isActive: true,
        OR: [
          { startsAt: null },
          { startsAt: { lte: new Date() } },
        ],
      },
      include: { plan: true },
      orderBy: { createdAt: "desc" },
    });
    plan = assignment?.plan ?? null;
  }

  if (!plan) {
    const trialStatus = getTrialStatus(
      subscription.trialStartsAt,
      subscription.trialEndsAt,
      subscription.status,
    );
    return {
      shop,
      plan: AI_SEARCH_PLAN.none,
      planId: null,
      planLabel: PLAN_DEFINITIONS.NONE.label,
      limits: PLAN_DEFINITIONS.NONE.limits,
      status: "INACTIVE",
      planHandle: subscription.shopifyPlanHandle,
      shopifySubscriptionId: subscription.shopifySubscriptionGid,
      billingPeriodStart: subscription.currentPeriodStartsAt,
      billingPeriodEnd: subscription.currentPeriodEndsAt,
      billingInterval: subscription.intervalSnapshot,
      commercialStatus: getCommercialStatus(subscription.status, trialStatus),
      trialStatus,
      trialStartsAt: subscription.trialStartsAt,
      trialEndsAt: subscription.trialEndsAt,
      cancellationStatus: subscription.cancellationStatus,
      planChangeStatus: getPlanChangeStatus(
        subscription.status,
        subscription.planChangeStatus,
        null,
      ),
      chargeStatus: subscription.chargeStatus,
      paymentStatus: subscription.paymentStatus,
      refundStatus: subscription.refundStatus,
      accessStatus: "NONE",
      reconciliationStatus: subscription.reconciliationStatus,
      reconciliationReason: subscription.reconciliationReason,
      source: "BILLING_V2",
      lastSyncedAt: subscription.updatedAt,
    };
  }

  const planKey = mapPlanHandleToKey(plan.handle);
  const trialStatus = getTrialStatus(
    subscription.trialStartsAt,
    subscription.trialEndsAt,
    subscription.status,
  );
  const accessStatus = getAccessStatus(subscription.status, planKey);

  return {
    shop,
    plan: planKey,
    planId: plan.id,
    planLabel: plan.name,
    limits: limitsFromPlan(plan),
    status: subscription.status ?? "INACTIVE",
    planHandle: subscription.shopifyPlanHandle ?? plan.handle,
    shopifySubscriptionId: subscription.shopifySubscriptionGid,
    billingPeriodStart: subscription.currentPeriodStartsAt,
    billingPeriodEnd: subscription.currentPeriodEndsAt,
    billingInterval: subscription.intervalSnapshot,
    commercialStatus: getCommercialStatus(subscription.status, trialStatus),
    trialStatus,
    trialStartsAt: subscription.trialStartsAt,
    trialEndsAt: subscription.trialEndsAt,
    cancellationStatus: subscription.cancellationStatus,
    planChangeStatus: getPlanChangeStatus(
      subscription.status,
      subscription.planChangeStatus,
      (await db.aiSearchShop.findUnique({
        where: { shop },
        select: { pendingSubscriptionGid: true },
      }))?.pendingSubscriptionGid ?? null,
    ),
    chargeStatus: subscription.chargeStatus,
    paymentStatus: subscription.paymentStatus,
    refundStatus: subscription.refundStatus,
    accessStatus,
    reconciliationStatus: subscription.reconciliationStatus,
    reconciliationReason: subscription.reconciliationReason,
    source: "BILLING_V2",
    lastSyncedAt: subscription.updatedAt,
  };
}

export async function mirrorBillingStateToLegacy(snapshot: {
  shop: string;
  plan: AiSearchPlan;
  status: string;
  planHandle: string | null;
  shopifySubscriptionId: string | null;
  billingPeriodStart: Date | null;
  billingPeriodEnd: Date | null;
  source: string;
  lastSyncedAt: Date | null;
}) {
  await db.aiSearchSubscription.upsert({
    where: { shop: snapshot.shop },
    create: {
      shop: snapshot.shop,
      plan: snapshot.plan,
      status: snapshot.status,
      planHandle: snapshot.planHandle,
      shopifySubscriptionId: snapshot.shopifySubscriptionId,
      billingPeriodStart: snapshot.billingPeriodStart,
      billingPeriodEnd: snapshot.billingPeriodEnd,
      source: snapshot.source,
      lastSyncedAt: snapshot.lastSyncedAt,
    },
    update: {
      plan: snapshot.plan,
      status: snapshot.status,
      planHandle: snapshot.planHandle,
      shopifySubscriptionId: snapshot.shopifySubscriptionId,
      billingPeriodStart: snapshot.billingPeriodStart,
      billingPeriodEnd: snapshot.billingPeriodEnd,
      source: snapshot.source,
      lastSyncedAt: snapshot.lastSyncedAt,
    },
  });
}

export async function recordBillingEvent({
  shop,
  subscriptionGid,
  type,
  source = "RECONCILIATION",
  idempotencyKey,
  payload,
}: {
  shop: string;
  subscriptionGid?: string | null;
  type:
    | "SUBSCRIPTION_CREATED"
    | "SUBSCRIPTION_APPROVED"
    | "SUBSCRIPTION_ACTIVATED"
    | "SUBSCRIPTION_UPDATED"
    | "SUBSCRIPTION_DECLINED"
    | "SUBSCRIPTION_EXPIRED"
    | "SUBSCRIPTION_CANCELLED"
    | "SUBSCRIPTION_FROZEN"
    | "SUBSCRIPTION_UNFROZEN"
    | "TRIAL_STARTED"
    | "TRIAL_EXTENDED"
    | "TRIAL_ENDED"
    | "TRIAL_CANCELLED"
    | "CANCELLATION_REQUESTED"
    | "CANCELLATION_EFFECTIVE"
    | "PAYMENT_FAILED"
    | "PAYMENT_RECOVERED"
    | "PLAN_CHANGE_REQUESTED"
    | "PLAN_CHANGE_APPLIED"
    | "PLAN_CHANGE_DECLINED"
    | "PLAN_CHANGE_EXPIRED"
    | "PLAN_CHANGE_DEFERRED"
    | "REFUND_REQUESTED"
    | "REFUND_PARTIAL"
    | "REFUND_FULL"
    | "PLAN_UPGRADE"
    | "PLAN_DOWNGRADE"
    | "APP_UNINSTALLED"
    | "APP_REINSTALLED"
    | "BILLING_RECONCILED"
    | "WEBHOOK_DUPLICATE"
    | "WEBHOOK_OUT_OF_ORDER"
    | "WEBHOOK_RETRY"
    | "REDIRECT_BEFORE_WEBHOOK"
    | "DB_SHOPIFY_MISMATCH"
    | "MISSING_DB_RECORD"
    | "MISSING_SHOPIFY_RECORD";
  source?: "CALLBACK" | "WEBHOOK" | "API" | "RECONCILIATION";
  idempotencyKey: string;
  payload?: unknown;
}) {
  const existing = await db.billingEvent.findUnique({
    where: { idempotencyKey },
    select: { id: true },
  });

  if (existing) return existing;

  try {
    return await db.billingEvent.create({
      data: {
        shop,
        subscriptionGid: subscriptionGid ?? null,
        type,
        source,
        idempotencyKey,
        payload: payload === undefined ? undefined : (payload as object),
        occurredAt: new Date(),
      },
    });
  } catch (error) {
    // A concurrent request may have created the same event after the read.
    if (
      error instanceof Error &&
      "code" in error &&
      (error as { code?: string }).code === "P2002"
    ) {
      return db.billingEvent.findUnique({
        where: { idempotencyKey },
        select: { id: true },
      });
    }
    throw error;
  }
}
