import assert from "node:assert/strict";

const simulationDatabaseUrl = process.env.BILLING_SIMULATION_DATABASE_URL?.trim();
const productionDatabaseUrl = process.env.DATABASE_URL?.trim();

if (!simulationDatabaseUrl) throw new Error("S19-S23 BLOCKED: BILLING_SIMULATION_DATABASE_URL is required.");
if (productionDatabaseUrl && simulationDatabaseUrl === productionDatabaseUrl) {
  throw new Error("S19-S23 BLOCKED: BILLING_SIMULATION_DATABASE_URL must differ from DATABASE_URL.");
}

process.env.DATABASE_URL = simulationDatabaseUrl;
process.env.NODE_ENV = "test";

const { default: db } = await import("../app/db.server");
const { reconcileShopifySubscriptionFromAdmin } = await import("../app/services/billing/shopify-app-pricing.server");
const {
  ensureBillingV2State,
  getBillingSubscriptionSnapshot,
  emitBillingBackendContract,
  setBillingPlanChangeState,
} = await import("../app/services/commerce/billing-state.server");
const { getShopEntitlement } = await import("../app/services/commerce/entitlement.server");

type Status = "PENDING" | "ACTIVE" | "DECLINED" | "EXPIRED";
type ScenarioId = "S19" | "S20" | "S21" | "S22" | "S23";

const SCENARIOS = [
  { id: "S19" as const, shop: "billing-simulation-s19.myshopify.com", currentGid: "gid://shopify/AppSubscription/simulation-s19-current", replacementGid: "gid://shopify/AppSubscription/simulation-s19-replacement", input: "BASIC ACTIVE -> PRO PENDING -> DECLINED", description: "Replacement is declined; the existing current subscription keeps entitlement." },
  { id: "S20" as const, shop: "billing-simulation-s20.myshopify.com", currentGid: "gid://shopify/AppSubscription/simulation-s20-current", replacementGid: "gid://shopify/AppSubscription/simulation-s20-replacement", input: "BASIC ACTIVE -> PRO PENDING -> EXPIRED", description: "Replacement approval expires; the existing current subscription keeps entitlement." },
  { id: "S21" as const, shop: "billing-simulation-s21.myshopify.com", currentGid: "gid://shopify/AppSubscription/simulation-s21-current", replacementGid: "gid://shopify/AppSubscription/simulation-s21-replacement", input: "BASIC ACTIVE + PRO PENDING -> DEFERRED", description: "A deferred plan change is recorded while current entitlement remains on the old plan." },
  { id: "S22" as const, shop: "billing-simulation-s22.myshopify.com", currentGid: "gid://shopify/AppSubscription/simulation-s22-current", replacementGid: "gid://shopify/AppSubscription/simulation-s22-replacement", input: "ACTIVE subscription with unknown Shopify plan handle", description: "An unconfigured plan handle must not silently become a paid entitlement." },
  { id: "S23" as const, shop: "billing-simulation-s23.myshopify.com", currentGid: "gid://shopify/AppSubscription/simulation-s23-current", replacementGid: "gid://shopify/AppSubscription/simulation-s23-replacement", input: "ACTIVE subscription with missing plan handle", description: "A malformed subscription without a plan handle must be rejected without corrupting existing billing state." },
];

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

