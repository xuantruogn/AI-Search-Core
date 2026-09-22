import db from "../../db.server";
import { deleteShopLeaseLocks } from "./lease-lock.server";
import {
  AI_SEARCH_PLAN,
  getDevPlanOverride,
  hasExplicitDevPlanOverride,
} from "./plans.server";
import type {
  ShopSettingsSnapshot,
  SubscriptionSnapshot,
} from "./types.server";

type AdminGraphqlClient = {
  graphql: (
    query: string,
    options?: {
      variables?: Record<string, unknown>;
    },
  ) => Promise<Response>;
};

type SubscriptionRow = {
  shop: string;
  plan: string;
  status: string;
  planHandle: string | null;
  shopifySubscriptionId: string | null;
  billingPeriodStart: Date | string | null;
  billingPeriodEnd: Date | string | null;
  source: string;
  lastSyncedAt: Date | string | null;
};

type SettingsRow = {
  searchLanguage: string | null;
  shop: string;
  aiSearchEnabled: boolean | number;
  fallbackEnabled: boolean | number;
  customDataModeEnabled?: boolean | number;
  productLimitOverride: number | null;
  searchLimitOverride: number | null;
  vectorUpdateLimitOverride: number | null;
  resultLimit: number;
};

type ShopBaseRow = {
  shop: string;
  status: string;
  shopifyShopId: string | null;
  hasSettings: number | bigint;
  hasSubscription: number | bigint;
};

const shopBootstrapGlobal = globalThis as typeof globalThis & {
  aiSearchShopBootstrapPromises?: Map<string, Promise<ShopBaseRow>>;
};

const shopBootstrapPromises =
  shopBootstrapGlobal.aiSearchShopBootstrapPromises ??
  (shopBootstrapGlobal.aiSearchShopBootstrapPromises = new Map());

async function ensureBaseShopRows(
  cleanShop: string,
  initialShopifyShopId?: string | null,
): Promise<ShopBaseRow> {
  const existingPromise = shopBootstrapPromises.get(cleanShop);
  if (existingPromise) return existingPromise;

  const task = (async () => {
    const readBase = async () => {
      const rows = await db.$queryRaw<ShopBaseRow[]>`
        SELECT
          s.\`shop\`, s.\`status\`, s.\`shopifyShopId\`,
          EXISTS(
            SELECT 1 FROM \`AiSearchShopSettings\` st WHERE st.\`shop\` = s.\`shop\`
          ) AS \`hasSettings\`,
          EXISTS(
            SELECT 1 FROM \`AiSearchSubscription\` sub WHERE sub.\`shop\` = s.\`shop\`
          ) AS \`hasSubscription\`
        FROM \`AiSearchShop\` s
        WHERE s.\`shop\` = ${cleanShop}
        LIMIT 1
      `;
      return rows[0] ?? null;
    };

    let row = await readBase();

    if (!row || !row.hasSettings || !row.hasSubscription) {
      // Duplicate-key no-ops preserve existing settings during concurrent
      // bootstrap without hiding foreign-key or invalid-data errors.
      await db.$transaction(async (tx) => {
        await tx.$executeRaw`
          INSERT INTO \`AiSearchShop\` (
            \`shop\`, \`shopifyShopId\`, \`status\`, \`installedAt\`, \`createdAt\`, \`updatedAt\`
          ) VALUES (
            ${cleanShop}, ${initialShopifyShopId ?? null}, 'ACTIVE', UTC_TIMESTAMP(3), UTC_TIMESTAMP(3), UTC_TIMESTAMP(3)
          )
          ON DUPLICATE KEY UPDATE \`shop\` = \`shop\`
        `;

        await tx.$executeRaw`
          INSERT INTO \`AiSearchShopSettings\` (
            \`shop\`, \`aiSearchEnabled\`, \`fallbackEnabled\`, \`resultLimit\`, \`createdAt\`, \`updatedAt\`
          ) VALUES (
            ${cleanShop}, true, true, 20, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3)
          )
          ON DUPLICATE KEY UPDATE \`shop\` = \`shop\`
        `;

        await tx.$executeRaw`
          INSERT INTO \`AiSearchSubscription\` (
            \`shop\`, \`plan\`, \`status\`, \`source\`, \`createdAt\`, \`updatedAt\`
          ) VALUES (
            ${cleanShop}, 'NONE', 'INACTIVE', 'LOCAL', UTC_TIMESTAMP(3), UTC_TIMESTAMP(3)
          )
          ON DUPLICATE KEY UPDATE \`shop\` = \`shop\`
        `;
      });

      row = await readBase();
    }

    if (!row) {
      throw new Error(
        `Unable to bootstrap AI Search shop rows for ${cleanShop}`,
      );
    }

    return row;
  })();

  shopBootstrapPromises.set(cleanShop, task);

  try {
    return await task;
  } finally {
    if (shopBootstrapPromises.get(cleanShop) === task) {
      shopBootstrapPromises.delete(cleanShop);
    }
  }
}

