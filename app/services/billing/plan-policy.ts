export type PlanBillingPolicy = {
  moneyBackGuaranteeDays: number;
  refundTerms: string;
};

export function validatePolicyDays(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0 || value > 365) {
    throw new Error(`${label} must be a whole number between 0 and 365.`);
  }
  return value;
}

// Legacy plans have no money-back promise. Never invent one on upgrade.
export function parsePlanBillingPolicy(value: unknown): PlanBillingPolicy {
  const record = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
  const days = record.moneyBackGuaranteeDays;
  return {
    moneyBackGuaranteeDays: typeof days === "number" && Number.isInteger(days)
      && days >= 0 && days <= 365 ? days : 0,
    refundTerms: typeof record.refundTerms === "string" ? record.refundTerms.trim().slice(0, 2000) : "",
  };
}

export function validatePlanBillingPolicy(days: number, terms: string): PlanBillingPolicy {
  const moneyBackGuaranteeDays = validatePolicyDays(days, "Money-back guarantee days");
  const refundTerms = terms.trim().slice(0, 2000);
  if (moneyBackGuaranteeDays > 0 && !refundTerms) {
    throw new Error("Refund terms are required when the money-back guarantee is enabled.");
  }
  return { moneyBackGuaranteeDays, refundTerms };
}

export function checkoutBillingPolicy(raw: unknown): PlanBillingPolicy {
  const record = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown> : {};
  const snapshot = record.billingPolicySnapshot;
  const saved = snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)
    ? snapshot as Record<string, unknown> : {};
  return parsePlanBillingPolicy(saved.kind === "PLAN_BILLING_POLICY" && saved.version === 1 ? saved.billingPolicy : null);
}

// One introductory trial per shop, only on Basic, never on other tiers.
export function offeredTrialDays(handle: string, configured: number, hasApproved: boolean): number {
  return handle.toLowerCase() === "basic" && !hasApproved
    ? validatePolicyDays(configured, "Free trial days") : 0;
}

export function refundGuaranteeWindow(policy: PlanBillingPolicy, charge: {
  status: string; paidAt: Date | null; shopifyChargeId: string | null; testMode: boolean | null;
}, now = new Date()) {
  if (policy.moneyBackGuaranteeDays === 0) return { eligible: false, endsAt: null, reason: "DISABLED" };
  if (charge.status !== "PAID" || !charge.paidAt || !charge.shopifyChargeId || charge.testMode !== false) {
    return { eligible: false, endsAt: null, reason: "PAYMENT_NOT_VERIFIED" };
  }
  const paidAt = charge.paidAt.getTime();
  if (!Number.isFinite(paidAt) || paidAt > now.getTime()) {
    return { eligible: false, endsAt: null, reason: "PAYMENT_NOT_VERIFIED" };
  }
  const endsAt = new Date(paidAt + policy.moneyBackGuaranteeDays * 86400000);
  return { eligible: now < endsAt, endsAt: endsAt.toISOString(), reason: now < endsAt ? "WITHIN_WINDOW" : "EXPIRED" };
}
