import assert from "node:assert/strict";

const simulationDatabaseUrl = process.env.BILLING_SIMULATION_DATABASE_URL?.trim();
const productionDatabaseUrl = process.env.DATABASE_URL?.trim();

if (!simulationDatabaseUrl) {
  throw new Error(
    "S01 BLOCKED: BILLING_SIMULATION_DATABASE_URL is required. Refusing to run against the application's normal DATABASE_URL.",
  );
}

if (productionDatabaseUrl && simulationDatabaseUrl === productionDatabaseUrl) {
  throw new Error(
    "S01 BLOCKED: BILLING_SIMULATION_DATABASE_URL must be different from DATABASE_URL.",
  );
}

// Set the isolated datasource before importing any app service. db.server.ts
// creates PrismaClient at module evaluation time.
process.env.DATABASE_URL = simulationDatabaseUrl;
process.env.NODE_ENV = "test";

const { default: db } = await import("../app/db.server.ts");
const {
  reconcileShopifySubscriptionFromAdmin,
} = await import("../app/services/billing/shopify-app-pricing.server.ts");
const {
  ensureBillingV2State,
  getBillingSubscriptionSnapshot,
  emitBillingBackendContract,
} = await import("../app/services/commerce/billing-state.server.ts");
const { getShopEntitlement } = await import("../app/services/commerce/entitlement.server.ts");

const SHOP = "billing-simulation-s01.myshopify.com";
const GID = "gid://shopify/AppSubscription/simulation-s01";
const NOW = new Date();
const FUTURE_END = new Date(NOW.getTime() + 60 * 60 * 1000);
const PAST_END = new Date(NOW.getTime() - 60 * 1000);

