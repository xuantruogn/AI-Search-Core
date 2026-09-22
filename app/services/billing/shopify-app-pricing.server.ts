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
  // Partner API active items are canonical. If a transition briefly exposes
  // more than one recognized item, grant the highest verified tier rather
  // than depending on provider array order or a user-editable query string.
  const recognized = itemHandles
    .map((handle) => ({ handle, plan: planFromHandle(handle) }))
    .filter((item) => item.plan !== AI_SEARCH_PLAN.none);

  const pro = recognized.find((item) => item.plan === AI_SEARCH_PLAN.pro);
  if (pro) return { plan: pro.plan, planHandle: pro.handle };

  const basic = recognized.find((item) => item.plan === AI_SEARCH_PLAN.basic);
  if (basic) return { plan: basic.plan, planHandle: basic.handle };

  // Preserve the provider handle for diagnostics only; it never grants an
  // entitlement when the mapping is unknown.
  const preferred = preferredPlanHandle?.trim();
  return {
    plan: AI_SEARCH_PLAN.none,
    planHandle: itemHandles[0] ?? preferred ?? null,
  };
}

function parsePartnerDate(value: string | null | undefined) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export async function refreshShopifyAppPricingSubscription({
  shop,
  admin,
  preferredPlanHandle,
}: {
  shop: string;
  admin: AdminGraphqlClient;
  preferredPlanHandle?: string | null;
}) {
  const identity = await fetchShopIdentity(admin);

  await ensureShopRecord({
    shop,
    shopifyShopId: identity.id,
    reactivate: true,
  });

  const before = await getSubscriptionSnapshot(shop);
  const result = await queryActiveSubscription(identity.id);

  if (!result.configured) {
    return {
      configured: false as const,
      subscription: before,
      changed: false,
      previousPlan: before.plan,
      previousStatus: before.status,
    };
  }

  if (!result.subscription) {
    await db.$executeRaw`
      UPDATE \`AiSearchSubscription\`
      SET
        \`plan\` = 'NONE',
        \`status\` = 'INACTIVE',
        \`planHandle\` = NULL,
        \`shopifySubscriptionId\` = NULL,
        \`billingPeriodStart\` = NULL,
        \`billingPeriodEnd\` = NULL,
        \`source\` = 'SHOPIFY_APP_PRICING',
        \`lastSyncedAt\` = UTC_TIMESTAMP(3),
        \`updatedAt\` = UTC_TIMESTAMP(3)
      WHERE \`shop\` = ${shop}
    `;

    const subscription = await getSubscriptionSnapshot(shop);

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

  // Managed Pricing can retain historical item prices after a plan price
  // changes. Shopify marks those old prices as `active: false`; never let an
  // inactive price grant an entitlement. Only current active pricing items
  // are eligible for Basic/Pro mapping.
  const itemHandles = (result.subscription.items ?? [])
    .filter((item) => item.price?.active === true)
    .map((item) => item.handle?.trim())
    .filter((value): value is string => Boolean(value));

  const inferred = inferPlan({
    preferredPlanHandle,
    itemHandles,
  });

  if (inferred.plan === AI_SEARCH_PLAN.none) {
    // Partner API responded successfully, so an unrecognized active item must
    // fail closed. Keeping the previous local PRO/BASIC row would allow stale
    // paid entitlement indefinitely after a pricing configuration change.
    await db.$executeRaw`
      UPDATE \`AiSearchSubscription\`
      SET
        \`plan\` = 'NONE',
        \`status\` = 'INACTIVE',
        \`planHandle\` = ${inferred.planHandle},
        \`shopifySubscriptionId\` = ${result.subscription.legacySubscriptionId ?? null},
        \`billingPeriodStart\` = NULL,
        \`billingPeriodEnd\` = NULL,
        \`source\` = 'SHOPIFY_APP_PRICING',
        \`lastSyncedAt\` = UTC_TIMESTAMP(3),
        \`updatedAt\` = UTC_TIMESTAMP(3)
      WHERE \`shop\` = ${shop}
    `;

    throw new Error(
      `Active Shopify App Pricing subscription found, but its plan could not be mapped. AI Search was disabled until AI_SEARCH_BASIC_PLAN_HANDLES / AI_SEARCH_PRO_PLAN_HANDLES is corrected. Handles: ${itemHandles.join(", ") || "none"}`,
    );
  }

  const start = parsePartnerDate(
    result.subscription.currentBillingCycle?.startTime,
  );
  const end = parsePartnerDate(
    result.subscription.currentBillingCycle?.endTime,
  );

  await db.$executeRaw`
    UPDATE \`AiSearchSubscription\`
    SET
      \`plan\` = ${inferred.plan},
      \`status\` = 'ACTIVE',
      \`planHandle\` = ${inferred.planHandle},
      \`shopifySubscriptionId\` = ${result.subscription.legacySubscriptionId ?? null},
      \`billingPeriodStart\` = ${start},
      \`billingPeriodEnd\` = ${end},
      \`source\` = 'SHOPIFY_APP_PRICING',
      \`lastSyncedAt\` = UTC_TIMESTAMP(3),
      \`updatedAt\` = UTC_TIMESTAMP(3)
    WHERE \`shop\` = ${shop}
  `;

  const subscription = await getSubscriptionSnapshot(shop);

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
