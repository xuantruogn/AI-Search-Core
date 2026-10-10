import db from "../../db.server";
import { parsePlanFeatureFlags } from "./plan-catalog.server";
import { formatPlanMoney } from "./money";

// Fresh read, no stale pricing cache. Never expose assignments/private plans.
export async function getPublicPricing() {
  const plans = await db.plan.findMany({ where: { isActive: true, visibility: "PUBLIC", billingMode: "MANUAL_BILLING", handle: { not: "custom" } }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] });
  const capacity = (value: number | null, label: string) => value === null ? `Unlimited ${label}` : `${value.toLocaleString("en-US")} ${label}`;
  return plans.map((plan) => {
    const config = parsePlanFeatureFlags(plan.featureFlags);
    return { handle: plan.handle, name: plan.name, price: formatPlanMoney(Number(plan.price), plan.currencyCode), suffix: plan.interval === "ANNUAL" ? "/ year" : "/ month", featured: plan.handle === "pro", description: config.description,
      trialDays: plan.handle === "basic" ? plan.trialDays : 0,
      features: [capacity(plan.maxIndexedProducts, "indexed products"), capacity(plan.maxMonthlySearches, "searches per cycle"), capacity(plan.maxMonthlyVectorUpdates, "vector updates per cycle"), ...config.merchantFeatures.filter((feature) => feature.included).map((feature) => feature.label)],
      billingPolicy: config.billingPolicy,
    };
  });
}