function simulatedAdmin(
  scenario: (typeof SCENARIOS)[number],
  gid: string,
  status: Status,
  planHandle: string | null,
  periodEnd: Date,
) {
  const now = new Date();
  return {
    graphql: async (query: string) => {
      if (query.includes("AiSearchShopIdentity")) {
        return jsonResponse({ data: { shop: { id: `gid://shopify/Shop/${scenario.id.toLowerCase()}`, myshopifyDomain: scenario.shop } } });
      }
      if (query.includes("GetCurrentAppSubscriptions")) {
        const subscription = {
          id: gid,
          name: `Simulation ${scenario.id}`,
          status,
          createdAt: now.toISOString(),
          updatedAt: new Date().toISOString(),
          currentPeriodEnd: periodEnd.toISOString(),
          trialDays: 0,
          test: true,
          lineItems: planHandle === null ? [] : [{
            id: `gid://shopify/AppSubscriptionLineItem/${scenario.id.toLowerCase()}`,
            plan: { pricingDetails: {
              __typename: "AppRecurringPricing",
              planHandle,
              interval: "EVERY_30_DAYS",
              price: { amount: planHandle === "pro" ? "29.90" : "9.90", currencyCode: "USD" },
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

    let expectedError = false;

    if (scenario.id === "S19" || scenario.id === "S20") {
      console.log("[PROCESS]");
      console.log("step: establish current BASIC subscription");
      await reconcileShopifySubscriptionFromAdmin({
        shop: scenario.shop,
        admin: simulatedAdmin(scenario, scenario.currentGid, "ACTIVE", "basic", futureEnd),
        expectedSubscriptionGid: scenario.currentGid,
        preferredPlanHandle: "basic",
        source: "RECONCILIATION",
        observedShopifyStatus: "ACTIVE",
      });

      console.log("[PROCESS]");
      console.log("step: establish PRO replacement as PENDING");
      await reconcileShopifySubscriptionFromAdmin({
        shop: scenario.shop,
        admin: simulatedAdmin(scenario, scenario.replacementGid, "PENDING", "pro", futureEnd),
        expectedSubscriptionGid: scenario.replacementGid,
        preferredPlanHandle: "pro",
        source: "RECONCILIATION",
        observedShopifyStatus: "PENDING",
      });

      console.log("[PROCESS]");
      console.log(`step: replacement becomes ${scenario.id === "S19" ? "DECLINED" : "EXPIRED"}`);
      await reconcileShopifySubscriptionFromAdmin({
        shop: scenario.shop,
        admin: simulatedAdmin(
          scenario,
          scenario.replacementGid,
          scenario.id === "S19" ? "DECLINED" : "EXPIRED",
          "pro",
          futureEnd,
        ),
        expectedSubscriptionGid: scenario.replacementGid,
        preferredPlanHandle: "pro",
        source: "RECONCILIATION",
        observedShopifyStatus: scenario.id === "S19" ? "DECLINED" : "EXPIRED",
      });
    } else if (scenario.id === "S21") {
      console.log("[PROCESS]");
      console.log("step: establish current BASIC subscription");
      await reconcileShopifySubscriptionFromAdmin({
        shop: scenario.shop,
        admin: simulatedAdmin(scenario, scenario.currentGid, "ACTIVE", "basic", futureEnd),
        expectedSubscriptionGid: scenario.currentGid,
        preferredPlanHandle: "basic",
        source: "RECONCILIATION",
        observedShopifyStatus: "ACTIVE",
      });

      console.log("[PROCESS]");
      console.log("step: establish PRO replacement as PENDING");
      await reconcileShopifySubscriptionFromAdmin({
        shop: scenario.shop,
        admin: simulatedAdmin(scenario, scenario.replacementGid, "PENDING", "pro", futureEnd),
        expectedSubscriptionGid: scenario.replacementGid,
        preferredPlanHandle: "pro",
        source: "RECONCILIATION",
        observedShopifyStatus: "PENDING",
      });

      console.log("[PROCESS]");
      console.log("step: mark plan change DEFERRED through real Billing state service");
      await setBillingPlanChangeState({
        shop: scenario.shop,
        subscriptionGid: scenario.currentGid,
        status: "DEFERRED",
        source: "API",
        reason: "effective-next-billing-period",
      });
    } else {
      console.log("[PROCESS]");
      console.log(`step: reconcile malformed Shopify plan (${scenario.id === "S22" ? "unknown" : "missing"})`);
      try {
        await reconcileShopifySubscriptionFromAdmin({
          shop: scenario.shop,
          admin: simulatedAdmin(
            scenario,
            scenario.currentGid,
            "ACTIVE",
            scenario.id === "S22" ? "enterprise_plus" : null,
            futureEnd,
          ),
          expectedSubscriptionGid: scenario.currentGid,
          preferredPlanHandle: null,
          source: "RECONCILIATION",
          observedShopifyStatus: "ACTIVE",
        });
      } catch (error) {
        expectedError = true;
        console.log(`[EXPECTED ERROR] ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    await ensureBillingV2State(scenario.shop);
    const snapshot = await getBillingSubscriptionSnapshot(scenario.shop);
    const entitlement = await getShopEntitlement(scenario.shop);
    const currentRow = await db.billingSubscription.findUnique({ where: { shopifySubscriptionGid: scenario.currentGid } });
    const replacementRow = await db.billingSubscription.findUnique({ where: { shopifySubscriptionGid: scenario.replacementGid } });
    const contract = await emitBillingBackendContract({
      shop: scenario.shop,
      source: "RECONCILIATION",
      eventType: "BILLING_RECONCILED",
      eventPayload: { scenarioId: scenario.id },
    });
    const events = await db.billingEvent.findMany({
      where: { shop: scenario.shop },
      orderBy: { occurredAt: "asc" },
      select: { type: true, source: true, subscriptionGid: true, idempotencyKey: true },
    });
    const types = new Set(events.map((event) => event.type));

    const assertions =
      scenario.id === "S19"
        ? {
            currentPlanPreserved: snapshot.plan === "BASIC",
            currentGidPreserved: snapshot.shopifySubscriptionId === scenario.currentGid,
            replacementDeclined: replacementRow?.status === "DECLINED",
            planChangeEvent: types.has("PLAN_CHANGE_DECLINED"),
            entitlementActive: entitlement.active === true,
            searchAllowed: entitlement.searchAllowed === true,
          }
        : scenario.id === "S20"
          ? {
              currentPlanPreserved: snapshot.plan === "BASIC",
              currentGidPreserved: snapshot.shopifySubscriptionId === scenario.currentGid,
              replacementExpired: replacementRow?.status === "EXPIRED",
              planChangeEvent: types.has("PLAN_CHANGE_EXPIRED"),
              entitlementActive: entitlement.active === true,
              searchAllowed: entitlement.searchAllowed === true,
            }
          : scenario.id === "S21"
            ? {
                currentPlanPreserved: snapshot.plan === "BASIC",
                currentGidPreserved: snapshot.shopifySubscriptionId === scenario.currentGid,
                planChangeDeferred: snapshot.planChangeStatus === "DEFERRED",
                deferredEvent: types.has("PLAN_CHANGE_DEFERRED"),
                entitlementActive: entitlement.active === true,
                searchAllowed: entitlement.searchAllowed === true,
                pendingReplacementPreserved: (await db.aiSearchShop.findUnique({ where: { shop: scenario.shop }, select: { pendingSubscriptionGid: true } }))?.pendingSubscriptionGid === scenario.replacementGid,
              }
            : {
                expectedError,
                currentRecordAbsent: currentRow === null,
                currentPlanInactive: snapshot.status === "INACTIVE",
                entitlementInactive: entitlement.active === false,
                searchBlocked: entitlement.searchAllowed === false,
                noPaidAccessEvent: !types.has("PLAN_CHANGE_APPLIED"),
                contractInactive: contract.current.status === "INACTIVE",
              };

    logBlock("[AFTER]", {
      snapshotStatus: snapshot.status,
      plan: snapshot.plan,
      planHandle: snapshot.planHandle,
      planChangeStatus: snapshot.planChangeStatus,
      accessStatus: snapshot.accessStatus,
      commercialStatus: snapshot.commercialStatus,
      entitlementActive: entitlement.active,
      searchAllowed: entitlement.searchAllowed,
      currentRowStatus: currentRow?.status ?? null,
      replacementRowStatus: replacementRow?.status ?? null,
      contractCurrent: contract.current,
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
  console.log("batch: S19-S23");
  console.log("mode: parallel isolated scenarios");
  console.log("database: BILLING_SIMULATION_DATABASE_URL");
  console.log("production database is never used by this runner");
  console.log("========================================");

  const results = await Promise.all(SCENARIOS.map(runScenario));
  const passed = results.filter((result) => result.passed).length;
  const failed = results.length - passed;
  logBlock("[BATCH RESULT]", { batch: "S19-S23", total: results.length, passed, failed, results });
  if (failed > 0) throw new Error(`S19-S23 batch failed: ${failed} scenario(s) failed.`);
  console.log("[BATCH RESULT] PASS");
}

await main();
