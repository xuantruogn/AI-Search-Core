import type { LoaderFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";
import { getShopEntitlement } from "../services/commerce/entitlement.server";
import { getProductSyncQueueStats } from "../services/products/product-sync-job.server";
import { getLatestCatalogSyncJob } from "../services/catalog/catalog-sync-job.server";
import { getThemeIntegrationStatus } from "../services/theme/theme-integration.server";

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim()
    ? value.trim()
    : null;
}

function booleanValue(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function normalizeThemeIntegration(value: unknown) {
  const integration = objectValue(value);
  const appEmbed = objectValue(integration.appEmbed);
  const themeMap = objectValue(integration.themeMap);

  const status =
    stringValue(integration.status) ??
    stringValue(integration.reason) ??
    "UNKNOWN";

  const themeMapReady =
  integration.themeMapReady === true;

  return {
    integrationStatus: status,
    themeMapReady,
    appEmbedEnabled: booleanValue(appEmbed.enabled),
    themeName:
      stringValue(appEmbed.themeName) ??
      stringValue(integration.themeName) ??
      stringValue(themeMap.themeName),
  };
}

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);

  const [entitlement, queue, catalogJob, themeIntegration] =
    await Promise.all([
      getShopEntitlement(session.shop),
      getProductSyncQueueStats(session.shop),
      getLatestCatalogSyncJob(session.shop),
      getThemeIntegrationStatus({
        admin,
        shop: session.shop,
      }),
    ]);

  const catalogStatus =
    (catalogJob?.status ?? "NOT_STARTED").toUpperCase();

  const catalogBusy = [
    "PENDING",
    "PROCESSING",
    "RUNNING",
  ].includes(catalogStatus);

  const catalogFailed =
    catalogStatus === "FAILED" ||
    Boolean(catalogJob?.lastError);

  const queueBusy =
    queue.pending > 0 ||
    queue.processing > 0;

  const catalogReady =
    catalogStatus === "DONE" &&
    !catalogFailed &&
    !queueBusy &&
    queue.failed === 0;

  const aiSearchEnabled = entitlement.aiSearchEnabled;

  const theme = normalizeThemeIntegration(themeIntegration);

  const subscriptionReady =
    entitlement.active === true;

  const aiEngineReady =
    aiSearchEnabled === true;

  const appEmbedReady =
    theme.appEmbedEnabled === true;

  const themeMapReady =
    theme.themeMapReady === true;

  const allReady =
    subscriptionReady &&
    catalogReady &&
    aiEngineReady &&
    appEmbedReady &&
    themeMapReady;

  return Response.json({
    updatedAt: new Date().toISOString(),

    subscription: {
      ready: subscriptionReady,
      status: subscriptionReady
        ? "ACTIVE"
        : "ACTION_NEEDED",
    },

    catalog: {
      ready: catalogReady,
      busy: catalogBusy || queueBusy,
      failed: catalogFailed || queue.failed > 0,
      status: catalogFailed
        ? "FAILED"
        : catalogBusy || queueBusy
          ? "PROCESSING"
          : catalogReady
            ? "DONE"
            : catalogStatus,
      pending: queue.pending,
      processing: queue.processing,
      failedCount: queue.failed,
      productsProcessed:
        catalogJob?.productsProcessed ?? 0,
      productsIndexed:
        catalogJob?.productsIndexed ?? 0,
    },

    aiEngine: {
      ready: aiEngineReady,
      status: aiEngineReady
        ? "ENABLED"
        : "DISABLED",
    },

    appEmbed: {
      ready: appEmbedReady,
      status: appEmbedReady
        ? "ENABLED"
        : "DISABLED",
      themeName: theme.themeName,
    },

    themeMap: {
      ready: themeMapReady,
      status: themeMapReady
        ? "READY"
        : "NEEDS_CHECK",
    },

    allReady,
  });
}