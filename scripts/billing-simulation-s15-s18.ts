import assert from "node:assert/strict";

const simulationDatabaseUrl = process.env.BILLING_SIMULATION_DATABASE_URL?.trim();
const productionDatabaseUrl = process.env.DATABASE_URL?.trim();

if (!simulationDatabaseUrl) {
  throw new Error("S15-S18 BLOCKED: BILLING_SIMULATION_DATABASE_URL is required.");
}
if (productionDatabaseUrl && simulationDatabaseUrl === productionDatabaseUrl) {
  throw new Error("S15-S18 BLOCKED: BILLING_SIMULATION_DATABASE_URL must differ from DATABASE_URL.");
}

process.env.DATABASE_URL = simulationDatabaseUrl;
process.env.NODE_ENV = "test";

const { default: db } = await import("../app/db.server");
const { reconcileShopifySubscriptionFromAdmin } =
  await import("../app/services/billing/shopify-app-pricing.server");
const {
  ensureBillingV2State,
  getBillingSubscriptionSnapshot,
  emitBillingBackendContract,
} = await import("../app/services/commerce/billing-state.server");
const { getShopEntitlement } =
  await import("../app/services/commerce/entitlement.server");

type Status = "PENDING" | "ACTIVE" | "FROZEN";
type ScenarioId = "S15" | "S16" | "S17" | "S18";

const SCENARIOS = [
  { id: "S15" as const, shop: "billing-simulation-s15.myshopify.com", gid: "gid://shopify/AppSubscription/simulation-s15", input: "PENDING -> charge/payment pending", status: "PENDING" as const, description: "A new subscription is awaiting billing approval/payment; no paid entitlement is granted." },
  { id: "S16" as const, shop: "billing-simulation-s16.myshopify.com", gid: "gid://shopify/AppSubscription/simulation-s16", input: "ACTIVE -> charge/payment paid", status: "ACTIVE" as const, description: "An active non-trial subscription has a successful paid billing state." },
  { id: "S17" as const, shop: "billing-simulation-s17.myshopify.com", gid: "gid://shopify/AppSubscription/simulation-s17", input: "ACTIVE -> FROZEN / payment failed", status: "FROZEN" as const, description: "A paid subscription enters frozen state after a payment failure; access is suspended." },
  { id: "S18" as const, shop: "billing-simulation-s18.myshopify.com", gid: "gid://shopify/AppSubscription/simulation-s18", input: "FROZEN -> ACTIVE / payment recovered", status: "ACTIVE" as const, description: "A frozen subscription recovers after payment and access is restored." },
];

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

function simulatedAdmin(scenario: (typeof SCENARIOS)[number], status: Status, periodEnd: Date) {
  const now = new Date();
  return {
    graphql: async (query: string) => {
      if (query.includes("AiSearchShopIdentity")) {
        return jsonResponse({ data: { shop: { id: `gid://shopify/Shop/${scenario.id.toLowerCase()}`, myshopifyDomain: scenario.shop } } });
      }
      if (query.includes("GetCurrentAppSubscriptions")) {
        const subscription = {
          id: scenario.gid,
          name: `Simulation ${scenario.id}`,
          status,
          createdAt: now.toISOString(),
          updatedAt: new Date().toISOString(),
          currentPeriodEnd: periodEnd.toISOString(),
          trialDays: 0,
          test: true,
          lineItems: [{
            id: `gid://shopify/AppSubscriptionLineItem/${scenario.id.toLowerCase()}`,
            plan: { pricingDetails: {
              __typename: "AppRecurringPricing",
              planHandle: "basic",
              interval: "EVERY_30_DAYS",
              price: { amount: "9.90", currencyCode: "USD" },
            }},
          }],
        };
        return jsonResponse({
          data: { currentAppInstallation: {
            activeSubscriptions: status === "ACTIVE" ? [subscription] : [],
            allSubscriptions: { nodes: [subscription], pageInfo: { hasNextPage: false, endCursor: null } },
          }},
        });
      }
      throw new Error(`${scenario.id} mock received an unexpected GraphQL query.`);
    },
  };
}