function asDate(value: Date | string | null): Date | null {
  if (!value) {
    return null;
  }

  return value instanceof Date ? value : new Date(value);
}

export async function fetchShopIdentity(admin: AdminGraphqlClient) {
  const response = await admin.graphql(`#graphql
    query AiSearchShopIdentity {
      shop {
        id
        myshopifyDomain
      }
    }
  `);

  const payload = (await response.json()) as {
    data?: {
      shop?: {
        id?: string;
        myshopifyDomain?: string;
      };
    };
    errors?: Array<{ message?: string }>;
  };

  if (!response.ok || payload.errors?.length) {
    throw new Error(
      payload.errors
        ?.map((error) => error.message)
        .filter(Boolean)
        .join("; ") ||
        `Unable to fetch Shopify shop identity (${response.status})`,
    );
  }

  const id = payload.data?.shop?.id;
  const myshopifyDomain = payload.data?.shop?.myshopifyDomain;

  if (!id || !myshopifyDomain) {
    throw new Error("Shopify shop identity is incomplete");
  }

  return {
    id,
    myshopifyDomain,
  };
}

export async function ensureShopRecord({
  shop,
  shopifyShopId,
  reactivate = false,
}: {
  shop: string;
  shopifyShopId?: string | null;
  reactivate?: boolean;
}) {
  const cleanShop = shop.trim();

  if (!cleanShop) {
    throw new Error("Shop cannot be empty");
  }

  const existing = await ensureBaseShopRows(cleanShop, shopifyShopId);

  if (reactivate) {
    // Reactivation only happens after authenticated Admin access, so this is
    // the one place where an UNINSTALLED shop is intentionally made ACTIVE.
    await db.$executeRaw`
      UPDATE \`AiSearchShop\`
      SET
        \`shopifyShopId\` = COALESCE(${shopifyShopId ?? null}, \`shopifyShopId\`),
        \`status\` = 'ACTIVE',
        \`uninstalledAt\` = NULL,
        \`updatedAt\` = UTC_TIMESTAMP(3)
      WHERE \`shop\` = ${cleanShop}
    `;
  } else if (
    shopifyShopId &&
    existing.status === "ACTIVE" &&
    existing.shopifyShopId !== shopifyShopId
  ) {
    // Background/non-authenticated reads must never reactivate an uninstalled
    // tenant. They may refresh the provider ID only while the shop is active.
    await db.$executeRaw`
      UPDATE \`AiSearchShop\`
      SET \`shopifyShopId\` = ${shopifyShopId}, \`updatedAt\` = UTC_TIMESTAMP(3)
      WHERE \`shop\` = ${cleanShop} AND \`status\` = 'ACTIVE'
    `;
  }

  const devPlan = getDevPlanOverride();

  if (devPlan) {
    const explicitOverride = hasExplicitDevPlanOverride();
    const devStatus = devPlan === AI_SEARCH_PLAN.none ? "INACTIVE" : "ACTIVE";

    if (explicitOverride) {
      await db.$executeRaw`
        UPDATE \`AiSearchSubscription\`
        SET
          \`plan\` = ${devPlan},
          \`status\` = ${devStatus},
          \`source\` = 'DEV_OVERRIDE',
          \`lastSyncedAt\` = UTC_TIMESTAMP(3),
          \`updatedAt\` = UTC_TIMESTAMP(3)
        WHERE
          \`shop\` = ${cleanShop}
          AND (
            \`plan\` <> ${devPlan}
            OR \`status\` <> ${devStatus}
            OR \`source\` <> 'DEV_OVERRIDE'
          )
          AND EXISTS (
            SELECT 1 FROM \`AiSearchShop\`
            WHERE \`shop\` = ${cleanShop} AND \`status\` = 'ACTIVE'
          )
      `;
    } else {
      await db.$executeRaw`
        UPDATE \`AiSearchSubscription\`
        SET
          \`plan\` = ${devPlan},
          \`status\` = ${devStatus},
          \`source\` = 'DEV_OVERRIDE',
          \`lastSyncedAt\` = UTC_TIMESTAMP(3),
          \`updatedAt\` = UTC_TIMESTAMP(3)
        WHERE
          \`shop\` = ${cleanShop}
          AND \`source\` IN ('LOCAL', 'DEV_OVERRIDE')
          AND (
            \`plan\` <> ${devPlan}
            OR \`status\` <> ${devStatus}
            OR \`source\` <> 'DEV_OVERRIDE'
          )
          AND EXISTS (
            SELECT 1 FROM \`AiSearchShop\`
            WHERE \`shop\` = ${cleanShop} AND \`status\` = 'ACTIVE'
          )
      `;
    }
  }
}

