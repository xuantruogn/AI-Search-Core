import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { checkoutBillingPolicy, offeredTrialDays, parsePlanBillingPolicy, refundGuaranteeWindow, validatePlanBillingPolicy } from "../app/services/billing/plan-policy";

assert.equal(offeredTrialDays("basic", 7, false), 7);
assert.equal(offeredTrialDays("basic", 7, true), 0);
for (const handle of ["pro", "custom", "growth"]) {
  assert.equal(offeredTrialDays(handle, 30, false), 0);
}
assert.deepEqual(parsePlanBillingPolicy(null), { moneyBackGuaranteeDays: 0, refundTerms: "" });
for (const days of [-1, 1.2, 366, NaN, Infinity]) {
  assert.throws(() => validatePlanBillingPolicy(days, "Terms"));
}
assert.throws(() => validatePlanBillingPolicy(7, ""));
const policy = validatePlanBillingPolicy(7, "Contact developer for review.");
const purchased = { billingPolicySnapshot: { kind: "PLAN_BILLING_POLICY", version: 1, billingPolicy: policy } };
assert.deepEqual(checkoutBillingPolicy(purchased), policy);
assert.equal(checkoutBillingPolicy({ billingPolicy: policy }).moneyBackGuaranteeDays, 0);
assert.equal(checkoutBillingPolicy({ billingPolicySnapshot: { version: 2, billingPolicy: policy } }).moneyBackGuaranteeDays, 0);
assert.equal(checkoutBillingPolicy(null).moneyBackGuaranteeDays, 0);
const changedPlan = validatePlanBillingPolicy(30, "New terms");
assert.notDeepEqual(checkoutBillingPolicy(purchased), changedPlan);
const charge = { status: "PAID", paidAt: new Date("2026-10-01T00:00:00Z"), shopifyChargeId: "provider-charge-1", testMode: false };
assert.equal(refundGuaranteeWindow(policy, charge, new Date("2026-10-07T23:59:59Z")).eligible, true);
assert.equal(refundGuaranteeWindow(policy, charge, new Date("2026-10-08T00:00:00Z")).eligible, false);
for (const invalid of [{ ...charge, status: "PENDING" }, { ...charge, paidAt: null }, { ...charge, shopifyChargeId: null }, { ...charge, testMode: true }, { ...charge, testMode: null }]) {
  assert.equal(refundGuaranteeWindow(policy, invalid).eligible, false);
}
assert.equal(refundGuaranteeWindow(policy, charge, new Date("2026-09-30T00:00:00Z")).eligible, false);
assert.equal(refundGuaranteeWindow(parsePlanBillingPolicy(null), charge).reason, "DISABLED");
// Real request builder integration: explicit zero suppresses Shopify defaults.
const route = readFileSync(new URL("../app/routes/app.billing.tsx", import.meta.url), "utf8");
assert.ok(route.includes("offeredTrialDays(billingPlan.handle, billingPlan.trialDays, hasEverApprovedSubscription)"));
assert.ok(!route.includes("trialDays > 0 ? trialDays : null"));
assert.ok(route.includes("plan-policy:${createdSubscription.id}"));
const refundService = readFileSync(new URL("../app/services/billing/refund-guarantee.server.ts", import.meta.url), "utf8");
assert.ok(refundService.includes("where: { id: chargeId, shop }"));
assert.ok(refundService.includes('type: "REFUND_REQUESTED"'));
assert.ok(!refundService.includes("billingSubscription.update"));
assert.ok(!refundService.includes("billingRefund.create"));
console.log("PASS billing plan policy: Basic-only trials, per-plan guarantees, verified-payment boundaries and checkout snapshot");
