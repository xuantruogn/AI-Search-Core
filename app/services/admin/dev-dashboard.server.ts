import db from "../../db.server";
import {
  PLAN_DEFINITIONS,
  normalizePlan,
  type PlanLimits,
} from "../commerce/plans.server";

type ShopRow = {
  shop: string;
  lifecycleStatus: string;
  plan: string | null;
  subscriptionStatus: string | null;
  billingPeriodStart: Date | string | null;
  billingPeriodEnd: Date | string | null;
  aiSearchEnabled: boolean | number | null;
  productLimitOverride: number | null;
  searchLimitOverride: number | null;
  vectorUpdateLimitOverride: number | null;
  searchCount: number | null;
  vectorUpdateCount: number | null;
  productEmbeddingCount: number | null;
  queryEmbeddingCount: number | null;
  fallbackCount: number | null;
  indexedProducts: number | bigint | string | null;
  searchGrant: number | bigint | string | null;
  productGrant: number | bigint | string | null;
  vectorGrant: number | bigint | string | null;
};

type ApiByShopRow = {
  shop: string | null;
  inputTokens: number | bigint | string | null;
  outputTokens: number | bigint | string | null;
  totalTokens: number | bigint | string | null;
  costMicros: number | bigint | string | null;
};

type ProviderSummaryRow = {
  inputTokens: number | bigint | string | null;
  outputTokens: number | bigint | string | null;
  totalTokens: number | bigint | string | null;
  embeddingTokens: number | bigint | string | null;
  llmTokens: number | bigint | string | null;
  costMicros: number | bigint | string | null;
  searchCostMicros: number | bigint | string | null;
  indexingCostMicros: number | bigint | string | null;
};

