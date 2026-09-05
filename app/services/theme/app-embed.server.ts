import { getActiveTheme, getThemeFile, type ActiveTheme } from "./theme-reader.server";
import { parseShopifyThemeJson } from "./theme-settings-resolver.server";

export const DEFAULT_AI_SEARCH_APP_EMBED_BLOCK_HANDLE = "ai_search_bridge";

export function getAiSearchAppEmbedBlockHandle() {
  const configured = process.env.AI_SEARCH_APP_EMBED_BLOCK_HANDLE?.trim();
  if (!configured) return DEFAULT_AI_SEARCH_APP_EMBED_BLOCK_HANDLE;

  // Theme extension handles are filename-like identifiers. Reject path/query
  // characters so a misconfigured environment value cannot corrupt the Theme
  // Editor deep link or the settings-data marker search.
  return /^[A-Za-z0-9_-]+$/.test(configured)
    ? configured
    : DEFAULT_AI_SEARCH_APP_EMBED_BLOCK_HANDLE;
}

type AdminGraphqlClient = {
  graphql: (
    query: string,
    options?: {
      variables?: Record<string, unknown>;
    },
  ) => Promise<Response>;
};

type ThemeSettingsData = {
  current?: unknown;
  presets?: unknown;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function findAppEmbedBlock(value: unknown): {
  found: boolean;
  enabled: boolean;
} {
  // `settings_data.json` should contain a single app-embed entry, but themes
  // can carry stale/duplicated settings while being edited or migrated. Scan
  // the full tree and treat the embed as enabled if ANY matching entry is
  // enabled instead of trusting whichever duplicate happens to appear first.
  let found = false;
  let enabled = false;

  const visit = (node: unknown) => {
    if (enabled) return;

    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }

    if (!isObject(node)) return;

    const type = typeof node.type === "string" ? node.type : "";
    const normalizedType = type.toLowerCase();
    const marker = `/blocks/${getAiSearchAppEmbedBlockHandle().toLowerCase()}/`;

    if (normalizedType.includes(marker)) {
      found = true;
      if (node.disabled !== true) {
        enabled = true;
        return;
      }
    }

    for (const nested of Object.values(node)) visit(nested);
  };

  visit(value);
  return { found, enabled };
}


export function getThemeAppEmbedDeepLink(shop: string) {
  const apiKey = process.env.SHOPIFY_API_KEY?.trim();

  if (!apiKey) return null;

  const cleanShop = shop
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/$/, "");
  if (!cleanShop.endsWith(".myshopify.com")) return null;

  const activateAppId = `${encodeURIComponent(apiKey)}/${encodeURIComponent(
    getAiSearchAppEmbedBlockHandle(),
  )}`;

  return `https://${cleanShop}/admin/themes/current/editor?context=apps&template=index&activateAppId=${activateAppId}`;
}

export async function getAiSearchAppEmbedStatusForTheme(
  admin: AdminGraphqlClient,
  theme: ActiveTheme,
) {
  try {
    const settingsFile = await getThemeFile(
      admin,
      theme.id,
      "config/settings_data.json",
    );

    if (!settingsFile) {
      return {
        enabled: null as boolean | null,
        themeId: theme.id,
        themeUpdatedAt: theme.updatedAt,
        themeName: theme.name,
        reason: "THEME_SETTINGS_NOT_READABLE",
      };
    }

    const parsed = parseShopifyThemeJson<ThemeSettingsData>(
      settingsFile.content,
    );
    const match = findAppEmbedBlock(parsed.current ?? parsed);

    return {
      enabled: match.found ? match.enabled : false,
      themeId: theme.id,
      themeUpdatedAt: theme.updatedAt,
      themeName: theme.name,
      reason: match.found
        ? match.enabled
          ? "ENABLED"
          : "DISABLED"
        : "NOT_INSTALLED_IN_THEME_SETTINGS",
    };
  } catch (error) {
    console.error("[AI Search] App embed status check failed:", {
      themeId: theme.id,
      error: error instanceof Error ? error.message : String(error),
    });

    return {
      enabled: null as boolean | null,
      themeId: theme.id,
      themeUpdatedAt: theme.updatedAt,
      themeName: theme.name,
      reason: "STATUS_CHECK_FAILED",
    };
  }
}

export async function getAiSearchAppEmbedStatus(admin: AdminGraphqlClient) {
  try {
    const theme = await getActiveTheme(admin);
    return getAiSearchAppEmbedStatusForTheme(admin, theme);
  } catch (error) {
    console.error("[AI Search] Active theme read for App Embed failed:", {
      error: error instanceof Error ? error.message : String(error),
    });

    return {
      enabled: null as boolean | null,
      themeId: null as string | null,
      themeUpdatedAt: null as string | null,
      themeName: null as string | null,
      reason: "STATUS_CHECK_FAILED",
    };
  }
}
