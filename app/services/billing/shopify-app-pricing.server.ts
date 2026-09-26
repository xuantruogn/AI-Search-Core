import db from "../../db.server";
import {
  AI_SEARCH_PLAN,
  hasExplicitDevPlanOverride,
  planFromHandle,
} from "../commerce/plans.server";
import {
  ensureShopRecord,
  fetchShopIdentity,
  getSubscriptionSnapshot,
} from "../commerce/shop-registry.server";
import {
  ensureBillingV2State,
  mirrorBillingStateToLegacy,
  recordBillingEvent,
} from "../commerce/billing-state.server";
import { withDistributedLease } from "../commerce/lease-lock.server";

type AdminGraphqlClient = {
  graphql: (
    query: string,
    options?: {
      variables?: Record<string, unknown>;
    },
  ) => Promise<Response>;
};


type ActiveSubscriptionResponse = {
  data?: {
    activeSubscription?: {
      billingPeriod?: string | null;
      currentBillingCycle?: {
        startTime?: string | null;
        endTime?: string | null;
      } | null;
      trialEndsAt?: string | null;
      legacySubscriptionId?: string | null;
      items?: Array<{
        handle?: string | null;
        description?: string | null;
        price?: {
          active?: boolean | null;
        } | null;
      }>;
    } | null;
  };
  errors?: Array<{
    message?: string;
    extensions?: {
      code?: string;
    };
  }>;
};

type AdminActiveSubscriptionResponse = {
  data?: {
    currentAppInstallation?: {
      activeSubscriptions?: Array<{
        id: string;
        name: string;
        status: string;
        createdAt: string;
        currentPeriodEnd?: string | null;
        trialDays?: number;
        test?: boolean;
        lineItems?: Array<{
          id: string;
          plan?: {
            pricingDetails?: {
              __typename?: string;
              planHandle?: string | null;
              interval?: string | null;
              price?: {
                amount?: string | null;
                currencyCode?: string | null;
              } | null;
            } | null;
          } | null;
        }>;
      }>;
    } | null;
  };
  errors?: Array<{
    message?: string;
  }>;
};


function getPartnerConfig() {
  const organizationId = process.env.SHOPIFY_PARTNER_ORG_ID?.trim();
  const accessToken = process.env.SHOPIFY_PARTNER_API_ACCESS_TOKEN?.trim();
  const appId = process.env.SHOPIFY_APP_GID?.trim();
  const apiVersion =
    process.env.SHOPIFY_PARTNER_API_VERSION?.trim() || "2026-07";

  if (!organizationId || !accessToken || !appId) {
    return null;
  }

  return {
    organizationId,
    accessToken,
    appId,
    apiVersion,
  };
}

export function isShopifyAppPricingConfigured() {
  return getPartnerConfig() !== null;
}

export function getShopifyPricingPlansUrl(shop: string) {
  const appHandle = process.env.SHOPIFY_APP_HANDLE?.trim();

  if (!appHandle) {
    return null;
  }

  const storeHandle = shop.replace(/\.myshopify\.com$/i, "");

  return `https://admin.shopify.com/store/${encodeURIComponent(storeHandle)}/charges/${encodeURIComponent(appHandle)}/pricing_plans`;
}

