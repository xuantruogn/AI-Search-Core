import { getActiveTheme } from "./theme-reader.server";
import { getAiSearchAppEmbedStatusForTheme } from "./app-embed.server";
import {
  getCompiledThemeRenderer,
  invalidateThemeRendererCache,
} from "./theme-renderer-profile.server";

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
  | "RENDERER_UNSUPPORTED"
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
    // App Embed status and renderer discovery use separate Shopify requests.
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
          rendererCompatible: false,
          rendererSource: null as string | null,
          rendererError: "Active theme is still processing or failed processing",
        };
      }

      const [appEmbed, rendererResult] = await Promise.all([
        getAiSearchAppEmbedStatusForTheme(admin, theme),
        getCompiledThemeRenderer({ admin, shop, activeTheme: theme })
          .then((renderer) => ({ renderer, error: null as string | null }))
          .catch((error) => ({
            renderer: null,
            error: error instanceof Error ? error.message : String(error),
          })),
      ]);

      const confirmedTheme = await getActiveTheme(admin);
      const rendererMatchesSnapshot =
        !rendererResult.renderer ||
        rendererResult.renderer.themeVersionKey === theme.versionKey;

      if (
        confirmedTheme.versionKey !== theme.versionKey ||
        !rendererMatchesSnapshot
      ) {
        invalidateThemeRendererCache(shop);
        lastTheme = confirmedTheme;
        continue;
      }

      const rendererCompatible = Boolean(rendererResult.renderer);
      let status: ThemeIntegrationStatus;
      if (appEmbed.enabled === null) status = "EMBED_UNKNOWN";
      else if (appEmbed.enabled === false) status = "EMBED_DISABLED";
      else if (!rendererCompatible) status = "RENDERER_UNSUPPORTED";
      else status = "READY";

      return {
        status,
        theme,
        appEmbed,
        rendererCompatible,
        rendererSource: rendererResult.renderer?.sourceFile ?? null,
        rendererError: rendererResult.error,
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
      rendererCompatible: false,
      rendererSource: null as string | null,
      rendererError: error instanceof Error ? error.message : String(error),
    };
  }
}