function logBlock(label: string, value: unknown) {
  console.log(label);
  console.log(JSON.stringify(value, null, 2));
}

async function cleanup(shop: string) {
  await db.aiSearchShop.deleteMany({ where: { shop } });
}

async function runScenario(scenario: (typeof SCENARIOS)[number]) {
  const now = new Date();
  const futureEnd = new Date(now.getTime() + 60 * 60 * 1000);
  try {
    await cleanup(scenario.shop);
    console.log("\n========================================");
    console.log(`[SIMULATION] ${scenario.id}`);
    console.log(`description: ${scenario.description}`);
    console.log(`input: ${scenario.input}`);

    const before = await getBillingSubscriptionSnapshot(scenario.shop);
    logBlock("[BEFORE]", before);

    if (scenario.id === "S15") {
      console.log("[PROCESS]");
      console.log("step: Shopify PENDING -> real billing reconciliation");
      await reconcileShopifySubscriptionFromAdmin({
        shop: scenario.shop, admin: simulatedAdmin(scenario, "PENDING", futureEnd),
        expectedSubscriptionGid: scenario.gid, preferredPlanHandle: "basic",
        source: "RECONCILIATION", observedShopifyStatus: "PENDING",
      });
    } else if (scenario.id === "S16") {
      console.log("[PROCESS]");
      console.log("step: Shopify ACTIVE paid -> real billing reconciliation");
      await reconcileShopifySubscriptionFromAdmin({
        shop: scenario.shop, admin: simulatedAdmin(scenario, "ACTIVE", futureEnd),
        expectedSubscriptionGid: scenario.gid, preferredPlanHandle: "basic",
        source: "RECONCILIATION", observedShopifyStatus: "ACTIVE",
      });
    } else if (scenario.id === "S17") {
      console.log("[PROCESS]");
      console.log("step: setup ACTIVE paid");
      await reconcileShopifySubscriptionFromAdmin({
        shop: scenario.shop, admin: simulatedAdmin(scenario, "ACTIVE", futureEnd),
        expectedSubscriptionGid: scenario.gid, preferredPlanHandle: "basic",
        source: "RECONCILIATION", observedShopifyStatus: "ACTIVE",
      });
      console.log("[PROCESS]");
      console.log("step: Shopify FROZEN / payment failure");
      await reconcileShopifySubscriptionFromAdmin({
        shop: scenario.shop, admin: simulatedAdmin(scenario, "FROZEN", futureEnd),
        expectedSubscriptionGid: scenario.gid, preferredPlanHandle: "basic",
        source: "RECONCILIATION", observedShopifyStatus: "FROZEN",
      });
    } else {
      console.log("[PROCESS]");
      console.log("step: setup ACTIVE paid -> FROZEN / payment failure");
      await reconcileShopifySubscriptionFromAdmin({
        shop: scenario.shop, admin: simulatedAdmin(scenario, "ACTIVE", futureEnd),
        expectedSubscriptionGid: scenario.gid, preferredPlanHandle: "basic",
        source: "RECONCILIATION", observedShopifyStatus: "ACTIVE",
      });
      await reconcileShopifySubscriptionFromAdmin({
        shop: scenario.shop, admin: simulatedAdmin(scenario, "FROZEN", futureEnd),
        expectedSubscriptionGid: scenario.gid, preferredPlanHandle: "basic",
        source: "RECONCILIATION", observedShopifyStatus: "FROZEN",
      });
      console.log("[PROCESS]");
      console.log("step: Shopify ACTIVE / payment recovered");
      await reconcileShopifySubscriptionFromAdmin({
        shop: scenario.shop, admin: simulatedAdmin(scenario, "ACTIVE", futureEnd),
        expectedSubscriptionGid: scenario.gid, preferredPlanHandle: "basic",
        source: "RECONCILIATION", observedShopifyStatus: "ACTIVE",
      });
    }

    await ensureBillingV2State(scenario.shop);
    const snapshot = await getBillingSubscriptionSnapshot(scenario.shop);
    const entitlement = await getShopEntitlement(scenario.shop);
    const row = await db.billingSubscription.findUnique({ where: { shopifySubscriptionGid: scenario.gid } });
    const contract = await emitBillingBackendContract({
      shop: scenario.shop, source: "RECONCILIATION",
      eventType: scenario.id === "S15" ? "PLAN_CHANGE_REQUESTED" : scenario.id === "S17" ? "PAYMENT_FAILED" : scenario.id === "S18" ? "PAYMENT_RECOVERED" : "SUBSCRIPTION_ACTIVATED",
      eventPayload: { scenarioId: scenario.id, subscriptionGid: scenario.gid },
    });
    const events = await db.billingEvent.findMany({
      where: { shop: scenario.shop },
      orderBy: { occurredAt: "asc" },
      select: { type: true, source: true, subscriptionGid: true, idempotencyKey: true },
    });
    const types = new Set(events.map(e => e.type));

    const expected = scenario.id === "S15"
      ? { status: "PENDING", charge: "PENDING", payment: "PENDING", access: "NONE", commercial: "PENDING", active: false, search: false }
      : scenario.id === "S17"
        ? { status: "FROZEN", charge: "FAILED", payment: "FAILED", access: "SUSPENDED", commercial: "FROZEN", active: false, search: false }
        : { status: "ACTIVE", charge: "PENDING", payment: "PENDING", access: "BASIC", commercial: "PAID", active: true, search: true };

    const assertions = {
      dbStatus: row?.status === expected.status,
      chargeStatus: row?.chargeStatus === expected.charge,
      paymentStatus: row?.paymentStatus === expected.payment,
      accessStatus: snapshot.accessStatus === expected.access,
      commercialStatus: snapshot.commercialStatus === expected.commercial,
      entitlementActive: entitlement.active === expected.active,
      searchAllowed: entitlement.searchAllowed === expected.search,
      contractAccess: contract.current.accessStatus === expected.access,
      billingReconciled: types.has("BILLING_RECONCILED"),
      paymentEvent: scenario.id === "S15"
        ? !types.has("PAYMENT_FAILED") && !types.has("PAYMENT_RECOVERED")
        : scenario.id === "S17"
          ? types.has("PAYMENT_FAILED")
          : scenario.id === "S18"
            ? types.has("PAYMENT_RECOVERED")
            : !types.has("PAYMENT_FAILED"),
      eventKeysUnique: new Set(events.map(e => e.idempotencyKey)).size === events.length,
    };

    logBlock("[AFTER]", {
      snapshotStatus: snapshot.status,
      plan: snapshot.plan,
      chargeStatus: snapshot.chargeStatus,
      paymentStatus: snapshot.paymentStatus,
      accessStatus: snapshot.accessStatus,
      commercialStatus: snapshot.commercialStatus,
      entitlementActive: entitlement.active,
      searchAllowed: entitlement.searchAllowed,
      contractCurrent: contract.current,
      dbStatus: row?.status ?? null,
    });
    logBlock("[EVENTS]", events);
    logBlock("[ASSERTIONS]", assertions);

    for (const [name, passed] of Object.entries(assertions)) assert.equal(passed, true, `${scenario.id} ${name} failed`);
    console.log(`[RESULT] ${scenario.id} PASS`);
    return { scenarioId: scenario.id, passed: true };
  } catch (error) {
    console.error(`[RESULT] ${scenario.id} FAIL`, error instanceof Error ? error.message : error);
    return { scenarioId: scenario.id, passed: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    await cleanup(scenario.shop);
  }
}

async function main() {
  console.log("========================================");
  console.log("[BILLING SIMULATION BATCH]");
  console.log("batch: S15-S18");
  console.log("mode: parallel isolated scenarios");
  console.log("database: BILLING_SIMULATION_DATABASE_URL");
  console.log("production database is never used by this runner");
  console.log("========================================");

  const results = await Promise.all(SCENARIOS.map(runScenario));
  const passed = results.filter(r => r.passed).length;
  const failed = results.length - passed;
  logBlock("[BATCH RESULT]", { batch: "S15-S18", total: results.length, passed, failed, results });
  if (failed > 0) throw new Error(`S15-S18 batch failed: ${failed} scenario(s) failed.`);
  console.log("[BATCH RESULT] PASS");
}

await main();