async function queryActiveSubscription(shopId: string) {
  const config = getPartnerConfig();

  if (!config) {
    return {
      configured: false as const,
      subscription: null,
    };
  }

  const response = await fetch(
    `https://partners.shopify.com/${config.organizationId}/api/${config.apiVersion}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": config.accessToken,
      },
      body: JSON.stringify({
        query: `
          query AiSearchActiveSubscription($appId: ID!, $shopId: ID!) {
            activeSubscription(appId: $appId, shopId: $shopId) {
              billingPeriod
              trialEndsAt
              currentBillingCycle {
                startTime
                endTime
              }
              items {
                handle
                description
                price {
                  __typename
                  active
                  currency
                  ... on FlatRatePrice {
                    amount
                  }
                }
              }
              legacySubscriptionId
            }
          }
        `,
        variables: {
          appId: config.appId,
          shopId,
        },
      }),
    },
  );

  const body = (await response.json()) as ActiveSubscriptionResponse;

  if (!response.ok || body.errors?.length) {
    const message =
      body.errors
        ?.map((error) => error.message)
        .filter(Boolean)
        .join("; ") || `Partner API request failed (${response.status})`;

    throw new Error(message);
  }

  return {
    configured: true as const,
    subscription: body.data?.activeSubscription ?? null,
  };
}

function inferPlan({
  preferredPlanHandle,
  itemHandles,
}: {
  preferredPlanHandle?: string | null;
  itemHandles: string[];
}) {
  // `plan_handle` is browser-controlled and is only a refresh/UI hint. The
  // Partner API active items are canonical. Basic/Pro are mapped explicitly.
  // Any other active handle is treated as CUSTOM only after a matching
  // shop-specific Plan record is found by the Billing V2 resolver.
  const recognized = itemHandles
    .map((handle) => ({ handle, plan: planFromHandle(handle) }))
    .filter((item) => item.plan !== AI_SEARCH_PLAN.none);

  const pro = recognized.find((item) => item.plan === AI_SEARCH_PLAN.pro);
  if (pro) return { plan: pro.plan, planHandle: pro.handle };

  const basic = recognized.find((item) => item.plan === AI_SEARCH_PLAN.basic);
  if (basic) return { plan: basic.plan, planHandle: basic.handle };

  const preferred = preferredPlanHandle?.trim();

if (preferred) {
  const preferredPlan = planFromHandle(preferred);

  if (preferredPlan !== AI_SEARCH_PLAN.none) {
    return {
      plan: preferredPlan,
      planHandle: preferred,
    };
  }
}

return {
  plan: itemHandles.length > 0 ? AI_SEARCH_PLAN.custom : AI_SEARCH_PLAN.none,
  planHandle: itemHandles[0] ?? preferred ?? null,
};
}

function parsePartnerDate(value: string | null | undefined) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

type ReconciledActiveSubscription = NonNullable<
  NonNullable<ActiveSubscriptionResponse["data"]>["activeSubscription"]
>;

async function queryAdminActiveSubscription(
  admin: AdminGraphqlClient,
  expectedSubscriptionGid?: string | null,
) {
  const response = await admin.graphql(
    `#graphql
      query GetCurrentAppActiveSubscriptions {
        currentAppInstallation {
          activeSubscriptions {
            id
            name
            status
            createdAt
            currentPeriodEnd
            trialDays
            test
            lineItems {
              id
              plan {
                pricingDetails {
                  __typename
                  ... on AppRecurringPricing {
                    planHandle
                    interval
                    price {
                      amount
                      currencyCode
                    }
                  }
                }
              }
            }
          }
        }
      }
    `,
  );

  const body =
    (await response.json()) as AdminActiveSubscriptionResponse;

  if (!response.ok || body.errors?.length) {
    const message =
      body.errors
        ?.map((error) => error.message)
        .filter(Boolean)
        .join("; ") ||
      "Shopify Admin API request failed.";

    throw new Error(message);
  }

  const subscriptions =
    body.data?.currentAppInstallation?.activeSubscriptions ?? [];

  const activeSubscriptions = subscriptions.filter(
      (subscription) => subscription.status === "ACTIVE",
    );

    if (expectedSubscriptionGid) {
      return (
        activeSubscriptions.find(
          (subscription) =>
            subscription.id === expectedSubscriptionGid,
        ) ?? null
      );
    }

    return (
      [...activeSubscriptions].sort(
        (a, b) =>
          new Date(b.createdAt).getTime() -
          new Date(a.createdAt).getTime(),
      )[0] ?? null
    );
}



export async function refreshShopifyAppPricingSubscription({
  shop,
  admin,
  preferredPlanHandle,
  adminSubscription,
}: {
  shop: string;
  admin: AdminGraphqlClient;
  preferredPlanHandle?: string | null;
  adminSubscription?: ReconciledActiveSubscription | null;
}) {
  const identity = await fetchShopIdentity(admin);

  await ensureShopRecord({
    shop,
    shopifyShopId: identity.id,
    reactivate: true,
  });

  const before = await getSubscriptionSnapshot(shop);

  const result = adminSubscription
    ? {
        configured: true as const,
        subscription: adminSubscription,
      }
    : await queryActiveSubscription(identity.id);

  if (!result.configured) {
    return {
      configured: false as const,
      subscription: before,
      changed: false,
      previousPlan: before.plan,
      previousStatus: before.status,
    };
  }

  await ensureBillingV2State(shop);

  if (!result.subscription) {
    const active = await db.billingSubscription.findFirst({
      where: {
        shop,
        status: { in: ["ACTIVE", "PENDING", "FROZEN"] },
      },
      orderBy: { updatedAt: "desc" },
    });

    if (active) {
      await db.billingSubscription.update({
        where: { id: active.id },
        data: {
          status: "CANCELLED",
          cancelledAt: new Date(),
        },
      });

      await recordBillingEvent({
        shop,
        subscriptionGid: active.shopifySubscriptionGid,
        type: "SUBSCRIPTION_CANCELLED",
        source: "API",
        idempotencyKey: `subscription-cancelled:${active.shopifySubscriptionGid ?? active.id}`,
        payload: {
          reason: "SHOPIFY_ACTIVE_SUBSCRIPTION_NOT_FOUND",
        },
      });
    }

    await db.$executeRaw`
      UPDATE \`AiSearchShop\`
      SET
        \`currentPlanHandle\` = NULL,
        \`currentSubscriptionGid\` = NULL,
        \`updatedAt\` = UTC_TIMESTAMP(3)
      WHERE \`shop\` = ${shop}
    `;

    const subscription = await getSubscriptionSnapshot(shop);
    await mirrorBillingStateToLegacy(subscription);

    return {
      configured: true as const,
      subscription,
      changed:
        before.plan !== subscription.plan ||
        before.status !== subscription.status,
      previousPlan: before.plan,
      previousStatus: before.status,
    };
  }

  const itemHandles = (result.subscription.items ?? [])
    .filter((item) => item.price?.active === true)
    .map((item) => item.handle?.trim())
    .filter((value): value is string => Boolean(value));

  const inferred = inferPlan({
    preferredPlanHandle,
    itemHandles,
  });

  if (inferred.plan === AI_SEARCH_PLAN.none || !inferred.planHandle) {
    throw new Error(
      "Active Shopify App Pricing subscription has no active pricing item.",
    );
  }

  let plan = null;

  if (
    inferred.plan === AI_SEARCH_PLAN.basic ||
    inferred.plan === AI_SEARCH_PLAN.pro
  ) {
    plan = await db.plan.findUnique({
      where: { handle: inferred.plan.toLowerCase() },
    });
  } else {
    plan = await db.plan.findFirst({
      where: {
        OR: [
          { handle: inferred.planHandle },
          { shopifyPlanHandle: inferred.planHandle },
        ],
      },
    });

    if (!plan) {
      const assignment = await db.planAssignment.findFirst({
        where: {
          shop,
          isActive: true,
          plan: {
            OR: [
              { handle: inferred.planHandle },
              { shopifyPlanHandle: inferred.planHandle },
            ],
          },
        },
        include: { plan: true },
        orderBy: { createdAt: "desc" },
      });
      plan = assignment?.plan ?? null;
    }
  }

  if (!plan) {
    // Unknown Shopify handles are not granted an implicit entitlement. A
    // CUSTOM plan must first exist in Billing V2 and be associated with this
    // shop, so limits are always explicit and auditable.
    await db.$executeRaw`
      UPDATE \`AiSearchShop\`
      SET
        \`currentPlanHandle\` = ${inferred.planHandle},
        \`currentSubscriptionGid\` = ${result.subscription.legacySubscriptionId ?? null},
        \`updatedAt\` = UTC_TIMESTAMP(3)
      WHERE \`shop\` = ${shop}
    `;

    throw new Error(
      `Active Shopify App Pricing plan "${inferred.planHandle}" is not configured in Billing V2. Create/assign its Plan record before activating it.`,
    );
  }

  const start = parsePartnerDate(
    result.subscription.currentBillingCycle?.startTime,
  );
  const end = parsePartnerDate(
    result.subscription.currentBillingCycle?.endTime,
  );
  const gid = result.subscription.legacySubscriptionId ?? null;

  let current = gid
    ? await db.billingSubscription.findUnique({
        where: { shopifySubscriptionGid: gid },
      })
    : null;

  if (!current) {
    current = await db.billingSubscription.findFirst({
      where: {
        shop,
        status: { in: ["ACTIVE", "PENDING", "FROZEN"] },
      },
      orderBy: { updatedAt: "desc" },
    });
  }

  if (current && current.shopifySubscriptionGid !== gid) {
    await db.billingSubscription.update({
      where: { id: current.id },
      data: {
        status: "CANCELLED",
        cancelledAt: new Date(),
      },
    });

    await recordBillingEvent({
      shop,
      subscriptionGid: current.shopifySubscriptionGid,
      type: "SUBSCRIPTION_CANCELLED",
      source: "API",
      idempotencyKey: `subscription-replaced:${current.shopifySubscriptionGid ?? current.id}:${gid ?? "none"}`,
      payload: { replacementSubscriptionGid: gid },
    });

    current = null;
  }

  const data = {
    shop,
    planId: plan.id,
    shopifySubscriptionGid: gid,
    shopifyPlanHandle: inferred.planHandle,
    status: "ACTIVE" as const,
    planNameSnapshot: plan.name,
    priceSnapshot: plan.price,
    currencySnapshot: plan.currencyCode,
    intervalSnapshot: plan.interval,
    trialEndsAt: parsePartnerDate(result.subscription.trialEndsAt),
    currentPeriodStartsAt: start,
    currentPeriodEndsAt: end,
    activatedAt: current?.activatedAt ?? new Date(),
    testMode: process.env.NODE_ENV !== "production",
    rawResponse: result.subscription as unknown as object,
  };

  const subscription = current
    ? await db.billingSubscription.update({
        where: { id: current.id },
        data,
      })
    : await db.billingSubscription.create({ data });

  const eventType =
    before.plan !== (plan.handle === "basic"
      ? AI_SEARCH_PLAN.basic
      : plan.handle === "pro"
        ? AI_SEARCH_PLAN.pro
        : AI_SEARCH_PLAN.custom)
      ? "BILLING_RECONCILED"
      : current
        ? "BILLING_RECONCILED"
        : "SUBSCRIPTION_CREATED";

  await recordBillingEvent({
    shop,
    subscriptionGid: gid,
    type: eventType,
    source: "API",
    idempotencyKey: `billing-reconcile:${gid ?? subscription.id}:${inferred.planHandle}:${start?.toISOString() ?? "none"}:${end?.toISOString() ?? "none"}`,
    payload: {
      planId: plan.id,
      planHandle: inferred.planHandle,
      billingPeriodStart: start?.toISOString() ?? null,
      billingPeriodEnd: end?.toISOString() ?? null,
    },
  });

  await db.$executeRaw`
    UPDATE \`AiSearchShop\`
    SET
      \`currentPlanHandle\` = ${inferred.planHandle},
      \`currentSubscriptionGid\` = ${gid},
      \`pendingPlanHandle\` = NULL,
      \`pendingSubscriptionGid\` = NULL,
      \`pendingChangeAt\` = NULL,
      \`updatedAt\` = UTC_TIMESTAMP(3)
    WHERE \`shop\` = ${shop}
  `;

  const snapshot = await getSubscriptionSnapshot(shop);
  await mirrorBillingStateToLegacy(snapshot);

  return {
    configured: true as const,
    subscription: snapshot,
    changed:
      before.plan !== snapshot.plan ||
      before.status !== snapshot.status ||
      before.planHandle !== snapshot.planHandle ||
      before.shopifySubscriptionId !== snapshot.shopifySubscriptionId,
    previousPlan: before.plan,
    previousStatus: before.status,
  };
}

