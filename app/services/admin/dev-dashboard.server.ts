import type { Prisma } from "@prisma/client";

import db from "../../db.server";
import {
  AI_SEARCH_PLAN,
  PLAN_DEFINITIONS,
  normalizePlan,
  type AiSearchPlan,
  type PlanLimits,
} from "../commerce/plans.server";
import { parsePlanFeatureFlags } from "../commerce/plan-catalog.server";
import { validatePlanBillingPolicy } from "../billing/plan-policy";
import { getReadiness } from "../maintenance/readiness.server";
import { getSearchAttemptMetrics } from "../search/search-attempt-metrics.server";
import {
  buildQuotaView,
  calculateSubscriptionMrr,
  hasPendingCustomPrice,
} from "./dev-dashboard-commercial";

type ShopRow = {
  shop: string;
  lifecycleStatus: string;
  currentPlanHandle: string | null;
  pendingPlanHandle: string | null;
  pendingChangeAt: Date | string | null;
  legacyPlan: string | null;
  legacySubscriptionStatus: string | null;
  legacyBillingPeriodStart: Date | string | null;
  legacyBillingPeriodEnd: Date | string | null;
  legacySource: string | null;
  aiSearchEnabled: boolean | number | null;
  adminSuspended: boolean | number | null;
  productLimitOverride: number | null;
  searchLimitOverride: number | null;
  vectorUpdateLimitOverride: number | null;
  searchCount: number | null;
  vectorUpdateCount: number | null;
  productEmbeddingCount: number | null;
  queryEmbeddingCount: number | null;
  fallbackCount: number | null;
  indexedProducts: number | bigint | string | null;
  productSlotsUsed: number | bigint | string | null;
  searchGrant: number | bigint | string | null;
  productGrant: number | bigint | string | null;
  vectorGrant: number | bigint | string | null;
};

type ApiByShopRow = {
  unknownCostRequests: number | bigint | string | null;
  shop: string | null;
  inputTokens: number | bigint | string | null;
  outputTokens: number | bigint | string | null;
  totalTokens: number | bigint | string | null;
  costMicros: number | bigint | string | null;
};

type ProviderSummaryRow = {
  unknownCostRequests: number | bigint | string | null;
  inputTokens: number | bigint | string | null;
  outputTokens: number | bigint | string | null;
  totalTokens: number | bigint | string | null;
  embeddingTokens: number | bigint | string | null;
  llmTokens: number | bigint | string | null;
  costMicros: number | bigint | string | null;
  searchCostMicros: number | bigint | string | null;
  indexingCostMicros: number | bigint | string | null;
};

