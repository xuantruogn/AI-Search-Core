import db from "../../db.server";

import {
  rebuildActiveThemeMapV4,
} from "./theme-map-v4-lifecycle.server";

function normalizeShop(
  shop: string,
): string {
  return shop
    .trim()
    .toLowerCase();
}

/**
 * Initial Theme Map V4 bootstrap.
 *
 * Quy tắc:
 *
 * - Shop chưa từng có Theme Map V4
 *   -> build lần đầu.
 *
 * - Shop đã từng có Theme Map V4
 *   -> SKIP.
 *
 * Hàm này có thể được gọi từ Shopify afterAuth nhiều lần
 * nhưng KHÔNG được rebuild theme sau lần bootstrap đầu tiên.
 *
 * Sau này merchant:
 *
 * - đổi theme
 * - sửa theme
 * - muốn cập nhật Theme Map
 *
 * thì phải chủ động bấm nút "Đồng bộ theme".
 */
export async function syncThemeMapV4AfterInstall(
  args: {
    admin:
      Parameters<
        typeof rebuildActiveThemeMapV4
      >[0]["admin"];

    shop: string;
  },
) {
  const shop =
    normalizeShop(
      args.shop,
    );

  if (!shop) {
    console.warn(
      "[AI Search][Theme Map V4] install sync skipped: invalid shop",
    );

    return null;
  }

  try {
    /**
     * Quan trọng:
     *
     * Kiểm tra theo SHOP chứ không theo active theme.
     *
     * Ví dụ:
     *
     * Install:
     * Ritual -> đã sync.
     *
     * Sau này merchant đổi:
     * Dawn
     *
     * Shopify có re-auth:
     * -> vẫn thấy shop đã có Theme Map
     * -> SKIP
     *
     * Không được tự build Dawn.
     *
     * Merchant phải bấm "Đồng bộ theme".
     */
    const existing =
      await db.aiSearchThemeMapV4.findFirst({
        where: {
          shop,
        },

        select: {
          themeId: true,
          themeName: true,
          mapStatus: true,
          fingerprint: true,
          updatedAt: true,
        },

        orderBy: {
          updatedAt: "desc",
        },
      });

    if (existing) {
      console.log(
        "[AI Search][Theme Map V4] install sync skipped; shop already has Theme Map:",
        {
          shop,

          themeId:
            existing.themeId,

          themeName:
            existing.themeName,

          status:
            existing.mapStatus,

          fingerprint:
            existing.fingerprint,

          updatedAt:
            existing.updatedAt,
        },
      );

      return null;
    }

    /**
     * Chỉ tới đây khi shop CHƯA TỪNG có
     * Theme Map V4.
     *
     * Đây là bootstrap lần đầu.
     */
    const map =
      await rebuildActiveThemeMapV4({
        admin:
          args.admin,

        shop,
      });

    console.log(
      "[AI Search][Theme Map V4] initial install sync completed:",
      {
        shop,

        themeId:
          map.theme.id,

        themeName:
          map.theme.name,

        status:
          map.status,

        fingerprint:
          map.fingerprint,

        unsupportedReason:
          map.status ===
          "UNSUPPORTED"
            ? map.unsupportedReason ??
              null
            : null,
      },
    );

    return map;
  } catch (error) {
    /**
     * Theme sync không được làm hỏng
     * quá trình auth/install của app.
     *
     * Nếu compile lỗi, merchant vẫn có thể
     * vào app và bấm "Đồng bộ theme" sau.
     */
    console.error(
      "[AI Search][Theme Map V4] initial install sync failed:",
      {
        shop,

        error:
          error instanceof Error
            ? error.message
            : String(error),
      },
    );

    return null;
  }
}