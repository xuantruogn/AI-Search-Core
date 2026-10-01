import assert from "node:assert/strict";

const simulationDatabaseUrl = process.env.BILLING_SIMULATION_DATABASE_URL?.trim();
const productionDatabaseUrl = process.env.DATABASE_URL?.trim();

if (!simulationDatabaseUrl) {
  throw new Error(
    "S02-S05 BLOCKED: BILLING_SIMULATION_DATABASE_URL is required. Refusing to run without an isolated simulation database.",
  );
}

if (productionDatabaseUrl && simulationDatabaseUrl === productionDatabaseUrl) {
  throw new Error(
    "S02-S05 BLOCKED: BILLING_SIMULATION_DATABASE_URL must be different from DATABASE_URL.",
  );
}

// The four scenarios share one isolated database but never share shop/GID state.
process.env.DATABASE_URL = simulationDatabaseUrl;
process.env.NODE_ENV = "test";

const { default: db } = await import("../app/db.server");
const {
  reconcileShopifySubscriptionFromAdmin,
} = await import("../app/services/billing/shopify-app-pricing.server");
const {
  ensureBillingV2State,
  getBillingSubscriptionSnapshot,
  emitBillingBackendContract,
} = await import("../app/services/commerce/billing-state.server");
const { getShopEntitlement } = await import("../app/services/commerce/entitlement.server");

type SimulatedSubscriptionStatus =
  | "PENDING"
  | "ACTIVE"
  | "FROZEN"
  | "DECLINED"
  | "EXPIRED";

type ScenarioId = "S02" | "S03" | "S04" | "S05";

type ScenarioResult = {
  scenarioId: ScenarioId;
  passed: boolean;
  error?: string;
};

const SCENARIOS = [
  {
    id: "S02" as const,
    shop: "billing-simulation-s02.myshopify.com",
    gid: "gid://shopify/AppSubscription/simulation-s02",
    input: "PENDING -> DECLINED",
    firstStatus: "PENDING" as const,
    secondStatus: "DECLINED" as const,
    description:
      "Merchant creates a new subscription but declines it; the system must never grant entitlement.",
  },
  {
    id: "S03" as const,
    shop: "billing-simulation-s03.myshopify.com",
    gid: "gid://shopify/AppSubscription/simulation-s03",
    input: "PENDING -> EXPIRED",
    firstStatus: "PENDING" as const,
    secondStatus: "EXPIRED" as const,
    description:
      "Merchant has a pending subscription that expires before activation; the system must never grant entitlement.",
  },
  {
    id: "S04" as const,
    shop: "billing-simulation-s04.myshopify.com",
    gid: "gid://shopify/AppSubscription/simulation-s04",
    input: "ACTIVE -> FROZEN",
    firstStatus: "ACTIVE" as const,
    secondStatus: "FROZEN" as const,
    description:
      "An active paid subscription is frozen after a billing/payment problem; access must be suspended.",
  },
  {
    id: "S05" as const,
    shop: "billing-simulation-s05.myshopify.com",
    gid: "gid://shopify/AppSubscription/simulation-s05",
    input: "FROZEN -> ACTIVE",
    firstStatus: "FROZEN" as const,
    secondStatus: "ACTIVE" as const,
    description:
      "A frozen subscription recovers and becomes active again; access must be restored.",
  },
];

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function simulatedAdmin(
  scenario: (typeof SCENARIOS)[number],
  status: SimulatedSubscriptionStatus,
  periodEnd: Date,
) {
  const now = new Date();

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
        const subscription = {
          id: scenario.gid,
          name: `Simulation ${scenario.id}`,
          status,
          createdAt: now.toISOString(),
          updatedAt: new Date().toISOString(),
          currentPeriodEnd: periodEnd.toISOString(),
          trialDays: 0,
          test: true,
          lineItems: [
            {
              id: `gid://shopify/AppSubscriptionLineItem/${scenario.id.toLowerCase()}`,
              plan: {
                pricingDetails: {
                  __typename: "AppRecurringPricing",
                  planHandle: "basic",
                  interval: "EVERY_30_DAYS",
                  price: {
                    amount: "9.90",
                    currencyCode: "USD",
                  },
                },
              },
            },
          ],
        };

        return jsonResponse({
          data: {
            currentAppInstallation: {
              activeSubscriptions: status === "ACTIVE" ? [subscription] : [],
              allSubscriptions: {
                nodes: [subscription],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        });
      }

      throw new Error(
        `${scenario.id} mock received an unexpected GraphQL query.`,
      );
    },
  };
}