function n(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function applyOverride(base: number | null, override: number | null) {
  return override === null || override < 0 ? base : override;
}

function addGrant(limit: number | null, amount: unknown) {
  if (limit === null) return null;
  return Math.min(1_000_000_000, Math.max(0, limit) + Math.max(0, n(amount)));
}

function applyShopAdjustments(
  base: PlanLimits,
  overrides: {
    product: number | null;
    search: number | null;
    vectorUpdate: number | null;
  },
  grants: {
    product: number;
    search: number;
    vectorUpdate: number;
  },
): PlanLimits {
  return {
    productLimit: addGrant(
      applyOverride(base.productLimit, overrides.product),
      grants.product,
    ),
    searchLimit: addGrant(
      applyOverride(base.searchLimit, overrides.search),
      grants.search,
    ),
    vectorUpdateLimit: addGrant(
      applyOverride(base.vectorUpdateLimit, overrides.vectorUpdate),
      grants.vectorUpdate,
    ),
  };
}

function monthStartUtc(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

function budgetUsd() {
  const value = Number.parseFloat(
    process.env.AI_SEARCH_OPENAI_MONTHLY_BUDGET_USD ?? "",
  );
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function semanticPlanKey(handle: string | null | undefined): AiSearchPlan {
  const normalized = normalizePlan(handle);
  if (normalized !== AI_SEARCH_PLAN.none) return normalized;
  return handle?.trim() ? AI_SEARCH_PLAN.custom : AI_SEARCH_PLAN.none;
}

export async function getDevDashboardData(search = "") {
  const now = new Date();
  const from = monthStartUtc(now);
  const needle = search.trim().toLowerCase();

  const [
    shopRows,
    apiByShop,
    providerRows,
    recentGrants,
    recentAudit,
    securityAudit,
    searchCountRows,
    billingPlans,
    billingSubscriptions,
    planAssignments,
    failedSyncJobs,
    failedCatalogJobs,
    activeSubscriptionsMissingPrice,
  ] = await Promise.all([
    db.$queryRaw<ShopRow[]>`
      SELECT
        s.\`shop\`,
        s.\`status\` AS \`lifecycleStatus\`,
        s.\`currentPlanHandle\`,
        s.\`pendingPlanHandle\`,
        s.\`pendingChangeAt\`,
        sub.\`plan\` AS \`legacyPlan\`,
        sub.\`status\` AS \`legacySubscriptionStatus\`,
        sub.\`billingPeriodStart\` AS \`legacyBillingPeriodStart\`,
        sub.\`billingPeriodEnd\` AS \`legacyBillingPeriodEnd\`,
        sub.\`source\` AS \`legacySource\`,
        st.\`aiSearchEnabled\`,
        st.\`adminSuspended\`,
        st.\`productLimitOverride\`,
        st.\`searchLimitOverride\`,
        st.\`vectorUpdateLimitOverride\`,
        up.\`searchCount\`,
        up.\`vectorUpdateCount\`,
        up.\`productEmbeddingCount\`,
        up.\`queryEmbeddingCount\`,
        up.\`fallbackCount\`,
        (
          SELECT COUNT(*)
          FROM \`AiSearchIndexedProduct\` p
          WHERE
            p.\`shop\` = s.\`shop\`
            AND p.\`hasVector\` = TRUE
        ) AS \`indexedProducts\`,
        (
          SELECT COUNT(*) FROM \`AiSearchIndexedProduct\` p
          WHERE p.\`shop\` = s.\`shop\`
            AND (p.\`blockedReason\` IS NULL OR p.\`status\` = 'PRODUCT_SLOT_RESERVED')
        ) AS \`productSlotsUsed\`,
        COALESCE(g.\`searchGrant\`, 0) AS \`searchGrant\`,
        COALESCE(g.\`productGrant\`, 0) AS \`productGrant\`,
        COALESCE(g.\`vectorGrant\`, 0) AS \`vectorGrant\`
      FROM \`AiSearchShop\` s
      LEFT JOIN \`AiSearchSubscription\` sub ON sub.\`shop\` = s.\`shop\`
      LEFT JOIN \`AiSearchShopSettings\` st ON st.\`shop\` = s.\`shop\`
      LEFT JOIN \`AiSearchUsagePeriod\` up
        ON up.\`id\` = (
          SELECT up2.\`id\`
          FROM \`AiSearchUsagePeriod\` up2
          WHERE up2.\`shop\` = s.\`shop\`
          ORDER BY up2.\`periodEnd\` DESC, up2.\`id\` DESC
          LIMIT 1
        )
      LEFT JOIN (
        SELECT
          \`shop\`,
          SUM(CASE WHEN \`kind\` = 'SEARCH' THEN \`amount\` ELSE 0 END) AS \`searchGrant\`,
          SUM(CASE WHEN \`kind\` = 'PRODUCT' THEN \`amount\` ELSE 0 END) AS \`productGrant\`,
          SUM(CASE WHEN \`kind\` = 'VECTOR_UPDATE' THEN \`amount\` ELSE 0 END) AS \`vectorGrant\`
        FROM \`AiSearchQuotaGrant\`
        WHERE
          \`revokedAt\` IS NULL
          AND \`startsAt\` <= ${now}
          AND (\`expiresAt\` IS NULL OR \`expiresAt\` > ${now})
        GROUP BY \`shop\`
      ) g ON g.\`shop\` = s.\`shop\`
      ORDER BY s.\`updatedAt\` DESC
      LIMIT 500
    `,
    db.$queryRaw<ApiByShopRow[]>`
      SELECT
        COALESCE(SUM(u.\`unknownCostRequests\`), 0) AS \`unknownCostRequests\`,
        u.\`shop\`,
        COALESCE(SUM(u.\`inputTokens\`), 0) AS \`inputTokens\`,
        COALESCE(SUM(u.\`outputTokens\`), 0) AS \`outputTokens\`,
        COALESCE(SUM(u.\`totalTokens\`), 0) AS \`totalTokens\`,
        COALESCE(SUM(u.\`estimatedCostMicros\`), 0) AS \`costMicros\`
      FROM (
        SELECT
          \`shop\`, \`inputTokens\`, \`outputTokens\`,
          \`totalTokens\`, \`estimatedCostMicros\`, CASE WHEN \`costEstimateStatus\` = 'UNKNOWN_RATE' THEN 1 ELSE 0 END AS \`unknownCostRequests\`
        FROM \`AiSearchApiUsageEvent\`
        WHERE \`createdAt\` >= ${from} AND \`shop\` IS NOT NULL
        UNION ALL
        SELECT
          \`shop\`, \`inputTokens\`, \`outputTokens\`,
          \`totalTokens\`, \`estimatedCostMicros\`, \`unknownCostRequests\`
        FROM \`AiSearchApiUsageDaily\`
        WHERE \`day\` >= DATE(${from}) AND \`shop\` <> '__UNSCOPED__'
      ) AS u
      GROUP BY u.\`shop\`
    `,
    db.$queryRaw<ProviderSummaryRow[]>`
      SELECT
        COALESCE(SUM(u.\`unknownCostRequests\`), 0) AS \`unknownCostRequests\`,
        COALESCE(SUM(u.\`inputTokens\`), 0) AS \`inputTokens\`,
        COALESCE(SUM(u.\`outputTokens\`), 0) AS \`outputTokens\`,
        COALESCE(SUM(u.\`totalTokens\`), 0) AS \`totalTokens\`,
        COALESCE(SUM(
          CASE
            WHEN u.\`operation\` IN ('QUERY_EMBEDDING', 'PRODUCT_EMBEDDING', 'EMBEDDING')
            THEN u.\`inputTokens\` ELSE 0
          END
        ), 0) AS \`embeddingTokens\`,
        COALESCE(SUM(
          CASE
            WHEN u.\`operation\` IN ('QUERY_REWRITE', 'PRODUCT_ENRICHMENT')
            THEN u.\`totalTokens\` ELSE 0
          END
        ), 0) AS \`llmTokens\`,
        COALESCE(SUM(u.\`estimatedCostMicros\`), 0) AS \`costMicros\`,
        COALESCE(SUM(
          CASE
            WHEN u.\`operation\` IN ('QUERY_REWRITE', 'QUERY_EMBEDDING')
            THEN u.\`estimatedCostMicros\` ELSE 0
          END
        ), 0) AS \`searchCostMicros\`,
        COALESCE(SUM(
          CASE
            WHEN u.\`operation\` IN ('PRODUCT_ENRICHMENT', 'PRODUCT_EMBEDDING')
            THEN u.\`estimatedCostMicros\` ELSE 0
          END
        ), 0) AS \`indexingCostMicros\`
      FROM (
        SELECT
          \`operation\`, \`inputTokens\`, \`outputTokens\`,
          \`totalTokens\`, \`estimatedCostMicros\`, CASE WHEN \`costEstimateStatus\` = 'UNKNOWN_RATE' THEN 1 ELSE 0 END AS \`unknownCostRequests\`
        FROM \`AiSearchApiUsageEvent\`
        WHERE \`createdAt\` >= ${from}
        UNION ALL
        SELECT
          \`operation\`, \`inputTokens\`, \`outputTokens\`,
          \`totalTokens\`, \`estimatedCostMicros\`, \`unknownCostRequests\`
        FROM \`AiSearchApiUsageDaily\`
        WHERE \`day\` >= DATE(${from})
      ) AS u
    `,
    db.aiSearchQuotaGrant.findMany({
      orderBy: { createdAt: "desc" },
      take: 500,
    }),
    db.aiSearchAdminAuditLog.findMany({
      orderBy: { createdAt: "desc" },
      take: 30,
    }),
    db.devAuditLog.findMany({
      orderBy: { createdAt: "desc" },
      take: 30,
      include: {
        devUser: {
          select: { email: true, role: true },
        },
      },
    }),
    db.$queryRaw<Array<{ count: number | bigint | string }>>`
      SELECT COUNT(*) AS \`count\`
      FROM \`AiSearchQueryLog\`
      WHERE \`createdAt\` >= ${from}
    `,
    db.plan.findMany({
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      select: {
        id: true,
        handle: true,
        name: true,
        visibility: true,
        billingMode: true,
        interval: true,
        price: true,
        currencyCode: true,
        trialDays: true,
        maxIndexedProducts: true,
        maxMonthlySearches: true,
        maxMonthlyVectorUpdates: true,
        usageBillingEnabled: true,
        featureFlags: true,
        shopifyPlanHandle: true,
        version: true,
        isActive: true,
        sortOrder: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
    db.billingSubscription.findMany({
      orderBy: { updatedAt: "desc" },
      select: {
        id: true,
        shop: true,
        status: true,
        trialEndsAt: true,
        currentPeriodStartsAt: true,
        currentPeriodEndsAt: true,
        priceSnapshot: true,
        currencySnapshot: true,
        intervalSnapshot: true,
        planNameSnapshot: true,
        shopifyPlanHandle: true,
        plan: {
          select: {
            id: true,
            handle: true,
            name: true,
            price: true,
            currencyCode: true,
            interval: true,
            maxIndexedProducts: true,
            maxMonthlySearches: true,
            maxMonthlyVectorUpdates: true,
          },
        },
      },
    }),
    db.planAssignment.findMany({
      where: { isActive: true },
      orderBy: { createdAt: "desc" },
      include: { plan: true },
    }),
    db.aiSearchSyncJob.count({
      where: { status: { in: ["FAILED", "DEAD", "ERROR"] } },
    }),
    db.aiSearchCatalogSyncJob.count({
      where: { status: { in: ["FAILED", "DEAD", "ERROR"] } },
    }),
    db.billingSubscription.count({
      where: { status: "ACTIVE", priceSnapshot: null },
    }),
  ]);

  const apiMap = new Map(
    apiByShop
      .filter((row): row is ApiByShopRow & { shop: string } => Boolean(row.shop))
      .map((row) => [row.shop, row]),
  );

  const mappedShops = shopRows.map((row) => {
    const api = apiMap.get(row.shop);
    return {
      shop: row.shop,
      lifecycleStatus: row.lifecycleStatus,
      currentPlanHandle: row.currentPlanHandle,
      pendingPlanHandle: row.pendingPlanHandle,
      pendingChangeAt: row.pendingChangeAt,
      legacyPlan: row.legacyPlan,
      legacySubscriptionStatus: row.legacySubscriptionStatus,
      legacyBillingPeriodStart: row.legacyBillingPeriodStart,
      legacyBillingPeriodEnd: row.legacyBillingPeriodEnd,
      legacySource: row.legacySource,
      aiSearchEnabled: Boolean(row.aiSearchEnabled) && !Boolean(row.adminSuspended),
      merchantEnabled: Boolean(row.aiSearchEnabled),
      adminEnabled: !Boolean(row.adminSuspended),
      overrides: {
        product: row.productLimitOverride,
        search: row.searchLimitOverride,
        vectorUpdate: row.vectorUpdateLimitOverride,
      },
      grants: {
        product: n(row.productGrant),
        search: n(row.searchGrant),
        vectorUpdate: n(row.vectorGrant),
      },
      usage: {
        indexedProducts: n(row.indexedProducts),
        productSlotsUsed: n(row.productSlotsUsed),
        searchCount: n(row.searchCount),
        vectorUpdateCount: n(row.vectorUpdateCount),
        productEmbeddingCount: n(row.productEmbeddingCount),
        queryEmbeddingCount: n(row.queryEmbeddingCount),
        fallbackCount: n(row.fallbackCount),
      },
      api: {
        unknownCostRequests: n(api?.unknownCostRequests),
        inputTokens: n(api?.inputTokens),
        outputTokens: n(api?.outputTokens),
        totalTokens: n(api?.totalTokens),
        costUsd: n(api?.costMicros) / 1_000_000,
      },
    };
  });

  const shops = mappedShops.filter(
    (row) => !needle || row.shop.toLowerCase().includes(needle),
  );

  const provider = providerRows[0] ?? {
    unknownCostRequests: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    embeddingTokens: 0,
    llmTokens: 0,
    costMicros: 0,
    searchCostMicros: 0,
    indexingCostMicros: 0,
  };

  const configuredBudget = budgetUsd();
  const totalCostUsd = n(provider.costMicros) / 1_000_000;
  const searchCostUsd = n(provider.searchCostMicros) / 1_000_000;
  const mtdSearches = n(searchCountRows[0]?.count);
  const avgSearchCostUsd = mtdSearches > 0 && n(provider.unknownCostRequests) === 0 ? searchCostUsd / mtdSearches : null;
  const remainingBudgetUsd =
    configuredBudget === null || n(provider.unknownCostRequests) > 0
      ? null
      : Math.max(0, configuredBudget - totalCostUsd);

  const overall = mappedShops.reduce(
    (acc, shop) => {
      acc.totalShops += 1;
      if (shop.lifecycleStatus === "ACTIVE") acc.activeShops += 1;
      if (shop.aiSearchEnabled) acc.aiEnabledShops += 1;
      acc.indexedProducts += shop.usage.indexedProducts;
      acc.searches += shop.usage.searchCount;
      acc.vectorUpdates += shop.usage.vectorUpdateCount;
      acc.fallbacks += shop.usage.fallbackCount;
      acc.apiTokens += shop.api.totalTokens;
      acc.apiCostUsd += shop.api.costUsd;
      return acc;
    },
    {
      totalShops: 0,
      activeShops: 0,
      aiEnabledShops: 0,
      indexedProducts: 0,
      searches: 0,
      vectorUpdates: 0,
      fallbacks: 0,
      apiTokens: 0,
      apiCostUsd: 0,
    },
  );

  const [totalShops, activeShops, indexedProducts, globalUsage] = await Promise.all([
    db.aiSearchShop.count(),
    db.aiSearchShop.count({ where: { status: "ACTIVE" } }),
    db.aiSearchIndexedProduct.count({ where: { hasVector: true } }),
    db.$queryRaw<Array<{ searches: unknown; vectorUpdates: unknown; fallbacks: unknown }>>`
      SELECT COALESCE(SUM(u.searchCount), 0) AS searches, COALESCE(SUM(u.vectorUpdateCount), 0) AS vectorUpdates, COALESCE(SUM(u.fallbackCount), 0) AS fallbacks
      FROM AiSearchUsagePeriod u WHERE u.id = (
        SELECT p.id FROM AiSearchUsagePeriod p WHERE p.shop = u.shop ORDER BY p.periodEnd DESC, p.id DESC LIMIT 1
      )
    `,
  ]);
  Object.assign(overall, { totalShops, activeShops, indexedProducts, searches: n(globalUsage[0]?.searches), vectorUpdates: n(globalUsage[0]?.vectorUpdates), fallbacks: n(globalUsage[0]?.fallbacks), apiTokens: n(provider.totalTokens), apiCostUsd: totalCostUsd });

  const currentSubscriptionByShop = new Map<
    string,
    (typeof billingSubscriptions)[number]
  >();
  for (const subscription of billingSubscriptions) {
    if (!currentSubscriptionByShop.has(subscription.shop)) {
      currentSubscriptionByShop.set(subscription.shop, subscription);
    }
  }
  const currentSubscriptions = [...currentSubscriptionByShop.values()];

  // Operational state must match Merchant Dashboard/Billing V2. Historical,
  // cancelled and expired subscriptions must not make a shop look entitled.
  const operationalSubscriptionByShop = new Map<
    string,
    (typeof billingSubscriptions)[number]
  >();
  for (const subscription of currentSubscriptions) {
    if (
      subscription.status &&
      ["ACTIVE", "PENDING", "FROZEN"].includes(subscription.status) &&
      !operationalSubscriptionByShop.has(subscription.shop)
    ) {
      operationalSubscriptionByShop.set(subscription.shop, subscription);
    }
  }

  const customAssignmentByShop = new Map<
    string,
    (typeof planAssignments)[number]
  >();
  for (const assignment of planAssignments) {
    if (
      assignment.plan.handle.trim().toLowerCase() === "custom" &&
      !customAssignmentByShop.has(assignment.shop)
    ) {
      customAssignmentByShop.set(assignment.shop, assignment);
    }
  }

  const planStats = billingPlans.map((plan) => ({
    key: plan.handle.toUpperCase(),
    id: plan.id,
    handle: plan.handle,
    name: plan.name,
    active: 0,
    trials: 0,
    frozen: 0,
    cancelled: 0,
    revenueByCurrency: new Map<string, number>(),
  }));
  const planStatsById = new Map(planStats.map((plan) => [plan.id, plan]));
  const planStatsByHandle = new Map(
    planStats.map((plan) => [plan.handle.trim().toLowerCase(), plan]),
  );

  const revenueByCurrency = new Map<string, number>();
  let activeSubscriptions = 0;
  let trialSubscriptions = 0;
  let frozenSubscriptions = 0;
  let cancelledSubscriptions = 0;

  for (const subscription of currentSubscriptions) {
    const status = subscription.status ?? null;
    const subscriptionHandle =
      subscription.plan?.handle?.trim().toLowerCase() ??
      subscription.shopifyPlanHandle?.trim().toLowerCase() ??
      null;
    const stats = subscription.plan?.id
      ? planStatsById.get(subscription.plan.id)
      : subscriptionHandle
        ? planStatsByHandle.get(subscriptionHandle)
        : undefined;

    if (status === "ACTIVE") {
      activeSubscriptions += 1;
      if (
        subscription.trialEndsAt &&
        subscription.trialEndsAt.getTime() > now.getTime()
      ) {
        trialSubscriptions += 1;
        if (stats) stats.trials += 1;
      }
      if (stats) stats.active += 1;

      // ACTIVE subscription revenue must come from the frozen billing snapshot
      // first. Custom configuration may change later, but that must not rewrite
      // historical/current revenue until Shopify's active subscription changes.
      const contribution = calculateSubscriptionMrr({
        status: subscription.status,
        priceSnapshot: subscription.priceSnapshot,
        currencySnapshot: subscription.currencySnapshot,
        intervalSnapshot: subscription.intervalSnapshot,
      });
      if (contribution) {
        revenueByCurrency.set(
          contribution.currency,
          (revenueByCurrency.get(contribution.currency) ?? 0) + contribution.mrr,
        );
        if (stats) {
          stats.revenueByCurrency.set(
            contribution.currency,
            (stats.revenueByCurrency.get(contribution.currency) ?? 0) +
              contribution.mrr,
          );
        }
      }
    } else if (status === "FROZEN") {
      frozenSubscriptions += 1;
      if (stats) stats.frozen += 1;
    } else if (status === "CANCELLED" || status === "EXPIRED") {
      cancelledSubscriptions += 1;
      if (stats) stats.cancelled += 1;
    }
  }

  const revenue = [...revenueByCurrency.entries()]
    .map(([currency, mrr]) => ({
      currency,
      mrr,
      arr: mrr * 12,
    }))
    .sort((a, b) => b.mrr - a.mrr);

  const financial = {
    activeSubscriptions,
    trialSubscriptions,
    frozenSubscriptions,
    cancelledSubscriptions,
    shopsWithoutActiveSubscription: Math.max(
      0,
      mappedShops.length - activeSubscriptions,
    ),
    revenue,
    plans: planStats.map((plan) => ({
      id: plan.id,
      key: plan.key,
      handle: plan.handle,
      name: plan.name,
      active: plan.active,
      trials: plan.trials,
      frozen: plan.frozen,
      cancelled: plan.cancelled,
      revenue: [...plan.revenueByCurrency.entries()].map(([currency, mrr]) => ({
        currency,
        mrr,
      })),
    })),
    revenueType: "SUBSCRIPTION_RUN_RATE" as const,
  };

  const dashboardShops = shops.map((shop) => {
    const billing = operationalSubscriptionByShop.get(shop.shop);
    const customConfig = customAssignmentByShop.get(shop.shop);

    // Local development deliberately uses AiSearchSubscription/DEV_OVERRIDE
    // instead of a paid Shopify BillingSubscription. Merchant Dashboard already
    // treats that snapshot as operational; Dev Center must do the same for
    // plan/quota/state while still excluding it from paid-shop/MRR metrics.
    const devOverrideActive =
      !billing &&
      shop.legacySource === "DEV_OVERRIDE" &&
      shop.legacySubscriptionStatus === "ACTIVE";
    const devOverridePlan = devOverrideActive
      ? normalizePlan(shop.legacyPlan)
      : AI_SEARCH_PLAN.none;

    const plan = billing
      ? semanticPlanKey(
          billing.plan?.handle ?? billing.shopifyPlanHandle,
        )
      : devOverridePlan;

    const isShopSpecificCustomPlan =
      billing?.plan?.handle?.trim().toLowerCase() === "custom" ||
      (devOverrideActive && devOverridePlan === AI_SEARCH_PLAN.custom);
    const planLabel =
      isShopSpecificCustomPlan && customConfig?.customName
        ? customConfig.customName
        : billing?.plan?.name ?? PLAN_DEFINITIONS[plan].label;

    const baseLimits: PlanLimits = isShopSpecificCustomPlan
      ? customConfig
        ? {
            productLimit: customConfig.customMaxIndexedProducts,
            searchLimit: customConfig.customMaxMonthlySearches,
            vectorUpdateLimit:
              customConfig.customMaxMonthlyVectorUpdates,
          }
        : PLAN_DEFINITIONS.CUSTOM.limits
      : billing?.plan
        ? {
            productLimit: billing.plan.maxIndexedProducts,
            searchLimit: billing.plan.maxMonthlySearches,
            vectorUpdateLimit: billing.plan.maxMonthlyVectorUpdates,
          }
        : PLAN_DEFINITIONS[plan].limits;

    const adjustedLimits = applyShopAdjustments(
      baseLimits,
      shop.overrides,
      shop.grants,
    );
    const subscriptionStatus =
      billing?.status ?? (devOverrideActive ? "ACTIVE" : "INACTIVE");
    const limits =
      subscriptionStatus === "ACTIVE"
        ? adjustedLimits
        : PLAN_DEFINITIONS.NONE.limits;

    const subscriptionActive = subscriptionStatus === "ACTIVE";
    const paidBillingActive = billing?.status === "ACTIVE";
    const lifecycleActive = shop.lifecycleStatus === "ACTIVE";
    const aiOperational =
      subscriptionActive && lifecycleActive && shop.aiSearchEnabled;
    const customPrice =
      customConfig?.customPriceOverride === null ||
      customConfig?.customPriceOverride === undefined
        ? null
        : n(customConfig.customPriceOverride);
    const billedPrice =
      billing?.priceSnapshot === null ||
      billing?.priceSnapshot === undefined
        ? null
        : n(billing.priceSnapshot);
    const customTermsDiffer = Boolean(
      customConfig &&
        (
          shop.pendingPlanHandle?.trim().toLowerCase() === "custom" ||
          (
            billing &&
            isShopSpecificCustomPlan &&
            hasPendingCustomPrice({
              subscriptionStatus,
              billedPrice,
              configuredPrice: customPrice,
            })
          )
        ),
    );

    return {
      ...shop,
      plan,
      planLabel,
      subscriptionStatus,
      billingPeriodStart:
        billing?.currentPeriodStartsAt ??
        (devOverrideActive ? shop.legacyBillingPeriodStart : null),
      billingPeriodEnd:
        billing?.currentPeriodEndsAt ??
        (devOverrideActive ? shop.legacyBillingPeriodEnd : null),
      limits,
      billing: {
        status: billing?.status ?? null,
        priceSnapshot:
          billing?.priceSnapshot === null ||
          billing?.priceSnapshot === undefined
            ? null
            : n(billing.priceSnapshot),
        currency:
          billing?.currencySnapshot ??
          billing?.plan?.currencyCode ??
          null,
        interval:
          billing?.intervalSnapshot ??
          billing?.plan?.interval ??
          null,
      },
      customConfig: customConfig
        ? {
            name: customConfig.customName ?? "Custom",
            price: customPrice,
            currencyCode:
              customConfig.customCurrencyCode ??
              customConfig.plan.currencyCode ??
              "USD",
            interval:
              customConfig.customInterval ??
              customConfig.plan.interval,
            trialDays:
              customConfig.customTrialDays ??
              customConfig.plan.trialDays ??
              0,
            productLimit: customConfig.customMaxIndexedProducts,
            searchLimit: customConfig.customMaxMonthlySearches,
            vectorUpdateLimit: customConfig.customMaxMonthlyVectorUpdates,
            usageBillingEnabled:
              customConfig.customUsageBillingEnabled ??
              customConfig.plan.usageBillingEnabled,
            features: parsePlanFeatureFlags(
              customConfig.customFeatureFlags ??
                customConfig.plan.featureFlags,
            ),
            notes: customConfig.notes,
          }
        : null,
      identity: {
        domain: shop.shop,
        lifecycleStatus: shop.lifecycleStatus,
      },
      commercial: {
        plan,
        planLabel,
        subscriptionStatus,
        activePaid: paidBillingActive,
        priceSnapshot: billedPrice,
        currency:
          billing?.currencySnapshot ?? billing?.plan?.currencyCode ?? null,
        interval:
          billing?.intervalSnapshot ?? billing?.plan?.interval ?? null,
        periodStart:
          billing?.currentPeriodStartsAt ??
          (devOverrideActive ? shop.legacyBillingPeriodStart : null),
        periodEnd:
          billing?.currentPeriodEndsAt ??
          (devOverrideActive ? shop.legacyBillingPeriodEnd : null),
        customTerms: customConfig
          ? {
              configured: true,
              name: customConfig.customName ?? "Custom",
              price: customPrice,
              currency:
                customConfig.customCurrencyCode ??
                customConfig.plan.currencyCode ??
                "USD",
              interval:
                customConfig.customInterval ??
                customConfig.plan.interval,
              trialDays:
                customConfig.customTrialDays ??
                customConfig.plan.trialDays ??
                0,
              productLimit: customConfig.customMaxIndexedProducts,
              searchLimit: customConfig.customMaxMonthlySearches,
              vectorUpdateLimit:
                customConfig.customMaxMonthlyVectorUpdates,
              usageBillingEnabled:
                customConfig.customUsageBillingEnabled ??
                customConfig.plan.usageBillingEnabled,
              features: parsePlanFeatureFlags(
                customConfig.customFeatureFlags ??
                  customConfig.plan.featureFlags,
              ),
              pendingCommercialChange: customTermsDiffer,
            }
          : null,
      },
      state: {
        aiConfigured: shop.aiSearchEnabled,
        aiOperational,
        lifecycleActive,
      },
      quota: {
        products: buildQuotaView({
          subscriptionStatus,
          actualUsed: shop.usage.productSlotsUsed,
          retained: shop.usage.indexedProducts,
          effectiveLimit: limits.productLimit,
          storedGrant: shop.grants.product,
        }),
        searches: buildQuotaView({
          subscriptionStatus,
          actualUsed: shop.usage.searchCount,
          effectiveLimit: limits.searchLimit,
          storedGrant: shop.grants.search,
        }),
        vectorUpdates: buildQuotaView({
          subscriptionStatus,
          actualUsed: shop.usage.vectorUpdateCount,
          effectiveLimit: limits.vectorUpdateLimit,
          storedGrant: shop.grants.vectorUpdate,
        }),
      },
      cost: {
        unknownCostRequests: shop.api.unknownCostRequests,
        mtdUsd: shop.api.costUsd,
      },
    };
  });

  const aiOperationalShops = dashboardShops.filter(
    (shop) => shop.state.aiOperational,
  ).length;

  const overview = {
    totalShops: overall.totalShops,
    activeShops: overall.activeShops,
    paidShops: activeSubscriptions,
    aiEnabledShops: aiOperationalShops,
    indexedProducts: overall.indexedProducts,
    searchesMtd: mtdSearches,
    vectorUpdates: overall.vectorUpdates,
  };

  const planCatalog = billingPlans.map((plan) => {
    const subscriptionsForPlan = billingSubscriptions.filter(
      (subscription) => subscription.plan?.id === plan.id,
    );
    return {
      id: plan.id,
      handle: plan.handle,
      name: plan.name,
      visibility: plan.visibility,
      billingMode: plan.billingMode,
      interval: plan.interval,
      price: n(plan.price),
      currencyCode: plan.currencyCode,
      trialDays: plan.trialDays,
      limits: {
        productLimit: plan.maxIndexedProducts,
        searchLimit: plan.maxMonthlySearches,
        vectorUpdateLimit: plan.maxMonthlyVectorUpdates,
      },
      usageBillingEnabled: plan.usageBillingEnabled,
      shopifyPlanHandle: plan.shopifyPlanHandle,
      version: plan.version,
      isActive: plan.isActive,
      sortOrder: plan.sortOrder,
      features: parsePlanFeatureFlags(plan.featureFlags),
      subscriptions: {
        total: subscriptionsForPlan.length,
        active: subscriptionsForPlan.filter((item) => item.status === "ACTIVE").length,
        pending: subscriptionsForPlan.filter((item) => item.status === "PENDING").length,
        frozen: subscriptionsForPlan.filter((item) => item.status === "FROZEN").length,
      },
      createdAt: plan.createdAt.toISOString(),
      updatedAt: plan.updatedAt.toISOString(),
    };
  });

  return {
    generatedAt: now.toISOString(),
    attemptMetrics: await getSearchAttemptMetrics(from, now),
    readiness: await getReadiness(),
    shopCoverage: { displayed: shopRows.length, total: totalShops, partial: totalShops > shopRows.length },
    monthStart: from.toISOString(),
    query: search,
    overall: {
      ...overall,
      aiEnabledShops: aiOperationalShops,
    },
    overview,
    financial,
    planCatalog,
    provider: {
      unknownCostRequests: n(provider.unknownCostRequests),
      inputTokens: n(provider.inputTokens),
      outputTokens: n(provider.outputTokens),
      totalTokens: n(provider.totalTokens),
      embeddingTokens: n(provider.embeddingTokens),
      llmTokens: n(provider.llmTokens),
      totalCostUsd,
      searchCostUsd,
      indexingCostUsd: n(provider.indexingCostMicros) / 1_000_000,
      configuredBudgetUsd: configuredBudget,
      remainingBudgetUsd,
      mtdSearches,
      avgSearchCostUsd,
      estimatedSearchesRemaining:
        remainingBudgetUsd !== null &&
        avgSearchCostUsd !== null &&
        avgSearchCostUsd > 0
          ? Math.floor(remainingBudgetUsd / avgSearchCostUsd)
          : null,
    },
    diagnostics: {
      failedSyncJobs,
      failedCatalogJobs,
      activeSubscriptionsMissingPrice,
    },
    shops: dashboardShops,
    recentGrants: recentGrants.slice(0, 30).map((grant) => ({
      ...grant,
      startsAt: grant.startsAt.toISOString(),
      expiresAt: grant.expiresAt?.toISOString() ?? null,
      revokedAt: grant.revokedAt?.toISOString() ?? null,
      createdAt: grant.createdAt.toISOString(),
    })),
    supportGrants: recentGrants.map((grant) => ({
      ...grant,
      active:
        grant.revokedAt === null &&
        grant.startsAt.getTime() <= now.getTime() &&
        (grant.expiresAt === null || grant.expiresAt.getTime() > now.getTime()),
      startsAt: grant.startsAt.toISOString(),
      expiresAt: grant.expiresAt?.toISOString() ?? null,
      revokedAt: grant.revokedAt?.toISOString() ?? null,
      createdAt: grant.createdAt.toISOString(),
    })),
    recentAudit: recentAudit.map((item) => ({
      ...item,
      createdAt: item.createdAt.toISOString(),
    })),
    securityAudit: securityAudit.map((item) => ({
      id: item.id,
      action: item.action,
      result: item.result,
      resourceType: item.resourceType,
      resourceId: item.resourceId,
      createdAt: item.createdAt.toISOString(),
      userEmail: item.devUser?.email ?? null,
      userRole: item.devUser?.role ?? null,
    })),
  };
}

export type DevDashboardData = Awaited<
  ReturnType<typeof getDevDashboardData>
>;

export async function setCustomPlanTerms({
  actorShop,
  targetShop,
  name,
  price,
  currencyCode,
  interval,
  trialDays,
  moneyBackGuaranteeDays = 0,
  refundTerms = "",
  productLimit,
  searchLimit,
  vectorUpdateLimit,
  usageBillingEnabled,
  description,
  highlights,
  capabilities,
  reason,
}: {
  actorShop: string;
  targetShop: string;
  name: string;
  price: number;
  currencyCode: string;
  interval: "EVERY_30_DAYS" | "ANNUAL";
  trialDays: number;
  moneyBackGuaranteeDays?: number;
  refundTerms?: string;
  productLimit: number | null;
  searchLimit: number | null;
  vectorUpdateLimit: number | null;
  usageBillingEnabled: boolean;
  description: string;
  highlights: string[];
  capabilities: Record<string, boolean>;
  reason: string;
}) {
  const cleanReason = reason.trim().slice(0, 1000);

  const cleanName = name.trim().slice(0, 120);
  if (!cleanName) {
    throw new Error("Custom plan name is required");
  }

  const cleanPrice = Number(price);
  if (!Number.isFinite(cleanPrice) || cleanPrice <= 0 || cleanPrice > 1_000_000) {
    throw new Error("Custom price must be greater than 0");
  }

  const cleanCurrencyCode = currencyCode.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(cleanCurrencyCode)) {
    throw new Error("Custom currency must be a 3-letter ISO code");
  }

  if (!["EVERY_30_DAYS", "ANNUAL"].includes(interval)) {
    throw new Error("Invalid Custom billing interval");
  }

  const cleanTrialDays = trialDays;
  if (cleanTrialDays !== 0) throw new Error("Custom plans cannot offer a free trial.");
  if (
    !Number.isFinite(cleanTrialDays) ||
    cleanTrialDays < 0 ||
    cleanTrialDays > 365
  ) {
    throw new Error("Custom trial days must be between 0 and 365");
  }

  const normalizeLimit = (value: number | null, label: string) => {
    if (value === null) return null;
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(label + " must be blank for unlimited or >= 0");
    }
    return Math.min(1_000_000_000, Math.trunc(value));
  };

  const features = parsePlanFeatureFlags({
    billingPolicy: validatePlanBillingPolicy(moneyBackGuaranteeDays, refundTerms),
    description,
    highlights,
    capabilities,
  });

  const terms = {
    name: cleanName,
    price: Math.round(cleanPrice * 100) / 100,
    currencyCode: cleanCurrencyCode,
    interval,
    trialDays: cleanTrialDays,
    productLimit: normalizeLimit(productLimit, "Product limit"),
    searchLimit: normalizeLimit(searchLimit, "Search limit"),
    vectorUpdateLimit: normalizeLimit(
      vectorUpdateLimit,
      "Vector update limit",
    ),
    usageBillingEnabled: Boolean(usageBillingEnabled),
    features,
  };

  const target = await db.aiSearchShop.findUnique({
    where: { shop: targetShop },
    select: { shop: true },
  });
  if (!target) throw new Error("Target shop not found");

  const legacySubscription = await db.aiSearchSubscription.findUnique({
    where: { shop: targetShop },
    select: { source: true },
  });
  const isLocalDevOverride = legacySubscription?.source === "DEV_OVERRIDE";

  const customPlan = await db.plan.upsert({
    where: { handle: "custom" },
    create: {
      handle: "custom",
      name: "Custom",
      visibility: "INTERNAL",
      billingMode: "MANUAL_BILLING",
      interval: "EVERY_30_DAYS",
      price: 0,
      currencyCode: "USD",
      trialDays: 0,
      maxIndexedProducts: null,
      maxMonthlySearches: null,
      maxMonthlyVectorUpdates: null,
      usageBillingEnabled: false,
      featureFlags: features as Prisma.InputJsonValue,
      isActive: true,
      sortOrder: 30,
    },
    update: {
      name: "Custom",
      visibility: "INTERNAL",
      billingMode: "MANUAL_BILLING",
      isActive: true,
      sortOrder: 30,
    },
  });

  const before = await db.planAssignment.findUnique({
    where: {
      shop_planId: {
        shop: targetShop,
        planId: customPlan.id,
      },
    },
    select: {
      customName: true,
      customPriceOverride: true,
      customCurrencyCode: true,
      customInterval: true,
      customTrialDays: true,
      customMaxIndexedProducts: true,
      customMaxMonthlySearches: true,
      customMaxMonthlyVectorUpdates: true,
      customUsageBillingEnabled: true,
      customFeatureFlags: true,
      notes: true,
      isActive: true,
      startsAt: true,
      endsAt: true,
    },
  });

  const after = {
    customName: terms.name,
    customPriceOverride: terms.price,
    customCurrencyCode: terms.currencyCode,
    customInterval: terms.interval,
    customTrialDays: terms.trialDays,
    customMaxIndexedProducts: terms.productLimit,
    customMaxMonthlySearches: terms.searchLimit,
    customMaxMonthlyVectorUpdates: terms.vectorUpdateLimit,
    customUsageBillingEnabled: terms.usageBillingEnabled,
    customFeatureFlags: terms.features,
    notes: cleanReason,
    isActive: true,
  };

  await db.$transaction(async (tx) => {
    await tx.planAssignment.upsert({
      where: {
        shop_planId: {
          shop: targetShop,
          planId: customPlan.id,
        },
      },
      create: {
        shop: targetShop,
        planId: customPlan.id,
        customName: terms.name,
        customPriceOverride: terms.price,
        customCurrencyCode: terms.currencyCode,
        customInterval: terms.interval,
        customTrialDays: terms.trialDays,
        customMaxIndexedProducts: terms.productLimit,
        customMaxMonthlySearches: terms.searchLimit,
        customMaxMonthlyVectorUpdates: terms.vectorUpdateLimit,
        customUsageBillingEnabled: terms.usageBillingEnabled,
        customFeatureFlags: terms.features as Prisma.InputJsonValue,
        notes: cleanReason,
        startsAt: new Date(),
        endsAt: null,
        isActive: true,
      },
      update: {
        customName: terms.name,
        customPriceOverride: terms.price,
        customCurrencyCode: terms.currencyCode,
        customInterval: terms.interval,
        customTrialDays: terms.trialDays,
        customMaxIndexedProducts: terms.productLimit,
        customMaxMonthlySearches: terms.searchLimit,
        customMaxMonthlyVectorUpdates: terms.vectorUpdateLimit,
        customUsageBillingEnabled: terms.usageBillingEnabled,
        customFeatureFlags: terms.features as Prisma.InputJsonValue,
        notes: cleanReason,
        endsAt: null,
        isActive: true,
      },
    });

    if (isLocalDevOverride) {
      await tx.aiSearchSubscription.update({
        where: { shop: targetShop },
        data: {
          plan: AI_SEARCH_PLAN.custom,
          status: "ACTIVE",
          planHandle: "custom",
          source: "DEV_OVERRIDE",
          lastSyncedAt: new Date(),
        },
      });

      await tx.aiSearchShop.update({
        where: { shop: targetShop },
        data: {
          currentPlanHandle: "custom",
          pendingPlanHandle: null,
          pendingChangeAt: null,
        },
      });
    } else {
      await tx.aiSearchShop.update({
        where: { shop: targetShop },
        data: {
          pendingPlanHandle: "custom",
          pendingChangeAt: new Date(),
        },
      });
    }

    await tx.aiSearchAdminAuditLog.create({
      data: {
        actorShop,
        targetShop,
        action: "CUSTOM_PLAN_TERMS_CHANGED",
        reason: cleanReason,
        beforeJson: before ? JSON.stringify(before) : null,
        afterJson: JSON.stringify(after),
      },
    });
  });

  return {
    planId: customPlan.id,
    ...terms,
  };
}

export async function resolveGrantExpiry(
  shop: string,
  mode: "BILLING_CYCLE" | "30_DAYS" | "NEVER",
) {
  if (mode === "NEVER") return null;
  if (mode === "30_DAYS") {
    return new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  }

  const subscription = await db.billingSubscription.findFirst({
    where: {
      shop,
      status: { in: ["ACTIVE", "PENDING", "FROZEN"] },
    },
    orderBy: { updatedAt: "desc" },
    select: { currentPeriodEndsAt: true },
  });
  if (
    subscription?.currentPeriodEndsAt &&
    subscription.currentPeriodEndsAt.getTime() > Date.now()
  ) {
    return subscription.currentPeriodEndsAt;
  }
  return new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
}