export async function reconcileShopifySubscriptionFromAdmin({
  shop,
  admin,
  expectedSubscriptionGid,
  preferredPlanHandle,
}: {
  shop: string;
  admin: AdminGraphqlClient;
  expectedSubscriptionGid: string;
  preferredPlanHandle?: string | null;
}) {
  const activeSubscription = await queryAdminActiveSubscription(
    admin,
    expectedSubscriptionGid,
  );

  if (!activeSubscription) {
    console.log("[BILLING] Shopify subscription not ACTIVE yet:", {
      shop,
      expectedSubscriptionGid,
    });

    return {
      configured: true as const,
      confirmed: false as const,
      changed: false,
      subscription: await getSubscriptionSnapshot(shop, {
        ensure: false,
      }),
    };
  }

  console.log("[BILLING] Shopify ACTIVE subscription verified:", {
    shop,
    expectedSubscriptionGid,
    actualSubscriptionGid: activeSubscription.id,
    status: activeSubscription.status,
    name: activeSubscription.name,
  });

  const adminSubscription: ReconciledActiveSubscription = {
    billingPeriod:
      activeSubscription.lineItems?.[0]?.plan?.pricingDetails?.interval ??
      "EVERY_30_DAYS",

    currentBillingCycle: {
      startTime: activeSubscription.createdAt,
      endTime: activeSubscription.currentPeriodEnd ?? null,
    },

    trialEndsAt: null,

    legacySubscriptionId: activeSubscription.id,

    items:
      activeSubscription.lineItems?.map((item) => ({
        handle: item.plan?.pricingDetails?.planHandle ?? null,
        description: activeSubscription.name,
        price: {
          active: true,
          currency:
            item.plan?.pricingDetails?.price?.currencyCode ?? "USD",
          amount:
            item.plan?.pricingDetails?.price?.amount ?? null,
        },
      })) ?? [],
  };

  const result = await refreshShopifyAppPricingSubscription({
    shop,
    admin,
    preferredPlanHandle,
    adminSubscription,
  });

  return {
    ...result,
    configured: true as const,
    confirmed: true as const,
  };
}