function logBlock(label: string, value: unknown) {
  console.log(label);
  console.log(JSON.stringify(value, null, 2));
}

async function cleanupScenario(shop: string) {
  // AiSearchShop owns the billing relations with ON DELETE CASCADE.
  await db.aiSearchShop.deleteMany({ where: { shop } });
}

async function runScenario(scenario: (typeof SCENARIOS)[number]): Promise<ScenarioResult> {
  const now = new Date();
  const futureEnd = new Date(now.getTime() + 60 * 60 * 1000);

  try {
    await cleanupScenario(scenario.shop);

    console.log("\n========================================");
    console.log(`[SIMULATION] ${scenario.id}`);
    console.log(`description: ${scenario.description}`);
    console.log(`input: ${scenario.input}`);
    console.log(`shop: ${scenario.shop}`);
    console.log(`subscriptionGid: ${scenario.gid}`);

    const before = await getBillingSubscriptionSnapshot(scenario.shop);
    logBlock("[BEFORE]", {
      currentPlan: before.plan,
      currentGid: before.shopifySubscriptionId,
      status: before.status,
      accessStatus: before.accessStatus,
      commercialStatus: before.commercialStatus,
      cancellationStatus: before.cancellationStatus,
    });

    if (scenario.id === "S02" || scenario.id === "S03") {
      console.log("[PROCESS]");
      console.log(
        `step: Shopify ${scenario.firstStatus} -> real billing reconciliation`,
      );

      await reconcileShopifySubscriptionFromAdmin({
        shop: scenario.shop,
        admin: simulatedAdmin(scenario, scenario.firstStatus, futureEnd),
        expectedSubscriptionGid: scenario.gid,
        preferredPlanHandle: "basic",
        source: "RECONCILIATION",
        observedShopifyStatus: scenario.firstStatus,
      });

      const pendingSnapshot = await getBillingSubscriptionSnapshot(scenario.shop);
      const pendingEntitlement = await getShopEntitlement(scenario.shop);

      assert.equal(pendingSnapshot.status, "PENDING");
      assert.equal(pendingSnapshot.commercialStatus, "PENDING");
      assert.equal(pendingSnapshot.accessStatus, "NONE");
      assert.equal(pendingEntitlement.active, false);
      assert.equal(pendingEntitlement.searchAllowed, false);

      logBlock("[AFTER PENDING]", {
        currentPlan: pendingSnapshot.plan,
        currentGid: pendingSnapshot.shopifySubscriptionId,
        status: pendingSnapshot.status,
        accessStatus: pendingSnapshot.accessStatus,
        commercialStatus: pendingSnapshot.commercialStatus,
        entitlementActive: pendingEntitlement.active,
        searchAllowed: pendingEntitlement.searchAllowed,
      });

      console.log("[PROCESS]");
      console.log(
        `step: Shopify ${scenario.secondStatus} -> real billing reconciliation`,
      );

      await reconcileShopifySubscriptionFromAdmin({
        shop: scenario.shop,
        admin: simulatedAdmin(scenario, scenario.secondStatus, futureEnd),
        expectedSubscriptionGid: scenario.gid,
        preferredPlanHandle: "basic",
        source: "RECONCILIATION",
        observedShopifyStatus: scenario.secondStatus,
      });

      await ensureBillingV2State(scenario.shop);
    } else if (scenario.id === "S04") {
      console.log("[PROCESS]");
      console.log("step: Shopify ACTIVE -> real billing reconciliation");

      await reconcileShopifySubscriptionFromAdmin({
        shop: scenario.shop,
        admin: simulatedAdmin(scenario, "ACTIVE", futureEnd),
        expectedSubscriptionGid: scenario.gid,
        preferredPlanHandle: "basic",
        source: "RECONCILIATION",
        observedShopifyStatus: "ACTIVE",
      });

      const activeSnapshot = await getBillingSubscriptionSnapshot(scenario.shop);
      const activeEntitlement = await getShopEntitlement(scenario.shop);

      assert.equal(activeSnapshot.status, "ACTIVE");
      assert.equal(activeSnapshot.plan, "BASIC");
      assert.equal(activeSnapshot.accessStatus, "BASIC");
      assert.equal(activeSnapshot.commercialStatus, "PAID");
      assert.equal(activeEntitlement.active, true);
      assert.equal(activeEntitlement.searchAllowed, true);

      logBlock("[AFTER ACTIVE]", {
        currentPlan: activeSnapshot.plan,
        currentGid: activeSnapshot.shopifySubscriptionId,
        status: activeSnapshot.status,
        accessStatus: activeSnapshot.accessStatus,
        commercialStatus: activeSnapshot.commercialStatus,
      });

      console.log("[PROCESS]");
      console.log("step: Shopify FROZEN -> real billing reconciliation");

      await reconcileShopifySubscriptionFromAdmin({
        shop: scenario.shop,
        admin: simulatedAdmin(scenario, "FROZEN", futureEnd),
        expectedSubscriptionGid: scenario.gid,
        preferredPlanHandle: "basic",
        source: "RECONCILIATION",
        observedShopifyStatus: "FROZEN",
      });

      await ensureBillingV2State(scenario.shop);
    } else {
      console.log("[PROCESS]");
      console.log("step: setup ACTIVE -> real billing reconciliation");

      await reconcileShopifySubscriptionFromAdmin({
        shop: scenario.shop,
        admin: simulatedAdmin(scenario, "ACTIVE", futureEnd),
        expectedSubscriptionGid: scenario.gid,
        preferredPlanHandle: "basic",
        source: "RECONCILIATION",
        observedShopifyStatus: "ACTIVE",
      });

      console.log("[PROCESS]");
      console.log("step: setup FROZEN -> real billing reconciliation");

      await reconcileShopifySubscriptionFromAdmin({
        shop: scenario.shop,
        admin: simulatedAdmin(scenario, "FROZEN", futureEnd),
        expectedSubscriptionGid: scenario.gid,
        preferredPlanHandle: "basic",
        source: "RECONCILIATION",
        observedShopifyStatus: "FROZEN",
      });

      const frozenSnapshot = await getBillingSubscriptionSnapshot(scenario.shop);
      const frozenEntitlement = await getShopEntitlement(scenario.shop);

      assert.equal(frozenSnapshot.status, "FROZEN");
      assert.equal(frozenSnapshot.accessStatus, "SUSPENDED");
      assert.equal(frozenSnapshot.commercialStatus, "FROZEN");
      assert.equal(frozenEntitlement.active, false);
      assert.equal(frozenEntitlement.searchAllowed, false);

      logBlock("[AFTER FROZEN SETUP]", {
        currentPlan: frozenSnapshot.plan,
        currentGid: frozenSnapshot.shopifySubscriptionId,
        status: frozenSnapshot.status,
        accessStatus: frozenSnapshot.accessStatus,
        commercialStatus: frozenSnapshot.commercialStatus,
      });

      console.log("[PROCESS]");
      console.log("step: Shopify ACTIVE recovery -> real billing reconciliation");

      await reconcileShopifySubscriptionFromAdmin({
        shop: scenario.shop,
        admin: simulatedAdmin(scenario, "ACTIVE", futureEnd),
        expectedSubscriptionGid: scenario.gid,
        preferredPlanHandle: "basic",
        source: "RECONCILIATION",
        observedShopifyStatus: "ACTIVE",
      });

      await ensureBillingV2State(scenario.shop);
    }

    const finalSnapshot = await getBillingSubscriptionSnapshot(scenario.shop);
    const finalEntitlement = await getShopEntitlement(scenario.shop);
    const finalRow = await db.billingSubscription.findUnique({
      where: { shopifySubscriptionGid: scenario.gid },
    });
    const finalContract = await emitBillingBackendContract({
      shop: scenario.shop,
      source: "RECONCILIATION",
      eventType:
        scenario.id === "S02"
          ? "SUBSCRIPTION_DECLINED"
          : scenario.id === "S03"
            ? "SUBSCRIPTION_EXPIRED"
            : scenario.id === "S04"
              ? "SUBSCRIPTION_FROZEN"
              : "SUBSCRIPTION_UNFROZEN",
      eventPayload: {
        scenarioId: scenario.id,
        subscriptionGid: scenario.gid,
      },
    });
    const shopRow = await db.aiSearchShop.findUnique({
      where: { shop: scenario.shop },
      select: {
        currentSubscriptionGid: true,
        currentPlanHandle: true,
      },
    });
    const events = await db.billingEvent.findMany({
      where: { shop: scenario.shop },
      orderBy: { occurredAt: "asc" },
      select: {
        type: true,
        source: true,
        subscriptionGid: true,
        idempotencyKey: true,
      },
    });

    const eventTypes = new Set(events.map((event) => event.type));
    const isTerminalNoAccess = scenario.id === "S02" || scenario.id === "S03";
    const assertions = {
      db: {
        finalSubscriptionStatus:
          finalRow?.status === scenario.secondStatus,
        finalPlanChangeStatus:
          isTerminalNoAccess
            ? finalSnapshot.planChangeStatus ===
              (scenario.id === "S02" ? "DECLINED" : "EXPIRED")
            : true,
      },
      access: {
        accessExpected:
          isTerminalNoAccess
            ? finalSnapshot.accessStatus === "NONE"
            : scenario.id === "S04"
              ? finalSnapshot.accessStatus === "SUSPENDED"
              : finalSnapshot.accessStatus === "BASIC",
        commercialExpected:
          isTerminalNoAccess
            ? finalSnapshot.commercialStatus === "INACTIVE"
            : scenario.id === "S04"
              ? finalSnapshot.commercialStatus === "FROZEN"
              : finalSnapshot.commercialStatus === "PAID",
        entitlementActive:
          finalEntitlement.active === !isTerminalNoAccess && scenario.id !== "S04",
        searchAllowed:
          finalEntitlement.searchAllowed ===
          (!isTerminalNoAccess && scenario.id !== "S04"),
      },
      contract: {
        currentAccessExpected:
          finalContract.current.accessStatus ===
          (isTerminalNoAccess
            ? "NONE"
            : scenario.id === "S04"
              ? "SUSPENDED"
              : "BASIC"),
      },
      event: {
        lifecycleEvent:
          scenario.id === "S02"
            ? eventTypes.has("SUBSCRIPTION_DECLINED")
            : scenario.id === "S03"
              ? eventTypes.has("SUBSCRIPTION_EXPIRED")
              : scenario.id === "S04"
                ? eventTypes.has("SUBSCRIPTION_FROZEN")
                : eventTypes.has("SUBSCRIPTION_UNFROZEN"),
        paymentEvent:
          scenario.id === "S02" || scenario.id === "S03"
            ? !eventTypes.has("PAYMENT_FAILED")
            : scenario.id === "S04"
              ? eventTypes.has("PAYMENT_FAILED")
              : eventTypes.has("PAYMENT_RECOVERED"),
        reconciled: eventTypes.has("BILLING_RECONCILED"),
      },
      idempotency: {
        eventKeysUnique:
          new Set(events.map((event) => event.idempotencyKey)).size ===
          events.length,
      },
    };

    logBlock("[AFTER]", {
      currentPlan: finalSnapshot.plan,
      currentGid: finalSnapshot.shopifySubscriptionId,
      subscriptionStatus: finalRow?.status ?? null,
      snapshotStatus: finalSnapshot.status,
      planChangeStatus: finalSnapshot.planChangeStatus,
      accessStatus: finalSnapshot.accessStatus,
      commercialStatus: finalSnapshot.commercialStatus,
      entitlementActive: finalEntitlement.active,
      searchAllowed: finalEntitlement.searchAllowed,
      reconciliationStatus: finalSnapshot.reconciliationStatus,
      currentPointer: shopRow,
    });
    logBlock("[EVENTS]", events);
    logBlock("[ASSERTIONS]", assertions);

    for (const [group, values] of Object.entries(assertions)) {
      for (const [name, passed] of Object.entries(values)) {
        assert.equal(passed, true, `${scenario.id} ${group}.${name} failed`);
      }
    }

    console.log(`[RESULT] ${scenario.id} PASS`);
    return { scenarioId: scenario.id, passed: true };
  } catch (error) {
    console.error(
      `[RESULT] ${scenario.id} FAIL`,
      error instanceof Error ? error.message : error,
    );
    return {
      scenarioId: scenario.id,
      passed: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await cleanupScenario(scenario.shop);
  }
}

async function main() {
  console.log("========================================");
  console.log("[BILLING SIMULATION BATCH]");
  console.log("batch: S02-S05");
  console.log("mode: parallel isolated scenarios");
  console.log("database: BILLING_SIMULATION_DATABASE_URL");
  console.log("production database is never used by this runner");
  console.log("========================================");

  const results = await Promise.all(
    SCENARIOS.map((scenario) => runScenario(scenario)),
  );

  const passed = results.filter((result) => result.passed).length;
  const failed = results.length - passed;

  logBlock("[BATCH RESULT]", {
    batch: "S02-S05",
    total: results.length,
    passed,
    failed,
    results,
  });

  if (failed > 0) {
    throw new Error(`S02-S05 batch failed: ${failed} scenario(s) failed.`);
  }

  console.log("[BATCH RESULT] PASS");
}

await main();