type RateRow = {
  model: string;
  operation: string;
  remainingRequests: number | null;
  remainingTokens: number | null;
  resetRequests: string | null;
  resetTokens: string | null;
  createdAt: Date | string;
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

function effectiveLimits(row: ShopRow): PlanLimits {
  const plan = normalizePlan(row.plan);
  const base = PLAN_DEFINITIONS[plan].limits;
  return {
    productLimit: addGrant(
      applyOverride(base.productLimit, row.productLimitOverride),
      row.productGrant,
    ),
    searchLimit: addGrant(
      applyOverride(base.searchLimit, row.searchLimitOverride),
      row.searchGrant,
    ),
    vectorUpdateLimit: addGrant(
      applyOverride(base.vectorUpdateLimit, row.vectorUpdateLimitOverride),
      row.vectorGrant,
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

export async function getDevDashboardData(search = "") {
  const now = new Date();
  const from = monthStartUtc(now);

  const [shopRows, apiByShop, providerRows, latestRate, recentGrants, recentAudit, searchCountRows] =
    await Promise.all([
      db.$queryRaw<ShopRow[]>`
        SELECT
          s.\`shop\`,
          s.\`status\` AS \`lifecycleStatus\`,
          sub.\`plan\`,
          sub.\`status\` AS \`subscriptionStatus\`,
          sub.\`billingPeriodStart\`,
          sub.\`billingPeriodEnd\`,
          st.\`aiSearchEnabled\`,
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
              AND p.\`status\` = 'INDEXED'
              AND p.\`hasVector\` = TRUE
          ) AS \`indexedProducts\`,
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
          \`shop\`,
          COALESCE(SUM(\`inputTokens\`), 0) AS \`inputTokens\`,
          COALESCE(SUM(\`outputTokens\`), 0) AS \`outputTokens\`,
          COALESCE(SUM(\`totalTokens\`), 0) AS \`totalTokens\`,
          COALESCE(SUM(\`estimatedCostMicros\`), 0) AS \`costMicros\`
        FROM \`AiSearchApiUsageEvent\`
        WHERE \`createdAt\` >= ${from} AND \`shop\` IS NOT NULL
        GROUP BY \`shop\`
      `,
      db.$queryRaw<ProviderSummaryRow[]>`
        SELECT
          COALESCE(SUM(\`inputTokens\`), 0) AS \`inputTokens\`,
          COALESCE(SUM(\`outputTokens\`), 0) AS \`outputTokens\`,
          COALESCE(SUM(\`totalTokens\`), 0) AS \`totalTokens\`,
          COALESCE(SUM(
            CASE
              WHEN \`operation\` IN ('QUERY_EMBEDDING', 'PRODUCT_EMBEDDING', 'EMBEDDING')
              THEN \`inputTokens\` ELSE 0
            END
          ), 0) AS \`embeddingTokens\`,
          COALESCE(SUM(
            CASE
              WHEN \`operation\` IN ('QUERY_REWRITE', 'PRODUCT_ENRICHMENT')
              THEN \`totalTokens\` ELSE 0
            END
          ), 0) AS \`llmTokens\`,
          COALESCE(SUM(\`estimatedCostMicros\`), 0) AS \`costMicros\`,
          COALESCE(SUM(
            CASE
              WHEN \`operation\` IN ('QUERY_REWRITE', 'QUERY_EMBEDDING')
              THEN \`estimatedCostMicros\` ELSE 0
            END
          ), 0) AS \`searchCostMicros\`,
          COALESCE(SUM(
            CASE
              WHEN \`operation\` IN ('PRODUCT_ENRICHMENT', 'PRODUCT_EMBEDDING')
              THEN \`estimatedCostMicros\` ELSE 0
            END
          ), 0) AS \`indexingCostMicros\`
        FROM \`AiSearchApiUsageEvent\`
        WHERE \`createdAt\` >= ${from}
      `,
      db.$queryRaw<RateRow[]>`
        SELECT
          \`model\`,
          \`operation\`,
          \`remainingRequests\`,
          \`remainingTokens\`,
          \`resetRequests\`,
          \`resetTokens\`,
          \`createdAt\`
        FROM \`AiSearchApiUsageEvent\`
        WHERE
          \`provider\` = 'OPENAI'
          AND (\`remainingTokens\` IS NOT NULL OR \`remainingRequests\` IS NOT NULL)
        ORDER BY \`id\` DESC
        LIMIT 1
      `,
      db.aiSearchQuotaGrant.findMany({
        orderBy: { createdAt: "desc" },
        take: 30,
      }),
      db.aiSearchAdminAuditLog.findMany({
        orderBy: { createdAt: "desc" },
        take: 30,
      }),
      db.$queryRaw<Array<{ count: number | bigint | string }>>`
        SELECT COUNT(*) AS \`count\`
        FROM \`AiSearchQueryLog\`
        WHERE \`createdAt\` >= ${from}
      `,
    ]);

  const apiMap = new Map(
    apiByShop
      .filter((row): row is ApiByShopRow & { shop: string } => Boolean(row.shop))
      .map((row) => [row.shop, row]),
  );

  const needle = search.trim().toLowerCase();
  const shops = shopRows
    .filter((row) => !needle || row.shop.toLowerCase().includes(needle))
    .map((row) => {
      const plan = normalizePlan(row.plan);
      const api = apiMap.get(row.shop);
      return {
        shop: row.shop,
        lifecycleStatus: row.lifecycleStatus,
        plan,
        planLabel: PLAN_DEFINITIONS[plan].label,
        subscriptionStatus: row.subscriptionStatus ?? "UNKNOWN",
        billingPeriodStart: row.billingPeriodStart,
        billingPeriodEnd: row.billingPeriodEnd,
        aiSearchEnabled: Boolean(row.aiSearchEnabled),
        limits: effectiveLimits(row),
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
          searchCount: n(row.searchCount),
          vectorUpdateCount: n(row.vectorUpdateCount),
          productEmbeddingCount: n(row.productEmbeddingCount),
          queryEmbeddingCount: n(row.queryEmbeddingCount),
          fallbackCount: n(row.fallbackCount),
        },
        api: {
          inputTokens: n(api?.inputTokens),
          outputTokens: n(api?.outputTokens),
          totalTokens: n(api?.totalTokens),
          costUsd: n(api?.costMicros) / 1_000_000,
        },
      };
    });

  const provider = providerRows[0] ?? {
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
  const avgSearchCostUsd = mtdSearches > 0 ? searchCostUsd / mtdSearches : null;
  const remainingBudgetUsd =
    configuredBudget === null
      ? null
      : Math.max(0, configuredBudget - totalCostUsd);

  return {
    generatedAt: now.toISOString(),
    monthStart: from.toISOString(),
    query: search,
    provider: {
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
      latestRate: latestRate[0]
        ? {
            ...latestRate[0],
            createdAt: new Date(latestRate[0].createdAt).toISOString(),
          }
        : null,
    },
    shops,
    recentGrants: recentGrants.map((grant) => ({
      ...grant,
      startsAt: grant.startsAt.toISOString(),
      expiresAt: grant.expiresAt?.toISOString() ?? null,
      revokedAt: grant.revokedAt?.toISOString() ?? null,
      createdAt: grant.createdAt.toISOString(),
    })),
    recentAudit: recentAudit.map((item) => ({
      ...item,
      createdAt: item.createdAt.toISOString(),
    })),
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

  const subscription = await db.aiSearchSubscription.findUnique({
    where: { shop },
    select: { billingPeriodEnd: true },
  });
  if (
    subscription?.billingPeriodEnd &&
    subscription.billingPeriodEnd.getTime() > Date.now()
  ) {
    return subscription.billingPeriodEnd;
  }
  return new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
}