export async function ensureShopFromAdmin({
  shop,
  admin,
}: {
  shop: string;
  admin: AdminGraphqlClient;
}) {
  const identity = await fetchShopIdentity(admin);

  await ensureShopRecord({
    shop,
    shopifyShopId: identity.id,
    reactivate: true,
  });

  return identity;
}

export async function getShopLifecycleStatus(
  shop: string,
  options?: { ensure?: boolean },
) {
  if (options?.ensure !== false) await ensureShopRecord({ shop });
  const rows = await db.$queryRaw<Array<{ status: string }>>`
    SELECT \`status\`
    FROM \`AiSearchShop\`
    WHERE \`shop\` = ${shop}
    LIMIT 1
  `;
  return rows[0]?.status ?? "UNKNOWN";
}

export async function ensureShopForBackgroundWork(shop: string) {
  const lifecycle = await getShopLifecycleStatus(shop, { ensure: false });

  if (lifecycle === "ACTIVE") return true;
  if (lifecycle === "UNINSTALLED") return false;

  // A newly-installed shop can receive product webhooks before the merchant
  // opens the embedded app for the first time. Bootstrap only when a valid
  // Shopify session still exists. After uninstall/shop-redact sessions are
  // deleted first, so delayed background jobs cannot recreate erased tenants.
  const session = await db.session.findFirst({
    where: { shop },
    select: { id: true },
  });

  if (!session) return false;

  await ensureShopRecord({ shop });
  return (await getShopLifecycleStatus(shop, { ensure: false })) === "ACTIVE";
}

export async function getSubscriptionSnapshot(
  shop: string,
  options?: { ensure?: boolean },
): Promise<SubscriptionSnapshot> {
  if (options?.ensure !== false) await ensureShopRecord({ shop });

  const rows = await db.$queryRaw<SubscriptionRow[]>`
    SELECT
      \`shop\`,
      \`plan\`,
      \`status\`,
      \`planHandle\`,
      \`shopifySubscriptionId\`,
      \`billingPeriodStart\`,
      \`billingPeriodEnd\`,
      \`source\`,
      \`lastSyncedAt\`
    FROM \`AiSearchSubscription\`
    WHERE \`shop\` = ${shop}
    LIMIT 1
  `;

  const row = rows[0];

  if (!row) {
    throw new Error(`AI Search subscription missing for ${shop}`);
  }

  const plan =
    row.plan === AI_SEARCH_PLAN.basic || row.plan === AI_SEARCH_PLAN.pro
      ? row.plan
      : AI_SEARCH_PLAN.none;

  return {
    shop: row.shop,
    plan,
    status: row.status,
    planHandle: row.planHandle,
    shopifySubscriptionId: row.shopifySubscriptionId,
    billingPeriodStart: asDate(row.billingPeriodStart),
    billingPeriodEnd: asDate(row.billingPeriodEnd),
    source: row.source,
    lastSyncedAt: asDate(row.lastSyncedAt),
  };
}

export async function getShopSettings(
  shop: string,
  options?: { ensure?: boolean },
): Promise<ShopSettingsSnapshot> {
  if (options?.ensure !== false) await ensureShopRecord({ shop });

  const rows = await db.$queryRaw<SettingsRow[]>`
    SELECT
      \`shop\`,
      \`aiSearchEnabled\`,
      \`customDataModeEnabled\`,
      \`searchLanguage\`,
      \`fallbackEnabled\`,
      \`productLimitOverride\`,
      \`searchLimitOverride\`,
      \`vectorUpdateLimitOverride\`,
      \`resultLimit\`
    FROM \`AiSearchShopSettings\`
    WHERE \`shop\` = ${shop}
    LIMIT 1
  `;

  const row = rows[0];

  if (!row) {
    throw new Error(`AI Search shop settings missing for ${shop}`);
  }

  return {
    shop: row.shop,
    aiSearchEnabled: Boolean(row.aiSearchEnabled),
    searchLanguage: row.searchLanguage,
    customDataModeEnabled: Boolean(row.customDataModeEnabled ?? false),
    fallbackEnabled: Boolean(row.fallbackEnabled),
    productLimitOverride: row.productLimitOverride,
    searchLimitOverride: row.searchLimitOverride,
    vectorUpdateLimitOverride: row.vectorUpdateLimitOverride,
    resultLimit: Math.max(1, Math.min(row.resultLimit || 20, 20)),
  };
}

