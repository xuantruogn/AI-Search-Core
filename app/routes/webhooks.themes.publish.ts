import type {
  ActionFunctionArgs,
} from "react-router";

import { authenticate } from "../shopify.server";

import {
  invalidateThemeMapV4,
} from "../services/theme/theme-map-v4-lifecycle.server";

export const action = async ({
  request,
}: ActionFunctionArgs) => {
  const {
    shop,
    topic,
    payload,
    webhookId,
  } =
    await authenticate.webhook(
      request,
    );

  const normalizedTopic =
    String(
      topic ?? "",
    )
      .trim()
      .toUpperCase();

  const normalizedRole =
    String(
      payload?.role ?? "",
    )
      .trim()
      .toLowerCase();

  const affectsActiveTheme =
    normalizedTopic ===
      "THEMES_PUBLISH" ||
    normalizedRole ===
      "main" ||
    /**
     * Conservative fallback:
     * nếu payload tương lai không còn role,
     * vẫn invalidate RAM cache V4.
     */
    normalizedRole.length ===
      0;

  /**
   * App Embed vẫn do merchant kiểm soát.
   *
   * Publish theme chỉ invalidate RAM cache V4.
   * Persistent Theme Map V4 trong DB vẫn được giữ.
   *
   * Lần đọc tiếp theo sẽ:
   *
   * - đối chiếu active MAIN theme;
   * - reuse persistent map nếu còn hợp lệ;
   * - hoặc rebuild theo lifecycle V4 khi cần.
   *
   * Không còn Theme Map V3.
   */
  if (affectsActiveTheme) {
    invalidateThemeMapV4(
      shop,
    );
  }

  console.log(
    "[AI Search] Theme lifecycle event received:",
    {
      shop,
      topic,
      webhookId,

      themeId:
        payload?.id ??
        null,

      role:
        payload?.role ??
        null,

      cacheInvalidated:
        affectsActiveTheme,

      themeMapVersion:
        4,
    },
  );

  return new Response(
    "OK",
    {
      status: 200,
    },
  );
};