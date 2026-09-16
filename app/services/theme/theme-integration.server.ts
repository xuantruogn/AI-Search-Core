// app/services/theme/theme-integration.server.ts

import { getActiveTheme } from "./theme-reader.server";
import { getAiSearchAppEmbedStatusForTheme } from "./app-embed.server";
import { loadStoredThemeMapV4 } from "./theme-map-v4-store.server";
import type { ThemeMapV4 } from "./theme-map-v4.types";
import type { AdminGraphqlClient } from "./theme-map-v4-shopify.server";

export type ThemeIntegrationStatus =
  | "READY"
  | "EMBED_DISABLED"
  | "EMBED_UNKNOWN"
  | "THEME_MAP_UNAVAILABLE"
  | "THEME_PROCESSING"
  | "ERROR";

/**
 * Compatibility view tạm thời.
 *
 * app._index.tsx / app.settings.tsx cũ vẫn có thể đang đọc:
 *
 *   themeMap.search.searchTemplate
 *   themeMap.sources.length
 *
 * V4 dùng:
 *
 *   themeMap.search.templateFile
 *   themeMap.dependencies
 *
 * Ta cung cấp alias tạm thời để có thể retire V3 từng bước
 * mà không buộc phải sửa nhiều route trong cùng một lần.
 *
 * Sau khi các route Admin chuyển hoàn toàn sang V4,
 * helper này có thể bỏ.
 */
function buildThemeMapCompatibilityView(
  map: ThemeMapV4,
) {
  return {
    ...map,

    search: {
      ...map.search,

      /**
       * Legacy Admin UI alias.
       * Không phải dữ liệu V3.
       */
      searchTemplate:
        map.search.templateFile,
    },

    /**
     * Legacy Admin UI alias.
     *
     * V4 dependencies là nguồn thật.
     */
    sources:
      map.dependencies.map(
        (dependency) => ({
          filename:
            dependency.filename,

          digest:
            dependency.checksum,
        }),
      ),
  };
}

/**
 * Trạng thái tích hợp theme cho Admin.
 *
 * QUAN TRỌNG:
 *
 * Hàm này KHÔNG compile Theme Map.
 * Hàm này KHÔNG đọc source Liquid.
 * Hàm này KHÔNG scan dependency.
 *
 * Nó chỉ:
 *
 * 1. đọc MAIN theme hiện tại;
 * 2. đọc trạng thái App Embed;
 * 3. đọc Theme Map V4 đã persist trong DB.
 *
 * Rebuild/compile Theme Map chỉ được thực hiện bởi
 * explicit sync flow:
 *
 *   rebuildActiveThemeMapV4(...)
 *
 * Nhờ vậy mở Admin không còn vô tình chạy compiler.
 */
export async function getThemeIntegrationStatus({
  admin,
  shop,
}: {
  admin: AdminGraphqlClient;
  shop: string;
}) {
  let lastTheme:
    Awaited<
      ReturnType<
        typeof getActiveTheme
      >
    > | null =
    null;

  try {
    /**
     * Retry nhỏ chỉ để chống trường hợp merchant publish
     * theme mới đúng lúc status đang được đọc.
     *
     * Không có compiler trong vòng lặp này.
     */
    for (
      let attempt = 0;
      attempt < 3;
      attempt += 1
    ) {
      const theme =
        await getActiveTheme(
          admin,
        );

      lastTheme =
        theme;

      if (
        theme.processing ||
        theme.processingFailed
      ) {
        return {
          status:
            "THEME_PROCESSING" as const,

          theme,

          appEmbed: {
            enabled:
              null as boolean | null,

            themeId:
              theme.id,

            themeUpdatedAt:
              theme.updatedAt,

            themeName:
              theme.name,

            reason:
              "THEME_PROCESSING",
          },

          themeMapReady:
            false,

          themeMap:
            null,

          themeMapSource:
            null as string | null,

          themeMapError:
            "Active theme is still processing or failed processing",
        };
      }

      /**
       * Hai thao tác độc lập:
       *
       * - App Embed: Shopify
       * - Theme Map V4: local persistent DB
       *
       * Không tải source theme.
       */
      const [
        appEmbed,
        storedMapResult,
      ] =
        await Promise.all([
          getAiSearchAppEmbedStatusForTheme(
            admin,
            theme,
          ),

          loadStoredThemeMapV4({
            shop,

            /**
             * Store tự normalize:
             *
             * gid://shopify/OnlineStoreTheme/123
             * →
             * 123
             */
            themeId:
              theme.id,
          })
            .then(
              (stored) => ({
                stored,

                error:
                  null as
                    | string
                    | null,
              }),
            )
            .catch(
              (error) => ({
                stored:
                  null,

                error:
                  error instanceof
                  Error
                    ? error.message
                    : String(
                        error,
                      ),
              }),
            ),
        ]);

      /**
       * Active theme có thể đổi trong khi Promise.all đang chạy.
       *
       * Chỉ xác nhận identity/snapshot.
       * Không compile.
       */
      const confirmedTheme =
        await getActiveTheme(
          admin,
        );

      if (
        confirmedTheme.versionKey !==
        theme.versionKey
      ) {
        lastTheme =
          confirmedTheme;

        continue;
      }

      const map =
        storedMapResult
          .stored
          ?.map ??
        null;

      /**
       * V4 có thể persist cả:
       *
       * VERIFIED
       * UNSUPPORTED
       *
       * Có map trong DB không đồng nghĩa renderer dùng được.
       */
      const themeMapReady =
        map?.status ===
        "VERIFIED";

      let status:
        ThemeIntegrationStatus;

      if (
        appEmbed.enabled ===
        null
      ) {
        status =
          "EMBED_UNKNOWN";
      } else if (
        appEmbed.enabled ===
        false
      ) {
        status =
          "EMBED_DISABLED";
      } else if (
        !themeMapReady
      ) {
        status =
          "THEME_MAP_UNAVAILABLE";
      } else {
        status =
          "READY";
      }

      let themeMapError:
        string | null =
        storedMapResult.error;

      if (
        !themeMapError &&
        !map
      ) {
        themeMapError =
          "THEME_MAP_V4_NOT_SYNCED";
      }

      if (
        !themeMapError &&
        map?.status ===
          "UNSUPPORTED"
      ) {
        themeMapError =
          map.unsupportedReason;
      }

      const themeMapSource =
        map?.search
          .sectionFile ??
        map?.search
          .templateFile ??
        null;

      return {
        status,

        theme,

        appEmbed,

        themeMapReady,

        /**
         * Đây vẫn là Theme Map V4.
         *
         * Chỉ thêm 2 alias compatibility:
         *
         * search.searchTemplate
         * sources
         */
        themeMap:
          map
            ? buildThemeMapCompatibilityView(
                map,
              )
            : null,

        themeMapSource,

        themeMapError,
      };
    }

    throw new Error(
      "Active MAIN theme did not stabilize during integration check",
    );
  } catch (error) {
    return {
      status:
        "ERROR" as const,

      theme:
        lastTheme,

      appEmbed: {
        enabled:
          null as boolean | null,

        themeId:
          lastTheme?.id ??
          null,

        themeUpdatedAt:
          lastTheme
            ?.updatedAt ??
          null,

        themeName:
          lastTheme?.name ??
          null,

        reason:
          "STATUS_CHECK_FAILED",
      },

      themeMapReady:
        false,

      themeMap:
        null,

      themeMapSource:
        null as string | null,

      themeMapError:
        error instanceof
        Error
          ? error.message
          : String(error),
    };
  }
}