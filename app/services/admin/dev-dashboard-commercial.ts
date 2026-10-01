export type BillingSnapshotForMrr = {
  status: string | null;
  priceSnapshot: unknown;
  currencySnapshot: string | null;
  intervalSnapshot: "EVERY_30_DAYS" | "ANNUAL" | null;
};

export function calculateSubscriptionMrr(
  subscription: BillingSnapshotForMrr,
) {
  if (
    subscription.status !== "ACTIVE" ||
    subscription.priceSnapshot === null ||
    subscription.priceSnapshot === undefined ||
    !subscription.currencySnapshot?.trim() ||
    !subscription.intervalSnapshot
  ) {
    return null;
  }

  const price = Number(subscription.priceSnapshot);
  if (!Number.isFinite(price) || price < 0) return null;

  return {
    currency: subscription.currencySnapshot.trim(),
    mrr: subscription.intervalSnapshot === "ANNUAL" ? price / 12 : price,
  };
}

export function buildQuotaView({
  subscriptionStatus,
  actualUsed,
  effectiveLimit,
  storedGrant,
  retained,
}: {
  subscriptionStatus: string;
  actualUsed: number;
  effectiveLimit: number | null;
  storedGrant: number;
  retained?: number;
}) {
  const active = subscriptionStatus === "ACTIVE";
  return {
    used: active ? Math.max(0, actualUsed) : 0,
    actualUsage: Math.max(0, actualUsed),
    retained: Math.max(0, retained ?? actualUsed),
    limit: active ? effectiveLimit : 0,
    storedGrant: Math.max(0, storedGrant),
  };
}

export function hasPendingCustomPrice({
  subscriptionStatus,
  billedPrice,
  configuredPrice,
}: {
  subscriptionStatus: string;
  billedPrice: number | null;
  configuredPrice: number | null;
}) {
  return (
    subscriptionStatus === "ACTIVE" &&
    configuredPrice !== null &&
    billedPrice !== configuredPrice
  );
}
