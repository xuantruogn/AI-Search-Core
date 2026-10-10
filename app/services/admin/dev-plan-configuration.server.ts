import db from "../../db.server";
import { parsePlanFeatureFlags } from "../commerce/plan-catalog.server";

export async function getDevPlanConfigurationData() {
  const plans = await db.plan.findMany({
    where: { handle: { not: "custom" } },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    select: {
      id: true,
      handle: true,
      name: true,
      visibility: true,
      billingMode: true,
      interval: true,
      price: true,
      currencyCode: true,
      trialDays: true,
      maxIndexedProducts: true,
      maxMonthlySearches: true,
      maxMonthlyVectorUpdates: true,
      usageBillingEnabled: true,
      shopifyPlanHandle: true,
      version: true,
      isActive: true,
      sortOrder: true,
      featureFlags: true,
      createdAt: true,
      updatedAt: true,
      subscriptions: {
        select: { status: true },
      },
    },
  });

  return {
    refundRequests: (await db.billingEvent.findMany({
      where: { type: "REFUND_REQUESTED" },
      orderBy: { occurredAt: "desc" }, take: 50,
      select: { id: true, shop: true, occurredAt: true, payload: true },
    })).map((event) => {
      const payload = event.payload && typeof event.payload === "object" && !Array.isArray(event.payload) ? event.payload : {};
      return { id: event.id, shop: event.shop, occurredAt: event.occurredAt.toISOString(),
        reason: typeof payload.reason === "string" ? payload.reason : "Contact merchant for details",
        chargeId: typeof payload.chargeId === "string" ? payload.chargeId : null,
      };
    }),
    generatedAt: new Date().toISOString(),
    plans: plans.map((plan) => ({
      id: plan.id,
      handle: plan.handle,
      name: plan.name,
      visibility: plan.visibility,
      billingMode: plan.billingMode,
      interval: plan.interval,
      price: Number(plan.price),
      currencyCode: plan.currencyCode,
      trialDays: plan.trialDays,
      limits: {
        productLimit: plan.maxIndexedProducts,
        searchLimit: plan.maxMonthlySearches,
        vectorUpdateLimit: plan.maxMonthlyVectorUpdates,
      },
      usageBillingEnabled: plan.usageBillingEnabled,
      shopifyPlanHandle: plan.shopifyPlanHandle,
      version: plan.version,
      isActive: plan.isActive,
      sortOrder: plan.sortOrder,
      features: parsePlanFeatureFlags(plan.featureFlags),
      subscriptions: {
        total: plan.subscriptions.length,
        active: plan.subscriptions.filter((item) => item.status === "ACTIVE").length,
        pending: plan.subscriptions.filter((item) => item.status === "PENDING").length,
        frozen: plan.subscriptions.filter((item) => item.status === "FROZEN").length,
      },
      createdAt: plan.createdAt.toISOString(),
      updatedAt: plan.updatedAt.toISOString(),
    })),
  };
}

export type DevPlanConfigurationData = Awaited<
  ReturnType<typeof getDevPlanConfigurationData>
>;
