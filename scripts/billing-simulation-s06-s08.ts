import assert from "node:assert/strict";

const simulationDatabaseUrl = process.env.BILLING_SIMULATION_DATABASE_URL?.trim();
const productionDatabaseUrl = process.env.DATABASE_URL?.trim();

if (!simulationDatabaseUrl) {
  throw new Error(
    "S06-S08 BLOCKED: BILLING_SIMULATION_DATABASE_URL is required. Refusing to run without an isolated simulation database.",
  );
}

if (productionDatabaseUrl && simulationDatabaseUrl === productionDatabaseUrl) {
  throw new Error(
    "S06-S08 BLOCKED: BILLING_SIMULATION_DATABASE_URL must be different from DATABASE_URL.",
  );
}

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

type ScenarioId = "S06" | "S07" | "S08";
type Status = "ACTIVE" | "CANCELLED";

type Scenario = {
  id: ScenarioId;
  shop: string;
  gid: string;
  description: string;
};

const SCENARIOS: Scenario[] = [
  {
    id: "S06",
    shop: "billing-simulation-s06.myshopify.com",
    gid: "gid://shopify/AppSubscription/simulation-s06",
    description: "ACTIVE trial reaches its trial end while the subscription remains ACTIVE.",
  },
  {
    id: "S07",
    shop: "billing-simulation-s07.myshopify.com",
    gid: "gid://shopify/AppSubscription/simulation-s07",
    description: "ACTIVE trial is cancelled before the trial end; access must be removed.",
  },
  {
    id: "S08",
    shop: "billing-simulation-s08.myshopify.com",
    gid: "gid://shopify/AppSubscription/simulation-s08",
    description: "Shopify extends an ACTIVE trial by moving trial end later.",
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
  status: Status,
  createdAt: Date,
  currentPeriodEnd: Date,
  trialDays: number,
) {
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
          createdAt: createdAt.toISOString(),
          updatedAt: new Date().toISOString(),
          currentPeriodEnd: currentPeriodEnd.toISOString(),
          trialDays,
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

      throw new Error(`${scenario.id} mock received an unexpected GraphQL query.`);
    },
  };
}

function logBlock(label: string, value: unknown) {
  console.log(label);
  console.log(JSON.stringify(value, null, 2));
}

async function cleanupScenario(shop: string) {
  await db.aiSearchShop.deleteMany({ where: { shop } });
}

async function reconcile(
  scenario: Scenario,
  status: Status,
  createdAt: Date,
  currentPeriodEnd: Date,
  trialDays: number,
) {
  return reconcileShopifySubscriptionFromAdmin({
    shop: scenario.shop,
    admin: simulatedAdmin(
      scenario,
      status,
      createdAt,
      currentPeriodEnd,
      trialDays,
    ),
    expectedSubscriptionGid: scenario.gid,
    preferredPlanHandle: "basic",
    source: "RECONCILIATION",
    observedShopifyStatus: status,
  });
}