export async function updateShopSettings({
  searchLanguage,
  shop,
  aiSearchEnabled,
  customDataModeEnabled,
  resultLimit,
}: {
  shop: string;
  aiSearchEnabled: boolean;
  customDataModeEnabled?: boolean;
  resultLimit: number;
  searchLanguage?: string | null;
}) {
  await ensureShopRecord({ shop });

  const safeLimit = Math.max(1, Math.min(Math.trunc(resultLimit), 20));

  await db.$executeRaw`
    UPDATE \`AiSearchShopSettings\`
    SET
      \`aiSearchEnabled\` = ${aiSearchEnabled},
      \`customDataModeEnabled\` = COALESCE(${customDataModeEnabled ?? null}, \`customDataModeEnabled\`),
      \`fallbackEnabled\` = true,
      \`resultLimit\` = ${safeLimit},
      \`searchLanguage\` = COALESCE(${searchLanguage ?? null}, \`searchLanguage\`),
      \`updatedAt\` = UTC_TIMESTAMP(3)
    WHERE \`shop\` = ${shop}
  `;
}

export async function markShopUninstalled(shop: string) {
  // Never bootstrap a missing tenant during uninstall. A delayed/retried
  // webhook after shop/redact must not recreate data that was already erased.
  await db.$transaction([
    db.$executeRaw`
      UPDATE \`AiSearchShop\`
      SET
        \`status\` = 'UNINSTALLED',
        \`uninstalledAt\` = UTC_TIMESTAMP(3),
        \`updatedAt\` = UTC_TIMESTAMP(3)
      WHERE \`shop\` = ${shop}
    `,
    db.$executeRaw`
      UPDATE \`AiSearchSubscription\`
      SET
        \`status\` = 'INACTIVE',
        \`updatedAt\` = UTC_TIMESTAMP(3)
      WHERE \`shop\` = ${shop}
    `,
    db.$executeRaw`
      UPDATE \`AiSearchSyncJob\`
      SET
        \`status\` = 'CANCELLED',
        \`lastError\` = 'SHOP_UNINSTALLED',
        \`processedAt\` = UTC_TIMESTAMP(3),
        \`updatedAt\` = UTC_TIMESTAMP(3)
      WHERE \`shop\` = ${shop} AND \`status\` IN ('PENDING', 'PROCESSING', 'FAILED')
    `,
    db.$executeRaw`
      UPDATE \`AiSearchCatalogSyncJob\`
      SET
        \`status\` = 'CANCELLED',
        \`lastError\` = 'SHOP_UNINSTALLED',
        \`processedAt\` = UTC_TIMESTAMP(3),
        \`updatedAt\` = UTC_TIMESTAMP(3)
      WHERE \`shop\` = ${shop} AND \`status\` IN ('PENDING', 'PROCESSING', 'FAILED')
    `,
  ]);
}

export async function deleteShopCommercialData(shop: string) {
  // Lease locks and AiSearchSyncJob predate / intentionally avoid the
  // AiSearchShop FK, so they are removed explicitly.
  await deleteShopLeaseLocks(shop);

  await db.$transaction([
    db.$executeRaw`
      DELETE FROM \`AiSearchSyncJob\`
      WHERE \`shop\` = ${shop}
    `,
    db.$executeRaw`
      DELETE FROM \`AiSearchShop\`
      WHERE \`shop\` = ${shop}
    `,
  ]);
}

function normalizeQuotaOverride(value: number | null | undefined) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return null;
  }

  const integer = Math.trunc(value);
  return integer < 0 ? null : Math.min(integer, 1_000_000_000);
}

export async function updateShopQuotaOverrides({
  shop,
  productLimitOverride,
  searchLimitOverride,
  vectorUpdateLimitOverride,
}: {
  shop: string;
  productLimitOverride: number | null;
  searchLimitOverride: number | null;
  vectorUpdateLimitOverride: number | null;
}) {
  await ensureShopRecord({ shop });

  const productLimit = normalizeQuotaOverride(productLimitOverride);
  const searchLimit = normalizeQuotaOverride(searchLimitOverride);
  const vectorLimit = normalizeQuotaOverride(vectorUpdateLimitOverride);

  await db.$executeRaw`
    UPDATE \`AiSearchShopSettings\`
    SET
      \`productLimitOverride\` = ${productLimit},
      \`searchLimitOverride\` = ${searchLimit},
      \`vectorUpdateLimitOverride\` = ${vectorLimit},
      \`updatedAt\` = UTC_TIMESTAMP(3)
    WHERE \`shop\` = ${shop}
  `;
}
