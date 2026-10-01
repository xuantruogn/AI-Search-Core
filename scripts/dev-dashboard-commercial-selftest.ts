import assert from "node:assert/strict";

import {
  buildQuotaView,
  calculateSubscriptionMrr,
  hasPendingCustomPrice,
} from "../app/services/admin/dev-dashboard-commercial";

const inactiveSearch = buildQuotaView({
  subscriptionStatus: "INACTIVE",
  actualUsed: 45,
  effectiveLimit: 300,
  storedGrant: 300,
});
assert.deepEqual(
  { used: inactiveSearch.used, limit: inactiveSearch.limit, grant: inactiveSearch.storedGrant },
  { used: 0, limit: 0, grant: 300 },
  "CASE A: inactive capacity must be 0/0 while preserving the stored grant",
);
assert.equal(
  calculateSubscriptionMrr({ status: "INACTIVE", priceSnapshot: 9.9, currencySnapshot: "USD", intervalSnapshot: "EVERY_30_DAYS" }),
  null,
  "CASE A: inactive subscription must not contribute MRR",
);

const activeSearch = buildQuotaView({
  subscriptionStatus: "ACTIVE",
  actualUsed: 0,
  effectiveLimit: 3_300,
  storedGrant: 300,
});
assert.equal(activeSearch.limit, 3_300, "CASE B: active quota includes the grant");
assert.deepEqual(
  calculateSubscriptionMrr({ status: "ACTIVE", priceSnapshot: 9.9, currencySnapshot: "USD", intervalSnapshot: "EVERY_30_DAYS" }),
  { currency: "USD", mrr: 9.9 },
  "CASE B: active Basic uses BillingSubscription.priceSnapshot",
);

assert.equal(
  calculateSubscriptionMrr({ status: "INACTIVE", priceSnapshot: 60, currencySnapshot: "USD", intervalSnapshot: "EVERY_30_DAYS" }),
  null,
  "CASE C: configured Custom terms alone do not create revenue",
);
assert.equal(
  hasPendingCustomPrice({ subscriptionStatus: "INACTIVE", billedPrice: null, configuredPrice: 60 }),
  false,
  "CASE C: inactive terms are configured, not an active price change",
);

assert.deepEqual(
  calculateSubscriptionMrr({ status: "ACTIVE", priceSnapshot: 47, currencySnapshot: "USD", intervalSnapshot: "EVERY_30_DAYS" }),
  { currency: "USD", mrr: 47 },
  "CASE D: MRR stays on the active $47 snapshot",
);
assert.equal(
  hasPendingCustomPrice({ subscriptionStatus: "ACTIVE", billedPrice: 47, configuredPrice: 60 }),
  true,
  "CASE D: configured $60 vs billed $47 is pending",
);

assert.deepEqual(
  calculateSubscriptionMrr({ status: "ACTIVE", priceSnapshot: 60, currencySnapshot: "USD", intervalSnapshot: "EVERY_30_DAYS" }),
  { currency: "USD", mrr: 60 },
  "CASE E: activated $60 snapshot contributes $60 MRR",
);
assert.equal(
  hasPendingCustomPrice({ subscriptionStatus: "ACTIVE", billedPrice: 60, configuredPrice: 60 }),
  false,
  "CASE E: matching configured and billed prices are not pending",
);

const frozen = buildQuotaView({
  subscriptionStatus: "FROZEN",
  actualUsed: 25,
  effectiveLimit: 3_300,
  storedGrant: 300,
});
assert.equal(frozen.limit, 0, "CASE F: frozen usable quota is zero");
assert.equal(
  calculateSubscriptionMrr({ status: "FROZEN", priceSnapshot: 47, currencySnapshot: "USD", intervalSnapshot: "EVERY_30_DAYS" }),
  null,
  "CASE F: frozen subscription does not contribute active MRR",
);

assert.deepEqual(
  calculateSubscriptionMrr({ status: "ACTIVE", priceSnapshot: 1_200, currencySnapshot: "EUR", intervalSnapshot: "ANNUAL" }),
  { currency: "EUR", mrr: 100 },
  "Annual subscriptions must contribute one twelfth per month in their own currency",
);

console.log("Dev Dashboard commercial acceptance cases: PASS");