async function runScenario(scenario: Scenario) {
  const now = new Date();
  const futurePeriodEnd = new Date(now.getTime() + 60 * 60 * 1000);
  const futureTrialEnd = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const originalCreatedAt = new Date(now.getTime());

  try {
    await cleanupScenario(scenario.shop);

    console.log("\n========================================");
    console.log(`[SIMULATION] ${scenario.id}`);
    console.log(`description: ${scenario.description}`);
    console.log(`shop: ${scenario.shop}`);
    console.log(`subscriptionGid: ${scenario.gid}`);

    const before = await getBillingSubscriptionSnapshot(scenario.shop);
    logBlock("[BEFORE]", {
      status: before.status,
      trialStatus: before.trialStatus,
      trialStartsAt: before.trialStartsAt,
      trialEndsAt: before.trialEndsAt,
      accessStatus: before.accessStatus,
      commercialStatus: before.commercialStatus,
    });

    if (scenario.id === "S06") {
      console.log("[PROCESS]");
      console.log("step: ACTIVE + trial -> real billing reconciliation");

      await reconcile(
        scenario,
        "ACTIVE",
        originalCreatedAt,
        futurePeriodEnd,
        1,
      );

      const trialActive = await getBillingSubscriptionSnapshot(scenario.shop);
      const trialEntitlement = await getShopEntitlement(scenario.shop);

      assert.equal(trialActive.status, "ACTIVE");
      assert.equal(trialActive.trialStatus, "ACTIVE");
      assert.equal(trialActive.commercialStatus, "TRIAL");
      assert.equal(trialActive.accessStatus, "BASIC");
      assert.equal(trialEntitlement.active, true);
      assert.equal(trialEntitlement.searchAllowed, true);

      logBlock("[AFTER TRIAL ACTIVE]", {
        status: trialActive.status,
        trialStatus: trialActive.trialStatus,
        trialStartsAt: trialActive.trialStartsAt,
        trialEndsAt: trialActive.trialEndsAt,
        accessStatus: trialActive.accessStatus,
        commercialStatus: trialActive.commercialStatus,
      });

      console.log("[PROCESS]");
      console.log("step: advance cached trialEndsAt beyond now");

      await db.billingSubscription.update({
        where: { shopifySubscriptionGid: scenario.gid },
        data: { trialEndsAt: new Date(now.getTime() - 60 * 1000) },
      });

      await reconcile(
        scenario,
        "ACTIVE",
        originalCreatedAt,
        futurePeriodEnd,
        0,
      );
      await ensureBillingV2State(scenario.shop);

    } else if (scenario.id === "S07") {
      console.log("[PROCESS]");
      console.log("step: ACTIVE + trial -> real billing reconciliation");

      await reconcile(
        scenario,
        "ACTIVE",
        originalCreatedAt,
        futurePeriodEnd,
        3,
      );

      const trialActive = await getBillingSubscriptionSnapshot(scenario.shop);
      assert.equal(trialActive.trialStatus, "ACTIVE");

      console.log("[PROCESS]");
      console.log("step: CANCELLED during trial -> effective cancellation reconciliation");

      await reconcile(
        scenario,
        "CANCELLED",
        originalCreatedAt,
        new Date(now.getTime() - 60 * 1000),
        3,
      );
      await ensureBillingV2State(scenario.shop);

    } else {
      console.log("[PROCESS]");
      console.log("step: ACTIVE + short trial -> real billing reconciliation");

      await reconcile(
        scenario,
        "ACTIVE",
        originalCreatedAt,
        futurePeriodEnd,
        1,
      );

      const beforeExtension = await getBillingSubscriptionSnapshot(scenario.shop);
      assert.equal(beforeExtension.trialStatus, "ACTIVE");

      console.log("[PROCESS]");
      console.log("step: Shopify extends trial from 1 day to 3 days");

      await reconcile(
        scenario,
        "ACTIVE",
        originalCreatedAt,
        futurePeriodEnd,
        3,
      );
      await ensureBillingV2State(scenario.shop);
    }

    const finalSnapshot = await getBillingSubscriptionSnapshot(scenario.shop);
    const finalEntitlement = await getShopEntitlement(scenario.shop);
    const finalRow = await db.billingSubscription.findUnique({
      where: { shopifySubscriptionGid: scenario.gid },
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

    const finalContract = await emitBillingBackendContract({
      shop: scenario.shop,
      source: "RECONCILIATION",
      eventType:
        scenario.id === "S06"
          ? "TRIAL_ENDED"
          : scenario.id === "S07"
            ? "TRIAL_CANCELLED"
            : "TRIAL_EXTENDED",
      eventPayload: {
        scenarioId: scenario.id,
        subscriptionGid: scenario.gid,
      },
    });

    const eventTypes = new Set(events.map((event) => event.type));
    const assertions = {
      db: {
        subscriptionStatus:
          finalRow?.status ===
          (scenario.id === "S07" ? "CANCELLED" : "ACTIVE"),
        trialStatus:
          finalRow?.trialStatus ===
          (scenario.id === "S06"
            ? "ENDED"
            : scenario.id === "S07"
              ? "CANCELLED"
              : "ACTIVE"),
      },
      access: {
        accessStatus:
          finalSnapshot.accessStatus ===
          (scenario.id === "S07" ? "NONE" : "BASIC"),
        commercialStatus:
          finalSnapshot.commercialStatus ===
          (scenario.id === "S06"
            ? "PAID"
            : scenario.id === "S07"
              ? "INACTIVE"
              : "TRIAL"),
        entitlementActive:
          finalEntitlement.active === (scenario.id !== "S07"),
        searchAllowed:
          finalEntitlement.searchAllowed === (scenario.id !== "S07"),
      },
      contract: {
        currentAccessExpected:
          finalContract.current.accessStatus ===
          (scenario.id === "S07" ? "NONE" : "BASIC"),
        currentTrialStatus:
          finalContract.current.trialStatus ===
          (scenario.id === "S06"
            ? "ENDED"
            : scenario.id === "S07"
              ? "NONE"
              : "ACTIVE"),
      },
      event: {
        lifecycleEvent:
          scenario.id === "S06"
            ? eventTypes.has("TRIAL_ENDED")
            : scenario.id === "S07"
              ? eventTypes.has("TRIAL_CANCELLED")
              : eventTypes.has("TRIAL_EXTENDED"),
        reconciled: eventTypes.has("BILLING_RECONCILED"),
      },
      idempotency: {
        eventKeysUnique:
          new Set(events.map((event) => event.idempotencyKey)).size ===
          events.length,
      },
    };

    logBlock("[AFTER]", {
      subscriptionStatus: finalRow?.status ?? null,
      snapshotStatus: finalSnapshot.status,
      trialStatus: finalSnapshot.trialStatus,
      trialStartsAt: finalSnapshot.trialStartsAt,
      trialEndsAt: finalSnapshot.trialEndsAt,
      accessStatus: finalSnapshot.accessStatus,
      commercialStatus: finalSnapshot.commercialStatus,
      entitlementActive: finalEntitlement.active,
      searchAllowed: finalEntitlement.searchAllowed,
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
  console.log("batch: S06-S08");
  console.log("mode: parallel isolated scenarios");
  console.log("database: BILLING_SIMULATION_DATABASE_URL");
  console.log("production database is never used by this runner");
  console.log("========================================");

  const results = await Promise.all(SCENARIOS.map(runScenario));
  const passed = results.filter((result) => result.passed).length;
  const failed = results.length - passed;

  logBlock("[BATCH RESULT]", {
    batch: "S06-S08",
    total: results.length,
    passed,
    failed,
    results,
  });

  if (failed > 0) {
    throw new Error(`S06-S08 batch failed: ${failed} scenario(s) failed.`);
  }

  console.log("[BATCH RESULT] PASS");
}

await main();
