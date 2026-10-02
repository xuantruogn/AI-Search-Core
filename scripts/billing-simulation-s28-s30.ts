import assert from "node:assert/strict";

const simulationDatabaseUrl = process.env.BILLING_SIMULATION_DATABASE_URL?.trim();
const productionDatabaseUrl = process.env.DATABASE_URL?.trim();

if (!simulationDatabaseUrl) {
  throw new Error("S28-S30 BLOCKED: BILLING_SIMULATION_DATABASE_URL is required.");
}
if (productionDatabaseUrl && simulationDatabaseUrl === productionDatabaseUrl) {
  throw new Error("S28-S30 BLOCKED: BILLING_SIMULATION_DATABASE_URL must differ from DATABASE_URL.");
}

process.env.DATABASE_URL = simulationDatabaseUrl;
process.env.NODE_ENV = "test";

const { default: db } = await import("../app/db.server");
const { reconcileShopifySubscriptionFromAdmin } = await import("../app/services/billing/shopify-app-pricing.server");
const {
  ensureBillingV2State,
  getBillingSubscriptionSnapshot,
  emitBillingBackendContract,
} = await import("../app/services/commerce/billing-state.server");
const { getShopEntitlement } = await import("../app/services/commerce/entitlement.server");

type Scenario = {
  id: "S28" | "S29" | "S30";
  shop: string;
  gid: string;
  description: string;
  periodEndOffsetMs: number;
};