export async function refreshShopifyAppPricingIfStale({
  shop,
  admin,
  preferredPlanHandle,
  maxAgeMs = 5 * 60_000,
}: {
  shop: string;
  admin: AdminGraphqlClient;
  preferredPlanHandle?: string | null;
  maxAgeMs?: number;
}) {
  const current = await getSubscriptionSnapshot(shop);

  if (current.source === "DEV_OVERRIDE" && hasExplicitDevPlanOverride()) {
    return {
      configured: false as const,
      subscription: current,
      skipped: true,
      changed: false,
      previousPlan: current.plan,
      previousStatus: current.status,
    };
  }

  if (!isShopifyAppPricingConfigured()) {
    return {
      configured: false as const,
      subscription: current,
      skipped: true,
      changed: false,
      previousPlan: current.plan,
      previousStatus: current.status,
    };
  }

  const isStale = (snapshot: typeof current) =>
    !snapshot.lastSyncedAt ||
    Date.now() - snapshot.lastSyncedAt.getTime() >= maxAgeMs;

  if (!preferredPlanHandle && !isStale(current)) {
    return {
      configured: true as const,
      subscription: current,
      skipped: true,
      changed: false,
      previousPlan: current.plan,
      previousStatus: current.status,
    };
  }

  // Storefront traffic can create many concurrent requests at the exact cache
  // boundary. Serialize Partner API refreshes per shop, then re-check staleness
  // after acquiring the lease so only one request pays the external API call.
  return withDistributedLease({
    shop,
    resource: "billing:refresh",
    leaseMs: 30_000,
    waitTimeoutMs: 10_000,
    pollMs: 100,
    task: async () => {
      const latest = await getSubscriptionSnapshot(shop);
      if (!preferredPlanHandle && !isStale(latest)) {
        return {
          configured: true as const,
          subscription: latest,
          skipped: true,
          changed: false,
          previousPlan: latest.plan,
          previousStatus: latest.status,
        };
      }

      const refreshed = await refreshShopifyAppPricingSubscription({
        shop,
        admin,
        preferredPlanHandle,
      });

      return {
        ...refreshed,
        skipped: false,
      };
    },
  });
}
