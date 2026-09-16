import type { AdminGraphqlClient } from "./theme-map-v4-shopify.server";
import { getAiSearchAppEmbedStatusForTheme } from "./app-embed.server";
import { getActiveTheme } from "./theme-reader.server";
import { loadStoredThemeMapV4 } from "./theme-map-v4-store.server";
import type { ThemeMapV4 } from "./theme-map-v4.types";

function hasUsableThemeContextRenderer(map: ThemeMapV4): boolean {
  return map.rendererCandidates.some(
    (candidate) =>
      candidate.renderStrategy === "THEME_CONTEXT_REQUIRED" &&
      candidate.mount != null &&
      candidate.usesAllProducts === false &&
      candidate.rejectionReasons.every(
        (reason) => reason === "THEME_CONTEXT_REQUIRED",
      ),
  );
}

export function isStoredThemeMapV4Usable(map: ThemeMapV4): boolean {
  return map.status === "VERIFIED" || hasUsableThemeContextRenderer(map);
}

/**
 * READ-ONLY integration status.
 *
 * This function is intentionally allowed to READ the current Shopify theme
 * when the merchant opens the app admin UI, but it NEVER compiles, validates,
 * refreshes, or rebuilds Theme Map V4.
 *
 * Theme Map V4 is written only by:
 * 1. the afterAuth install hook;
 * 2. the explicit merchant "Sync current theme" action.
 */
export async function getThemeSyncStatus(args: {
  admin: AdminGraphqlClient;
  shop: string;
}) {
  const activeTheme = await getActiveTheme(args.admin);

  const [appEmbed, stored] = await Promise.all([
    getAiSearchAppEmbedStatusForTheme(args.admin, activeTheme),
    loadStoredThemeMapV4({
      shop: args.shop,
      themeId: activeTheme.id,
    }),
  ]);

  const map = stored?.map ?? null;
  const themeMapReady = map ? isStoredThemeMapV4Usable(map) : false;

  let status: string;

  if (!stored) {
    status = "THEME_SYNC_REQUIRED";
  } else if (!themeMapReady) {
    status = `THEME_MAP_V4_UNSUPPORTED:${map?.unsupportedReason ?? "UNKNOWN"}`;
  } else if (appEmbed.enabled === false) {
    status = "APP_EMBED_DISABLED";
  } else if (appEmbed.enabled !== true) {
    status = "APP_EMBED_STATUS_UNKNOWN";
  } else {
    status = "READY";
  }

  return {
    activeTheme,
    appEmbed,
    themeMap: map,
    themeMapReady,
    themeMapSource: stored ? "STORED_V4" : null,
    status,
    syncedAt: stored?.updatedAt ?? null,
    fingerprint: stored?.fingerprint ?? null,
  };
}