type SimulatedSubscriptionStatus =
  | "ACTIVE"
  | "CANCELLED";

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function simulatedAdmin(status: SimulatedSubscriptionStatus, periodEnd: Date) {
  return {
    graphql: async (query: string) => {
      if (query.includes("AiSearchShopIdentity")) {
        return jsonResponse({
          data: {
            shop: {
              id: "gid://shopify/Shop/simulation-s01",
              myshopifyDomain: SHOP,
            },
          },
        });
      }

      if (query.includes("GetCurrentAppSubscriptions")) {
        const subscription = {
          id: GID,
          name: "Simulation Basic",
          status,
          createdAt: NOW.toISOString(),
          updatedAt: new Date().toISOString(),
          currentPeriodEnd: periodEnd.toISOString(),
          trialDays: 0,
          test: true,
          lineItems: [
            {
              id: "gid://shopify/AppSubscriptionLineItem/simulation-s01",
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

      throw new Error("S01 mock received an unexpected GraphQL query.");
    },
  };
}

function logBlock(label: string, value: unknown) {
  console.log(label);
  console.log(JSON.stringify(value, null, 2));
}

async function cleanup() {
  // AiSearchShop owns the billing relations with ON DELETE CASCADE.
  await db.aiSearchShop.deleteMany({ where: { shop: SHOP } });
}

async function main() {
  await cleanup();

  console.log("[SIMULATION]");
  console.log("scenarioId: S01");
  console.log("input: NON_RENEWING -> EFFECTIVE -> NONE");
  console.log("shop:", SHOP);
  console.log("subscriptionGid:", GID);

  try {
    const before = await getBillingSubscriptionSnapshot(SHOP);
    logBlock("[BEFORE]", {
      currentPlan: before.plan,
      currentGid: before.shopifySubscriptionId,
      accessStatus: before.accessStatus,
      commercialStatus: before.commercialStatus,
      cancellationStatus: before.cancellationStatus,
    });

    console.log("[PROCESS]");
    console.log("step: Shopify ACTIVE -> real billing reconciliation");

    const activeResult = await reconcileShopifySubscriptionFromAdmin({
      shop: SHOP,
      admin: simulatedAdmin("ACTIVE", FUTURE_END),
      expectedSubscriptionGid: GID,
      preferredPlanHandle: "basic",
      source: "RECONCILIATION",
      observedShopifyStatus: "ACTIVE",
    });

    const activeSnapshot = await getBillingSubscriptionSnapshot(SHOP);
    const activeEntitlement = await getShopEntitlement(SHOP);

    assert.equal(activeSnapshot.status, "ACTIVE");
    assert.equal(activeSnapshot.plan, "basic");
    assert.equal(activeSnapshot.accessStatus, "BASIC");
    assert.equal(activeSnapshot.commercialStatus, "PAID");
    assert.equal(activeSnapshot.cancellationStatus, "NONE");
    assert.equal(activeEntitlement.active, true);
    assert.equal(activeEntitlement.searchAllowed, true);

    logBlock("[AFTER ACTIVE]", {
      currentPlan: activeSnapshot.plan,
      currentGid: activeSnapshot.shopifySubscriptionId,
      subscriptionStatus: activeSnapshot.status,
      accessStatus: activeSnapshot.accessStatus,
      commercialStatus: activeSnapshot.commercialStatus,
      cancellationStatus: activeSnapshot.cancellationStatus,
    });

    console.log("[PROCESS]");
    console.log("step: Shopify CANCELLED before period end -> real billing reconciliation");

    const cancelledResult = await reconcileShopifySubscriptionFromAdmin({
      shop: SHOP,
      admin: simulatedAdmin("CANCELLED", FUTURE_END),
      expectedSubscriptionGid: GID,
      preferredPlanHandle: "basic",
      source: "RECONCILIATION",
      observedShopifyStatus: "CANCELLED",
    });

    const cancelledSnapshot = await getBillingSubscriptionSnapshot(SHOP);
    const cancelledEntitlement = await getShopEntitlement(SHOP);

    assert.equal(cancelledSnapshot.status, "CANCELLED");
    assert.equal(cancelledSnapshot.cancellationStatus, "NON_RENEWING");
    assert.equal(cancelledSnapshot.accessStatus, "BASIC");
    assert.equal(cancelledSnapshot.commercialStatus, "PAID");
    assert.equal(cancelledEntitlement.active, true);
    assert.equal(cancelledEntitlement.searchAllowed, true);

    logBlock("[AFTER NON_RENEWING]", {
      currentPlan: cancelledSnapshot.plan,
      currentGid: cancelledSnapshot.shopifySubscriptionId,
      subscriptionStatus: cancelledSnapshot.status,
      accessStatus: cancelledSnapshot.accessStatus,
      commercialStatus: cancelledSnapshot.commercialStatus,
      cancellationStatus: cancelledSnapshot.cancellationStatus,
      billingPeriodEnd: cancelledSnapshot.billingPeriodEnd,
    });

    console.log("[PROCESS]");
    console.log("step: advance cached billingPeriodEnd beyond now");
    await db.billingSubscription.update({
      where: { shopifySubscriptionGid: GID },
      data: {
        currentPeriodEndsAt: PAST_END,
      },
    });

    console.log("step: real Billing V2 state engine resolves expired NON_RENEWING window");
    await ensureBillingV2State(SHOP);

    const finalSnapshot = await getBillingSubscriptionSnapshot(SHOP);
    const finalEntitlement = await getShopEntitlement(SHOP);
    const finalRow = await db.billingSubscription.findUnique({
      where: { shopifySubscriptionGid: GID },
    });
    const shopRow = await db.aiSearchShop.findUnique({
      where: { shop: SHOP },
      select: {
        currentSubscriptionGid: true,
        currentPlanHandle: true,
      },
    });
    const events = await db.billingEvent.findMany({
      where: { shop: SHOP },
      orderBy: { occurredAt: "asc" },
      select: {
        type: true,
        source: true,
        subscriptionGid: true,
        idempotencyKey: true,
      },
    });

    const finalContract = await emitBillingBackendContract({
      shop: SHOP,
      source: "RECONCILIATION",
      eventType: "CANCELLATION_EFFECTIVE",
      eventPayload: {
        scenarioId: "S01",
        subscriptionGid: GID,
      },
    });

    logBlock("[AFTER]", {
      currentPlan: finalSnapshot.plan,
      currentGid: finalSnapshot.shopifySubscriptionId,
      subscriptionStatus: finalRow?.status ?? null,
      snapshotStatus: finalSnapshot.status,
      trialStatus: finalSnapshot.trialStatus,
      chargeStatus: finalSnapshot.chargeStatus,
      paymentStatus: finalSnapshot.paymentStatus,
      accessStatus: finalSnapshot.accessStatus,
      commercialStatus: finalSnapshot.commercialStatus,
      cancellationStatus: finalSnapshot.cancellationStatus,
      reconciliationStatus: finalSnapshot.reconciliationStatus,
      currentPointer: shopRow,
    });

    logBlock("[EVENTS]", events);

    const eventTypes = new Set(events.map((event) => event.type));
    const assertions = {
      db: {
        finalSubscriptionStatus: finalRow?.status === "CANCELLED",
        finalCancellationStatus: finalRow?.cancellationStatus === "EFFECTIVE",
        currentPointerCleared: shopRow?.currentSubscriptionGid === null,
      },
      access: {
        accessRemoved: finalSnapshot.accessStatus === "NONE",
        entitlementInactive: finalEntitlement.active === false,
        searchBlocked: finalEntitlement.searchAllowed === false,
      },
      contract: {
        versionPresent: Boolean(finalContract.contractVersion),
        currentAccessNone: finalContract.current.accessStatus === "NONE",
        currentCommercialInactive:
          finalContract.current.commercialStatus === "INACTIVE",
      },
      event: {
        cancelled: eventTypes.has("SUBSCRIPTION_CANCELLED"),
        cancellationEffective: eventTypes.has("CANCELLATION_EFFECTIVE"),
        reconciled: eventTypes.has("BILLING_RECONCILED"),
      },
      idempotency: {
        eventKeysUnique:
          new Set(events.map((event) => event.idempotencyKey)).size === events.length,
      },
    };

    logBlock("[ASSERTIONS]", assertions);

    for (const [group, values] of Object.entries(assertions)) {
      for (const [name, passed] of Object.entries(values)) {
        assert.equal(passed, true, `${group}.${name} failed`);
      }
    }

    assert.equal(cancelledResult.backendContract.current.accessStatus, "BASIC");
    assert.equal(activeResult.backendContract.current.accessStatus, "BASIC");

    console.log("[RESULT]");
    console.log("PASS");
  } finally {
    await cleanup();
    await db.$disconnect();
  }
}

await main();
