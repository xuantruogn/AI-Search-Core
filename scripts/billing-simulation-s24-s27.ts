import assert from "node:assert/strict";

const simulationDatabaseUrl = process.env.BILLING_SIMULATION_DATABASE_URL?.trim();
const productionDatabaseUrl = process.env.DATABASE_URL?.trim();

if (!simulationDatabaseUrl) {
  throw new Error("S24-S27 BLOCKED: BILLING_SIMULATION_DATABASE_URL is required.");
}
if (productionDatabaseUrl && simulationDatabaseUrl === productionDatabaseUrl) {
  throw new Error("S24-S27 BLOCKED: BILLING_SIMULATION_DATABASE_URL must differ from DATABASE_URL.");
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
const {
  ensureShopFromAdmin,
  markShopUninstalled,
  getShopLifecycleStatus,
} = await import("../app/services/commerce/shop-registry.server");
const { getShopEntitlement } = await import("../app/services/commerce/entitlement.server");

type ShopifyStatus = "ACTIVE" | "PENDING";

type Scenario = {
  id: "S24" | "S25" | "S26" | "S27";
  shop: string;
  currentGid: string;
  pendingGid: string;
  description: string;
  reinstallHasSubscription: boolean;
};

const SCENARIOS: Scenario[] = [
  {
    id: "S24",
    shop: "billing-simulation-s24.myshopify.com",
    currentGid: "gid://shopify/AppSubscription/simulation-s24-current",
    pendingGid: "gid://shopify/AppSubscription/simulation-s24-pending",
    description: "APP_UNINSTALLED revokes app access and cancels active billing state.",
    reinstallHasSubscription: false,
  },
  {
    id: "S25",
    shop: "billing-simulation-s25.myshopify.com",
    currentGid: "gid://shopify/AppSubscription/simulation-s25-current",
    pendingGid: "gid://shopify/AppSubscription/simulation-s25-pending",
    description: "APP_UNINSTALLED clears current/pending pointers and prevents stale pending state from surviving.",
    reinstallHasSubscription: false,
  },
  {
    id: "S26",
    shop: "billing-simulation-s26.myshopify.com",
    currentGid: "gid://shopify/AppSubscription/simulation-s26-current",
    pendingGid: "gid://shopify/AppSubscription/simulation-s26-pending",
    description: "APP_REINSTALL reactivates the shop and reconciles an actually ACTIVE Shopify subscription.",
    reinstallHasSubscription: true,
  },
  {
    id: "S27",
    shop: "billing-simulation-s27.myshopify.com",
    currentGid: "gid://shopify/AppSubscription/simulation-s27-current",
    pendingGid: "gid://shopify/AppSubscription/simulation-s27-pending",
    description: "APP_REINSTALL without a Shopify subscription must not revive paid entitlement.",
    reinstallHasSubscription: false,
  },
];

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function simulatedAdmin(
  scenario: Scenario,
  status: ShopifyStatus,
  includeSubscription: boolean,
  subscriptionGid = scenario.currentGid,
) {
  const now = new Date();
  const subscription = {
    id: subscriptionGid,
    name: `Simulation ${scenario.id} current`,
    status,
    createdAt: new Date(now.getTime() - 60_000).toISOString(),
    updatedAt: now.toISOString(),
    currentPeriodEnd: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
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
        const nodes = includeSubscription ? [subscription] : [];
        return jsonResponse({
          data: {
            currentAppInstallation: {
              activeSubscriptions:
                includeSubscription && status === "ACTIVE" ? [subscription] : [],
              allSubscriptions: {
                nodes,
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
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

async function establishInitialState(scenario: Scenario) {
  const now = new Date();
  const futureEnd = new Date(now.getTime() + 60 * 60 * 1000);

  await reconcileShopifySubscriptionFromAdmin({
    shop: scenario.shop,
    admin: simulatedAdmin(scenario, "ACTIVE", true),
    expectedSubscriptionGid: scenario.currentGid,
    preferredPlanHandle: "basic",
    source: "RECONCILIATION",
    observedShopifyStatus: "ACTIVE",
  });

  if (scenario.id === "S25") {
    await reconcileShopifySubscriptionFromAdmin({
      shop: scenario.shop,
      admin: simulatedAdmin(scenario, "PENDING", true, scenario.pendingGid),
      expectedSubscriptionGid: scenario.pendingGid,
      preferredPlanHandle: "basic",
      source: "RECONCILIATION",
      observedShopifyStatus: "PENDING",
    });
  }

  // Keep the explicit period variable in the setup so the scenario remains
  // aligned with a real ACTIVE subscription window.
  void futureEnd;
}

async function runScenario(scenario: Scenario) {
  try {
    await cleanup(scenario.shop);

    console.log("\n========================================");
    console.log(`[SIMULATION] ${scenario.id}`);
    console.log(`description: ${scenario.description}`);
    console.log(`input: APP_UNINSTALLED -> reinstallHasSubscription=${scenario.reinstallHasSubscription}`);

    const before = await getBillingSubscriptionSnapshot(scenario.shop);
    logBlock("[BEFORE]", before);

    console.log("[PROCESS]");
    console.log("step: establish initial ACTIVE billing state");
    await establishInitialState(scenario);

    if (scenario.id === "S24" || scenario.id === "S25") {
      console.log("[PROCESS]");
      console.log("step: process APP_UNINSTALLED through real shop registry service");
      await markShopUninstalled(scenario.shop);

      await ensureBillingV2State(scenario.shop);
    }

    if (scenario.id === "S26" || scenario.id === "S27") {
      console.log("[PROCESS]");
      console.log("step: process APP_UNINSTALLED through real shop registry service");
      await markShopUninstalled(scenario.shop);

      console.log("[PROCESS]");
      console.log("step: process authenticated reinstall through real ensureShopFromAdmin");
      await ensureShopFromAdmin({
        shop: scenario.shop,
        admin: simulatedAdmin(scenario, "ACTIVE", scenario.reinstallHasSubscription),
      });

      if (scenario.reinstallHasSubscription) {
        console.log("[PROCESS]");
        console.log("step: reconcile Shopify ACTIVE subscription after reinstall");
        await reconcileShopifySubscriptionFromAdmin({
          shop: scenario.shop,
          admin: simulatedAdmin(scenario, "ACTIVE", true),
          expectedSubscriptionGid: scenario.currentGid,
          preferredPlanHandle: "basic",
          source: "RECONCILIATION",
          observedShopifyStatus: "ACTIVE",
        });
      }

      await ensureBillingV2State(scenario.shop);
    }

    const lifecycle = await getShopLifecycleStatus(scenario.shop, { ensure: false });
    const snapshot = await getBillingSubscriptionSnapshot(scenario.shop);
    const entitlement = await getShopEntitlement(scenario.shop);
    const shopRow = await db.aiSearchShop.findUnique({
      where: { shop: scenario.shop },
      select: {
        status: true,
        currentSubscriptionGid: true,
        pendingSubscriptionGid: true,
      },
    });
    const currentRow = await db.billingSubscription.findUnique({
      where: { shopifySubscriptionGid: scenario.currentGid },
      select: {
        status: true,
        accessStatus: true,
        cancellationStatus: true,
      },
    });
    const pendingRow = await db.billingSubscription.findUnique({
      where: { shopifySubscriptionGid: scenario.pendingGid },
      select: { status: true },
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
      select: { type: true, source: true, subscriptionGid: true, idempotencyKey: true },
    });
    const types = new Set(events.map((event) => event.type));

    const assertions =
      scenario.id === "S24"
        ? {
            lifecycleUninstalled: lifecycle === "UNINSTALLED",
            currentPointerCleared: shopRow?.currentSubscriptionGid === null,
            pendingPointerCleared: shopRow?.pendingSubscriptionGid === null,
            currentCancelled: currentRow?.status === "CANCELLED",
            currentAccessNone: currentRow?.accessStatus === "NONE",
            currentCancellationEffective: currentRow?.cancellationStatus === "EFFECTIVE",
            entitlementInactive: entitlement.active === false,
            searchBlocked: entitlement.searchAllowed === false,
            uninstallEvent: types.has("APP_UNINSTALLED"),
          }
        : scenario.id === "S25"
          ? {
              lifecycleUninstalled: lifecycle === "UNINSTALLED",
              currentPointerCleared: shopRow?.currentSubscriptionGid === null,
              pendingPointerCleared: shopRow?.pendingSubscriptionGid === null,
              currentCancelled: currentRow?.status === "CANCELLED",
              pendingCancelled: pendingRow?.status === "CANCELLED",
              entitlementInactive: entitlement.active === false,
              searchBlocked: entitlement.searchAllowed === false,
              uninstallEvents: events.filter((event) => event.type === "APP_UNINSTALLED").length >= 2,
            }
          : scenario.id === "S26"
            ? {
                lifecycleActive: lifecycle === "ACTIVE",
                reinstallEvent: types.has("APP_REINSTALLED"),
                currentPointerRestored: shopRow?.currentSubscriptionGid === scenario.currentGid,
                currentActive: currentRow?.status === "ACTIVE",
                snapshotActive: snapshot.status === "ACTIVE",
                entitlementActive: entitlement.active === true,
                searchAllowed: entitlement.searchAllowed === true,
                contractActive: contract.current.status === "ACTIVE",
              }
            : {
                lifecycleActive: lifecycle === "ACTIVE",
                reinstallEvent: types.has("APP_REINSTALLED"),
                noCurrentPointer: shopRow?.currentSubscriptionGid === null,
                snapshotInactive: snapshot.status === "INACTIVE",
                entitlementInactive: entitlement.active === false,
                searchBlocked: entitlement.searchAllowed === false,
                contractInactive: contract.current.status === "INACTIVE",
              };

    logBlock("[AFTER]", {
      lifecycle,
      snapshotStatus: snapshot.status,
      plan: snapshot.plan,
      accessStatus: snapshot.accessStatus,
      commercialStatus: snapshot.commercialStatus,
      entitlementActive: entitlement.active,
      searchAllowed: entitlement.searchAllowed,
      shopRow,
      currentRow,
      pendingRow,
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
  console.log("batch: S24-S27");
  console.log("mode: parallel isolated scenarios");
  console.log("database: BILLING_SIMULATION_DATABASE_URL");
  console.log("production database is never used by this runner");
  console.log("========================================");

  const results = await Promise.all(SCENARIOS.map(runScenario));
  const passed = results.filter((result) => result.passed).length;
  const failed = results.length - passed;
  logBlock("[BATCH RESULT]", {
    batch: "S24-S27",
    total: results.length,
    passed,
    failed,
    results,
  });

  if (failed > 0) throw new Error(`S24-S27 batch failed: ${failed} scenario(s) failed.`);
  console.log("[BATCH RESULT] PASS");
}

await main();
