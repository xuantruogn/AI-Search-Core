import { getActiveTheme } from "./theme-reader.server";
import { getAiSearchAppEmbedStatusForTheme } from "./app-embed.server";
import {
  getActiveThemeMap,
  invalidateThemeMap,
} from "./theme-map-lifecycle.server";

type AdminGraphqlClient = {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
};

export type ThemeIntegrationStatus =
  | "READY"
  | "EMBED_DISABLED"
  | "EMBED_UNKNOWN"
  | "THEME_MAP_UNAVAILABLE"
  | "THEME_PROCESSING"
  | "ERROR";

export async function getThemeIntegrationStatus({
  admin,
  shop,
}: {
  admin: AdminGraphqlClient;
  shop: string;
}) {
  let lastTheme: Awaited<ReturnType<typeof getActiveTheme>> | null = null;

  try {
    // App Embed status and map discovery use separate Shopify requests.
    // Retry when MAIN changes between them so the dashboard never reports a
    // hybrid state assembled from two different theme versions.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const theme = await getActiveTheme(admin);
      lastTheme = theme;

      if (theme.processing || theme.processingFailed) {
        return {
          status: "THEME_PROCESSING" as const,
          theme,
          appEmbed: {
            enabled: null as boolean | null,
            themeId: theme.id,
            themeUpdatedAt: theme.updatedAt,
            themeName: theme.name,
            reason: "THEME_PROCESSING",
          },
          themeMapReady: false,
          themeMap: null,
          themeMapSource: null as string | null,
          themeMapError: "Active theme is still processing or failed processing",
        };
      }

      const [appEmbed, mapResult] = await Promise.all([
        getAiSearchAppEmbedStatusForTheme(admin, theme),
        getActiveThemeMap({ admin, shop, activeTheme: theme })
          .then((map) => ({ map, error: null as string | null }))
          .catch((error) => ({
            map: null,
            error: error instanceof Error ? error.message : String(error),
          })),
      ]);

      const confirmedTheme = await getActiveTheme(admin);
      const mapMatchesSnapshot =
        !mapResult.map ||
        mapResult.map.theme.versionKey === theme.versionKey;

      if (
        confirmedTheme.versionKey !== theme.versionKey ||
        !mapMatchesSnapshot
      ) {
        invalidateThemeMap(shop);
        lastTheme = confirmedTheme;
        continue;
      }

      const themeMapReady = Boolean(mapResult.map);
      let status: ThemeIntegrationStatus;
      if (appEmbed.enabled === null) status = "EMBED_UNKNOWN";
      else if (appEmbed.enabled === false) status = "EMBED_DISABLED";
      else if (!themeMapReady) status = "THEME_MAP_UNAVAILABLE";
      else status = "READY";

      return {
        status,
        theme,
        appEmbed,
        themeMapReady,
        themeMap: mapResult.map ?? null,
        themeMapSource: mapResult.map?.search.searchTemplate ?? null,
        themeMapError: mapResult.error,
      };
    }

    throw new Error("Active MAIN theme did not stabilize during integration check");
  } catch (error) {
    return {
      status: "ERROR" as const,
      theme: lastTheme,
      appEmbed: {
        enabled: null as boolean | null,
        themeId: lastTheme?.id ?? null,
        themeUpdatedAt: lastTheme?.updatedAt ?? null,
        themeName: lastTheme?.name ?? null,
        reason: "STATUS_CHECK_FAILED",
      },
      themeMapReady: false,
      themeMap: null,
      themeMapSource: null as string | null,
      themeMapError: error instanceof Error ? error.message : String(error),
    };
  }
}
