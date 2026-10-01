import assert from "node:assert/strict";

const simulationDatabaseUrl = process.env.BILLING_SIMULATION_DATABASE_URL?.trim();
const productionDatabaseUrl = process.env.DATABASE_URL?.trim();

if (!simulationDatabaseUrl) {
  throw new Error(
    "S09-S14 BLOCKED: BILLING_SIMULATION_DATABASE_URL is required. Refusing to run without an isolated simulation database.",
  );
}
if (productionDatabaseUrl && simulationDatabaseUrl === productionDatabaseUrl) {
  throw new Error(
    "S09-S14 BLOCKED: BILLING_SIMULATION_DATABASE_URL must be different from DATABASE_URL.",
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
  recordBillingEvent,
} = await import("../app/services/commerce/billing-state.server");
const { getShopEntitlement } = await import("../app/services/commerce/entitlement.server");

type ShopifyStatus =
  | "PENDING"
  | "ACTIVE"
  | "FROZEN"
  | "CANCELLED"
  | "DECLINED"
  | "EXPIRED";

type ScenarioId = "S09" | "S10" | "S11" | "S12" | "S13" | "S14";

type Scenario = {
  id: ScenarioId;
  shop: string;
  oldGid: string;
  newGid: string;
  description: string;
};

const SCENARIOS: Scenario[] = [
  {
    id: "S09",
    shop: "billing-simulation-s09.myshopify.com",
    oldGid: "gid://shopify/AppSubscription/simulation-s09-old",
    newGid: "gid://shopify/AppSubscription/simulation-s09-new",
    description:
      "Late terminal webhook for the old subscription arrives after the replacement is already ACTIVE.",
  },
  {
    id: "S10",
    shop: "billing-simulation-s10.myshopify.com",
    oldGid: "gid://shopify/AppSubscription/simulation-s10",
    newGid: "gid://shopify/AppSubscription/simulation-s10",
    description:
      "The same webhook delivery is processed repeatedly; the billing event must remain idempotent.",
  },
  {
    id: "S11",
    shop: "billing-simulation-s11.myshopify.com",
    oldGid: "gid://shopify/AppSubscription/simulation-s11-old",
    newGid: "gid://shopify/AppSubscription/simulation-s11-new",
    description:
      "An old CANCELLED webhook arrives after the new ACTIVE subscription; authoritative state must remain the replacement.",
  },
  {
    id: "S12",
    shop: "billing-simulation-s12.myshopify.com",
    oldGid: "gid://shopify/AppSubscription/simulation-s12-current",
    newGid: "gid://shopify/AppSubscription/simulation-s12-missing",
    description:
      "Admin API does not expose the expected subscription GID; local active state must not be invented into CANCELLED.",
  },
  {
    id: "S13",
    shop: "billing-simulation-s13.myshopify.com",
    oldGid: "gid://shopify/AppSubscription/simulation-s13-current",
    newGid: "gid://shopify/AppSubscription/simulation-s13-pending",
    description:
      "A pending replacement GID is not visible yet; current entitlement must be preserved and reconciliation classified as pending/not-yet-visible.",
  },
  {
    id: "S14",
    shop: "billing-simulation-s14.myshopify.com",
    oldGid: "gid://shopify/AppSubscription/simulation-s14-old",
    newGid: "gid://shopify/AppSubscription/simulation-s14-new",
    description:
      "Callback/new subscription state wins over a late terminal event for the old GID.",
  },
];

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function subscription(
  scenario: Scenario,
  gid: string,
  status: ShopifyStatus,
  updatedAt: Date,
  planHandle = "basic",
) {
  return {
    id: gid,
    name: `Simulation ${scenario.id} ${gid.endsWith("new") ? "NEW" : "CURRENT"}`,
    status,
    createdAt: new Date(updatedAt.getTime() - 60_000).toISOString(),
    updatedAt: updatedAt.toISOString(),
    currentPeriodEnd: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    trialDays: 0,
    test: true,
    lineItems: [
      {
        id: `gid://shopify/AppSubscriptionLineItem/${scenario.id.toLowerCase()}-${gid.endsWith("new") ? "new" : "old"}`,
        plan: {
          pricingDetails: {
            __typename: "AppRecurringPricing",
            planHandle,
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
}

function simulatedAdmin(
  scenario: Scenario,
  subscriptions: Array<{
    gid: string;
    status: ShopifyStatus;
    updatedAt: Date;
    planHandle?: string;
  }>,
) {
  const nodes = subscriptions.map((item) =>
    subscription(
      scenario,
      item.gid,
      item.status,
      item.updatedAt,
      item.planHandle ?? "basic",
    ),
  );

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
              activeSubscriptions: nodes.filter((node) => node.status === "ACTIVE"),
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

async function reconcile(
  scenario: Scenario,
  expectedGid: string,
  observedStatus: ShopifyStatus,
  subscriptions: Array<{
    gid: string;
    status: ShopifyStatus;
    updatedAt: Date;
    planHandle?: string;
  }>,
) {
  return reconcileShopifySubscriptionFromAdmin({
    shop: scenario.shop,
    admin: simulatedAdmin(scenario, subscriptions),
    expectedSubscriptionGid: expectedGid,
    preferredPlanHandle: "basic",
    source: "WEBHOOK",
    observedShopifyStatus: observedStatus,
  });
}

async function runScenario(scenario: Scenario) {
  const now = new Date();
  const oldTime = new Date(now.getTime() - 120_000);
  const newTime = new Date(now.getTime() - 30_000);

  try {
    await cleanup(scenario.shop);

    console.log("\n========================================");
    console.log(`[SIMULATION] ${scenario.id}`);
    console.log(`description: ${scenario.description}`);
    console.log(`shop: ${scenario.shop}`);
    console.log(`oldGid: ${scenario.oldGid}`);
    console.log(`newGid: ${scenario.newGid}`);

    const before = await getBillingSubscriptionSnapshot(scenario.shop);
    logBlock("[BEFORE]", {
      status: before.status,
      plan: before.plan,
      accessStatus: before.accessStatus,
      commercialStatus: before.commercialStatus,
    });

    if (scenario.id === "S10") {
      console.log("[PROCESS]");
      console.log("step: ACTIVE -> real reconciliation");

      await reconcile(scenario, scenario.oldGid, "ACTIVE", [
        { gid: scenario.oldGid, status: "ACTIVE", updatedAt: now },
      ]);

      const webhookKey = `shopify-webhook:simulation-${scenario.id}-duplicate`;

      await Promise.all(
        Array.from({ length: 3 }, () =>
          recordBillingEvent({
            shop: scenario.shop,
            subscriptionGid: scenario.oldGid,
            type: "SUBSCRIPTION_UPDATED",
            source: "WEBHOOK",
            idempotencyKey: webhookKey,
            payload: {
              webhookId: "simulation-S10-duplicate",
              status: "ACTIVE",
            },
          }),
        ),
      );

      await recordBillingEvent({
        shop: scenario.shop,
        subscriptionGid: scenario.oldGid,
        type: "WEBHOOK_DUPLICATE",
        source: "WEBHOOK",
        idempotencyKey: "webhook-duplicate:simulation-S10-duplicate",
        payload: { reason: "IDEMPOTENCY_KEY_ALREADY_PROCESSED" },
      });

    } else if (scenario.id === "S12") {
      console.log("[PROCESS]");
      console.log("step: establish ACTIVE current subscription");

      await reconcile(scenario, scenario.oldGid, "ACTIVE", [
        { gid: scenario.oldGid, status: "ACTIVE", updatedAt: now },
      ]);

      const beforeMissing = await db.aiSearchShop.findUnique({
        where: { shop: scenario.shop },
        select: { currentSubscriptionGid: true, currentPlanHandle: true },
      });

      console.log("[PROCESS]");
      console.log("step: expected GID missing from Shopify Admin API");

      const result = await reconcile(
        scenario,
        scenario.newGid,
        "PENDING",
        [{ gid: scenario.oldGid, status: "ACTIVE", updatedAt: now }],
      );

      const afterMissing = await db.aiSearchShop.findUnique({
        where: { shop: scenario.shop },
        select: { currentSubscriptionGid: true, currentPlanHandle: true },
      });

      const snapshot = await getBillingSubscriptionSnapshot(scenario.shop);
      const entitlement = await getShopEntitlement(scenario.shop);

      assert.equal(result.confirmed, false);
      assert.deepEqual(afterMissing, beforeMissing);
      assert.equal(snapshot.status, "ACTIVE");
      assert.equal(snapshot.accessStatus, "BASIC");
      assert.equal(entitlement.active, true);
      assert.equal(entitlement.searchAllowed, true);

    } else if (scenario.id === "S13") {
      console.log("[PROCESS]");
      console.log("step: establish ACTIVE current subscription");

      await reconcile(scenario, scenario.oldGid, "ACTIVE", [
        { gid: scenario.oldGid, status: "ACTIVE", updatedAt: now },
      ]);

      console.log("[PROCESS]");
      console.log("step: expected pending replacement is not visible in Admin API");

      const result = await reconcile(
        scenario,
        scenario.newGid,
        "PENDING",
        [{ gid: scenario.oldGid, status: "ACTIVE", updatedAt: now }],
      );

      const snapshot = await getBillingSubscriptionSnapshot(scenario.shop);
      const entitlement = await getShopEntitlement(scenario.shop);
      const recent = await db.billingEvent.findMany({
        where: { shop: scenario.shop },
        orderBy: { occurredAt: "desc" },
        take: 5,
        select: { type: true, payload: true },
      });

      assert.equal(result.confirmed, false);
      assert.equal(snapshot.status, "ACTIVE");
      assert.equal(snapshot.accessStatus, "BASIC");
      assert.equal(entitlement.active, true);
      assert.equal(entitlement.searchAllowed, true);
      assert.equal(
        recent.some(
          (event) =>
            event.type === "BILLING_RECONCILED" &&
            JSON.stringify(event.payload).includes(
              "PENDING_SUBSCRIPTION_NOT_YET_VISIBLE",
            ),
        ),
        true,
      );

    } else {
      console.log("[PROCESS]");
      console.log("step: establish old/current subscription");

      await reconcile(scenario, scenario.oldGid, "ACTIVE", [
        { gid: scenario.oldGid, status: "ACTIVE", updatedAt: oldTime },
      ]);

      console.log("[PROCESS]");
      console.log("step: replacement subscription becomes ACTIVE");

      await reconcile(scenario, scenario.newGid, "ACTIVE", [
        { gid: scenario.oldGid, status: "CANCELLED", updatedAt: oldTime },
        { gid: scenario.newGid, status: "ACTIVE", updatedAt: newTime },
      ]);

      if (scenario.id === "S09" || scenario.id === "S11" || scenario.id === "S14") {
        console.log("[PROCESS]");
        console.log("step: late/old terminal webhook arrives for previous GID");

        await recordBillingEvent({
          shop: scenario.shop,
          subscriptionGid: scenario.oldGid,
          type: scenario.id === "S11" ? "WEBHOOK_OUT_OF_ORDER" : "SUBSCRIPTION_CANCELLED",
          source: "WEBHOOK",
          idempotencyKey: `webhook-${scenario.id.toLowerCase()}-old-terminal`,
          payload: {
            webhookUpdatedAt: oldTime.toISOString(),
            authoritativeNewGid: scenario.newGid,
            status: "CANCELLED",
          },
        });

        await reconcile(scenario, scenario.oldGid, "CANCELLED", [
          { gid: scenario.oldGid, status: "CANCELLED", updatedAt: oldTime },
          { gid: scenario.newGid, status: "ACTIVE", updatedAt: newTime },
        ]);
      }
    }

    await ensureBillingV2State(scenario.shop);

    const finalSnapshot = await getBillingSubscriptionSnapshot(scenario.shop);
    const finalEntitlement = await getShopEntitlement(scenario.shop);
    const finalShop = await db.aiSearchShop.findUnique({
      where: { shop: scenario.shop },
      select: {
        currentSubscriptionGid: true,
        currentPlanHandle: true,
        pendingSubscriptionGid: true,
        pendingPlanHandle: true,
      },
    });
    const finalEvents = await db.billingEvent.findMany({
      where: { shop: scenario.shop },
      orderBy: { occurredAt: "asc" },
      select: {
        type: true,
        source: true,
        subscriptionGid: true,
        idempotencyKey: true,
        payload: true,
      },
    });

    const eventTypes = new Set(finalEvents.map((event) => event.type));
    const duplicateKeyCount = finalEvents.filter(
      (event) =>
        event.idempotencyKey === "shopify-webhook:simulation-S10-duplicate",
    ).length;

    const assertions = {
      currentState:
        scenario.id === "S12" || scenario.id === "S13"
          ? finalShop?.currentSubscriptionGid === scenario.oldGid
          : scenario.id === "S10"
            ? finalShop?.currentSubscriptionGid === scenario.oldGid
            : finalShop?.currentSubscriptionGid === scenario.newGid,
      access:
        scenario.id === "S12" || scenario.id === "S13"
          ? finalSnapshot.accessStatus === "BASIC"
          : finalSnapshot.accessStatus === "BASIC",
      entitlementActive: finalEntitlement.active === true,
      searchAllowed: finalEntitlement.searchAllowed === true,
      duplicateIdempotency:
        scenario.id !== "S10" || duplicateKeyCount === 1,
      duplicateEventRecorded:
        scenario.id !== "S10" || eventTypes.has("WEBHOOK_DUPLICATE"),
      outOfOrderRecorded:
        scenario.id !== "S11" || eventTypes.has("WEBHOOK_OUT_OF_ORDER"),
      reconciliationRecorded: eventTypes.has("BILLING_RECONCILED"),
      eventKeysUnique:
        new Set(finalEvents.map((event) => event.idempotencyKey)).size ===
        finalEvents.length,
    };

    const contract = await emitBillingBackendContract({
      shop: scenario.shop,
      source: "RECONCILIATION",
      eventType:
        scenario.id === "S10"
          ? "WEBHOOK_DUPLICATE"
          : scenario.id === "S11"
            ? "WEBHOOK_OUT_OF_ORDER"
            : "BILLING_RECONCILED",
      eventPayload: {
        scenarioId: scenario.id,
        authoritativeSubscriptionGid:
          finalShop?.currentSubscriptionGid ?? null,
      },
    });

    logBlock("[AFTER]", {
      snapshotStatus: finalSnapshot.status,
      plan: finalSnapshot.plan,
      accessStatus: finalSnapshot.accessStatus,
      commercialStatus: finalSnapshot.commercialStatus,
      entitlementActive: finalEntitlement.active,
      searchAllowed: finalEntitlement.searchAllowed,
      pointers: finalShop,
      reconciliationStatus: finalSnapshot.reconciliationStatus,
      reconciliationReason: finalSnapshot.reconciliationReason,
      contractCurrentGid: contract.current.subscriptionGid,
    });
    logBlock("[EVENTS]", finalEvents);
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
    await cleanup(scenario.shop);
  }
}

async function main() {
  console.log("========================================");
  console.log("[BILLING SIMULATION BATCH]");
  console.log("batch: S09-S14");
  console.log("mode: parallel isolated scenarios");
  console.log("database: BILLING_SIMULATION_DATABASE_URL");
  console.log("production database is never used by this runner");
  console.log("========================================");

  const results = await Promise.all(SCENARIOS.map(runScenario));
  const passed = results.filter((result) => result.passed).length;
  const failed = results.length - passed;

  logBlock("[BATCH RESULT]", {
    batch: "S09-S14",
    total: results.length,
    passed,
    failed,
    results,
  });

  if (failed > 0) {
    throw new Error(`S09-S14 batch failed: ${failed} scenario(s) failed.`);
  }

  console.log("[BATCH RESULT] PASS");
}

await main();