const SCENARIOS: Scenario[] = [
  {
    id: "S28",
    shop: "billing-simulation-s28.myshopify.com",
    gid: "gid://shopify/AppSubscription/simulation-s28",
    description: "CANCELLED + NON_RENEWING remains entitled before billingPeriodEnd.",
    periodEndOffsetMs: 60 * 60 * 1000,
  },
  {
    id: "S29",
    shop: "billing-simulation-s29.myshopify.com",
    gid: "gid://shopify/AppSubscription/simulation-s29",
    description: "CANCELLED crosses billingPeriodEnd and becomes EFFECTIVE with access removed.",
    periodEndOffsetMs: -60 * 1000,
  },
  {
    id: "S30",
    shop: "billing-simulation-s30.myshopify.com",
    gid: "gid://shopify/AppSubscription/simulation-s30",
    description: "Repeated reconciliation after effective cancellation is stable and idempotent.",
    periodEndOffsetMs: -60 * 1000,
  },
];

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function simulatedAdmin(scenario: Scenario, status: "ACTIVE" | "CANCELLED") {
  const now = new Date();
  const subscription = {
    id: scenario.gid,
    name: `Simulation ${scenario.id}`,
    status,
    createdAt: new Date(now.getTime() - 60 * 60 * 1000).toISOString(),
    updatedAt: now.toISOString(),
    currentPeriodEnd: new Date(now.getTime() + scenario.periodEndOffsetMs).toISOString(),
    trialDays: 0,
    test: true,
    lineItems: [{
      id: `gid://shopify/AppSubscriptionLineItem/${scenario.id.toLowerCase()}`,
      plan: {
        pricingDetails: {
          __typename: "AppRecurringPricing",
          planHandle: "basic",
          interval: "EVERY_30_DAYS",
          price: { amount: "9.90", currencyCode: "USD" },
        },
      },
    }],
  };

  return {
    graphql: async (query: string) => {
      if (query.includes("AiSearchShopIdentity")) {
        return jsonResponse({
          data: {
            shop: {
              id: `gid://shopify/Shop/${scenario.id.toLowerCase()}`,
              myshopifyDomain: scenario.shop,
            },
          },
        });
      }
      if (query.includes("GetCurrentAppSubscriptions")) {
        return jsonResponse({
          data: {
            currentAppInstallation: {
              activeSubscriptions: status === "ACTIVE" ? [subscription] : [],
              allSubscriptions: { nodes: [subscription], pageInfo: { hasNextPage: false, endCursor: null } },
            },
          },
        });
      }
      throw new Error(`${scenario.id} mock received unexpected GraphQL query.`);
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

async function runScenario(scenario: Scenario) {
  try {
    await cleanup(scenario.shop);

    console.log("\n========================================");
    console.log(`[SIMULATION] ${scenario.id}`);
    console.log(`description: ${scenario.description}`);

    const before = await getBillingSubscriptionSnapshot(scenario.shop);
    logBlock("[BEFORE]", before);

    console.log("[PROCESS]");
    console.log("step: establish ACTIVE subscription");
    await reconcileShopifySubscriptionFromAdmin({
      shop: scenario.shop,
      admin: simulatedAdmin(scenario, "ACTIVE"),
      expectedSubscriptionGid: scenario.gid,
      preferredPlanHandle: "basic",
      source: "RECONCILIATION",
      observedShopifyStatus: "ACTIVE",
    });

    console.log("[PROCESS]");
    console.log("step: reconcile Shopify CANCELLED state with controlled billingPeriodEnd");
    await reconcileShopifySubscriptionFromAdmin({
      shop: scenario.shop,
      admin: simulatedAdmin(scenario, "CANCELLED"),
      expectedSubscriptionGid: scenario.gid,
      preferredPlanHandle: "basic",
      source: "RECONCILIATION",
      observedShopifyStatus: "CANCELLED",
    });
    await ensureBillingV2State(scenario.shop);

    if (scenario.id === "S30") {
      console.log("[PROCESS]");
      console.log("step: repeat the same effective cancellation reconciliation");
      await reconcileShopifySubscriptionFromAdmin({
        shop: scenario.shop,
        admin: simulatedAdmin(scenario, "CANCELLED"),
        expectedSubscriptionGid: scenario.gid,
        preferredPlanHandle: "basic",
        source: "RECONCILIATION",
        observedShopifyStatus: "CANCELLED",
      });
      await ensureBillingV2State(scenario.shop);
    }

    const snapshot = await getBillingSubscriptionSnapshot(scenario.shop);
    const entitlement = await getShopEntitlement(scenario.shop);
    const row = await db.billingSubscription.findUnique({
      where: { shopifySubscriptionGid: scenario.gid },
      select: {
        status: true,
        cancellationStatus: true,
        accessStatus: true,
        currentPeriodEndsAt: true,
      },
    });
    const shopRow = await db.aiSearchShop.findUnique({
      where: { shop: scenario.shop },
      select: { currentSubscriptionGid: true, currentPlanHandle: true },
    });
    const contract = await emitBillingBackendContract({
      shop: scenario.shop,
      source: "RECONCILIATION",
      eventType: "BILLING_RECONCILED",
      eventPayload: { scenarioId: scenario.id },
    });
    const events = await db.billingEvent.findMany({
      where: { shop: scenario.shop },
      orderBy: { occurredAt: "asc" },
      select: { type: true, idempotencyKey: true, subscriptionGid: true },
    });

    const cancelEvents = events.filter(
      (event) => event.type === "SUBSCRIPTION_CANCELLED",
    );
    const reconciliationKeys = events
      .filter((event) => event.type === "BILLING_RECONCILED")
      .map((event) => event.idempotencyKey);
    const uniqueReconciliationKeys = new Set(reconciliationKeys);

    const assertions =
      scenario.id === "S28"
        ? {
            statusCancelled: row?.status === "CANCELLED",
            cancellationNonRenewing: row?.cancellationStatus === "NON_RENEWING",
            accessPreserved: row?.accessStatus === "BASIC",
            snapshotPaid: snapshot.commercialStatus === "PAID",
            snapshotBasic: snapshot.plan === "BASIC",
            entitlementActive: entitlement.active === true,
            searchAllowed: entitlement.searchAllowed === true,
            periodEndStillFuture: Boolean(row?.currentPeriodEndsAt && row.currentPeriodEndsAt > new Date()),
            currentPointerPreserved: shopRow?.currentSubscriptionGid === scenario.gid,
          }
        : scenario.id === "S29"
          ? {
              statusCancelled: row?.status === "CANCELLED",
              cancellationEffective: row?.cancellationStatus === "EFFECTIVE",
              accessRemoved: row?.accessStatus === "NONE",
              snapshotInactive: snapshot.commercialStatus === "INACTIVE",
              entitlementInactive: entitlement.active === false,
              searchBlocked: entitlement.searchAllowed === false,
              contractInactive: contract.current.status === "INACTIVE",
              currentPointerCleared: shopRow?.currentSubscriptionGid === null,
            }
          : {
              statusCancelled: row?.status === "CANCELLED",
              cancellationEffective: row?.cancellationStatus === "EFFECTIVE",
              accessRemoved: row?.accessStatus === "NONE",
              entitlementInactive: entitlement.active === false,
              searchBlocked: entitlement.searchAllowed === false,
              currentPointerCleared: shopRow?.currentSubscriptionGid === null,
              reconciliationRecorded: reconciliationKeys.length > 0,
              reconciliationKeysUnique: reconciliationKeys.length === uniqueReconciliationKeys.size,
              cancelEventRecorded: cancelEvents.length === 1,
            };

    logBlock("[AFTER]", {
      snapshotStatus: snapshot.status,
      plan: snapshot.plan,
      commercialStatus: snapshot.commercialStatus,
      accessStatus: snapshot.accessStatus,
      cancellationStatus: snapshot.cancellationStatus,
      entitlementActive: entitlement.active,
      searchAllowed: entitlement.searchAllowed,
      shopRow,
      row,
      contractCurrent: contract.current,
    });
    logBlock("[EVENTS]", events);
    logBlock("[ASSERTIONS]", assertions);

    for (const [name, passed] of Object.entries(assertions)) {
      assert.equal(passed, true, `${scenario.id} ${name} failed`);
    }

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
  console.log("batch: S28-S30");
  console.log("mode: parallel isolated scenarios");
  console.log("database: BILLING_SIMULATION_DATABASE_URL");
  console.log("production database is never used by this runner");
  console.log("========================================");

  const results = await Promise.all(SCENARIOS.map(runScenario));
  const passed = results.filter((result) => result.passed).length;
  const failed = results.length - passed;

  logBlock("[BATCH RESULT]", {
    batch: "S28-S30",
    total: results.length,
    passed,
    failed,
    results,
  });

  if (failed > 0) throw new Error(`S28-S30 batch failed: ${failed} scenario(s) failed.`);
  console.log("[BATCH RESULT] PASS");
}

await main();
