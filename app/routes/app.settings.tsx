import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";

import { authenticate } from "../shopify.server";
import {
  getShopSettings,
  updateShopQuotaOverrides,
  updateShopSettings,
} from "../services/commerce/shop-registry.server";
import { getThemeAppEmbedDeepLink } from "../services/theme/app-embed.server";
import { getThemeSyncStatus } from "../services/theme/theme-sync-status.server";
import { canUseQuotaOverrideUi } from "../services/commerce/support-access.server";
import { rebuildActiveThemeMapV4 } from "../services/theme/theme-map-v4-lifecycle.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const [settings, themeIntegration] = await Promise.all([
    getShopSettings(session.shop),
    getThemeSyncStatus({ admin, shop: session.shop }),
  ]);

  return {
    ...settings,
    appEmbed: themeIntegration.appEmbed,
    themeIntegration,
    appEmbedUrl: getThemeAppEmbedDeepLink(session.shop),
    allowQuotaOverrides: canUseQuotaOverrideUi(session.shop),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const form = await request.formData();

  const intent = String(form.get("intent") || "settings");

  if (intent === "sync_theme_map") {
    try {
      /**
       * Manual sync là nơi DUY NHẤT (ngoài initial install)
       * được phép đọc/rebuild active Shopify theme.
       *
       * Storefront search không tự rebuild Theme Map nữa.
       */
      const map =
        await rebuildActiveThemeMapV4({
          admin,
          shop: session.shop,
        });

      console.log(
        "[AI Search][Theme Map V4] manual sync completed:",
        {
          shop: session.shop,
          themeId: map.theme.id,
          themeName: map.theme.name,
          status: map.status,
          fingerprint: map.fingerprint,
          unsupportedReason:
            map.status === "UNSUPPORTED"
              ? map.unsupportedReason ?? null
              : null,
        },
      );

      const hasThemeContextRenderer =
        map.rendererCandidates.some((candidate) =>
          candidate.renderStrategy === "THEME_CONTEXT_REQUIRED" &&
          candidate.mount != null &&
          candidate.usesAllProducts === false &&
          candidate.rejectionReasons.every(
            (reason) => reason === "THEME_CONTEXT_REQUIRED",
          ),
        );

      const usable =
        map.status === "VERIFIED" ||
        hasThemeContextRenderer;

      if (!usable) {
        return {
          success: false,
          message:
            `Đã đọc theme ${map.theme.name}, nhưng Theme Map V4 chưa có renderer an toàn: ${
              map.status === "UNSUPPORTED"
                ? map.unsupportedReason ?? "UNKNOWN"
                : "NO_SAFE_RENDERER"
            }. Storefront sẽ dùng Shopify Search mặc định.`,
        };
      }

      return {
        success: true,
        message:
          `Đã đồng bộ Theme Map V4 cho theme "${map.theme.name}" · ${map.fingerprint.slice(0, 12)}.`,
      };
    } catch (error) {
      console.error(
        "[Settings] Theme Map V4 manual sync error:",
        error,
      );

      return {
        success: false,
        message:
          `Lỗi đồng bộ Theme Map V4: ${
            error instanceof Error
              ? error.message
              : String(error)
          }`,
      };
    }
  }

  if (intent === "quota_overrides") {
    const allowed = canUseQuotaOverrideUi(session.shop);

    if (!allowed) {
      return { success: false, message: "Quota override UI bị tắt." };
    }

    const parseOverride = (name: string) => {
      const raw = String(form.get(name) ?? "").trim();
      if (!raw) return null;
      const value = Number.parseInt(raw, 10);
      return Number.isFinite(value) && value >= 0 ? value : null;
    };

    await updateShopQuotaOverrides({
      shop: session.shop,
      productLimitOverride: parseOverride("productLimitOverride"),
      searchLimitOverride: parseOverride("searchLimitOverride"),
      vectorUpdateLimitOverride: parseOverride("vectorUpdateLimitOverride"),
    });

    return {
      success: true,
      message: "Đã lưu quota override dùng cho test/support.",
    };
  }

  const aiSearchEnabled = form.get("aiSearchEnabled") === "on";
  const customDataModeEnabled = form.get("customDataModeEnabled") === "on";
  const searchLanguage = String(form.get("searchLanguage") ?? "").trim();
  try {
    if (!searchLanguage || Intl.getCanonicalLocales(searchLanguage).length !== 1) {
      throw new Error();
    }
  } catch {
    return { success: false, message: "Chọn ngôn ngữ shop hợp lệ." };
  }
  const resultLimit = Number.parseInt(
    String(form.get("resultLimit") || "20"),
    10,
  );

  await updateShopSettings({
    shop: session.shop,
    aiSearchEnabled,
    customDataModeEnabled,
    searchLanguage,
    resultLimit: Number.isFinite(resultLimit) ? resultLimit : 20,
  });

  return {
    success: true,
    message: "Đã lưu settings.",
  };
};

export default function SettingsPage() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();

  return (
    <s-page heading="AI Search Settings">
      <s-section heading="Storefront">
        <fetcher.Form method="post">
          <input type="hidden" name="intent" value="settings" />
          <div style={{ display: "grid", gap: 16, maxWidth: 620 }}>
            <label>
              Ngôn ngữ tìm kiếm của shop
              <input
                name="searchLanguage"
                list="search-languages"
                required
                defaultValue={data.searchLanguage ?? ""}
                placeholder="vi, en, zh-Hans…"
                style={{ display: "block", padding: 8, marginTop: 6 }}
              />
              <datalist id="search-languages">
                <option value="vi">Tiếng Việt</option>
                <option value="en">English</option>
                <option value="zh-Hans">中文 giản thể</option>
                <option value="zh-Hant">中文 phồn thể</option>
                <option value="ja">日本語</option>
                <option value="ko">한국어</option>
                <option value="fr">Français</option>
                <option value="de">Deutsch</option>
                <option value="es">Español</option>
                <option value="th">ไทย</option>
              </datalist>
            </label>
            <s-text>
              Sau khi đổi ngôn ngữ, vào Catalog &amp; Vector Index và quét lại
              toàn bộ catalog để đồng bộ sản phẩm.
            </s-text>
            
            <label style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <input
                type="checkbox"
                name="aiSearchEnabled"
                defaultChecked={data.aiSearchEnabled}
              />
              Bật AI Search trên storefront
            </label>

            <label style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 10 }}>
              <input
                type="checkbox"
                name="customDataModeEnabled"
                defaultChecked={data.customDataModeEnabled}
              />
              Bật chế độ App tự render V3 (Không cần đồng bộ Theme Map)
            </label>

            <s-text>
              Fallback về Shopify Search: LUÔN BẬT. Đây là cơ chế an toàn bắt
              buộc khi AI, quota, subscription hoặc Theme Map không khả
              dụng.
            </s-text>

            <label>
              Số kết quả tối đa mỗi AI search (1–20)
              <input
                type="number"
                name="resultLimit"
                min={1}
                max={20}
                defaultValue={data.resultLimit}
                style={{
                  display: "block",
                  marginTop: 6,
                  padding: 8,
                  width: 120,
                }}
              />
            </label>

            <s-button
              type="submit"
              {...(fetcher.state !== "idle" ? { loading: true } : {})}
            >
              Lưu settings
            </s-button>

            {fetcher.data?.message && fetcher.formData?.get("intent") === "settings" ? (
              <s-text>{fetcher.data.message}</s-text>
            ) : null}
          </div>
        </fetcher.Form>
      </s-section>

      <s-section heading="Theme App Embed & Theme Map">
        <s-stack direction="block" gap="base">
          <s-text>
            Trạng thái App Embed:{" "}
            {data.appEmbed.enabled === true
              ? "ĐÃ BẬT"
              : data.appEmbed.enabled === false
                ? "CHƯA BẬT"
                : "CHƯA XÁC ĐỊNH"}
          </s-text>
          {data.appEmbed.themeName ? (
            <s-text>Theme hiện tại: {data.appEmbed.themeName}</s-text>
          ) : null}
          <s-text>
            Trạng thái Theme Map: {data.themeIntegration.themeMapReady ? "ĐÃ ĐỒNG BỘ" : "CHƯA SẴN SÀNG"}
          </s-text>
          <s-text>Integration: {data.themeIntegration.status}</s-text>

          <fetcher.Form method="post" style={{ marginTop: 12, marginBottom: 12 }}>
            <input type="hidden" name="intent" value="sync_theme_map" />
            <button
              type="submit"
              disabled={fetcher.state !== "idle"}
              style={{
                padding: "8px 16px",
                backgroundColor: "#008060",
                color: "#ffffff",
                border: "none",
                borderRadius: "4px",
                cursor: "pointer",
                fontWeight: "bold"
              }}
            >
              {fetcher.state !== "idle" ? "Đang đồng bộ..." : "Đồng bộ theme hiện tại"}
            </button>
          </fetcher.Form>

          {fetcher.data?.message && fetcher.formData?.get("intent") === "sync_theme_map" ? (
            <span style={{ color: fetcher.data.success ? "green" : "red" }}>
              <s-text>{fetcher.data.message}</s-text>
            </span>
          ) : null}

          <s-text>
            App Embed lấy HTML sản phẩm do Shopify và theme hiện tại tạo ra,
            dùng Theme Map để tìm vùng kết quả rồi sắp theo thứ tự AI.
          </s-text>
          {data.appEmbedUrl ? (
            <s-link href={data.appEmbedUrl} target="_top">
              Mở Theme Editor / App Embeds
            </s-link>
          ) : (
            <s-text>
              Thiếu SHOPIFY_API_KEY nên chưa tạo được Theme Editor deep link.
            </s-text>
          )}
          <s-text>
            Lưu ý: Theme Map chỉ được tạo khi cài app lần đầu hoặc khi bạn bấm "Đồng bộ theme hiện tại". Sau khi đổi/publish theme mới, AI Search sẽ tạm fallback về Shopify Search cho đến khi bạn đồng bộ theme mới.
          </s-text>
        </s-stack>
      </s-section>

      {data.allowQuotaOverrides ? (
        <s-section heading="Quota override (Development / Support)">
          <fetcher.Form method="post">
            <input type="hidden" name="intent" value="quota_overrides" />
            <div style={{ display: "grid", gap: 12, maxWidth: 620 }}>
              <s-text>
                Để trống để dùng giới hạn mặc định của plan. Dùng số nhỏ như 5
                searches / 2 vector updates để test fallback nhanh.
              </s-text>
              <label>
                Product limit override
                <input
                  type="number"
                  min={0}
                  name="productLimitOverride"
                  defaultValue={data.productLimitOverride ?? ""}
                  style={{ display: "block", marginTop: 6, padding: 8 }}
                />
              </label>
              <label>
                Search limit override
                <input
                  type="number"
                  min={0}
                  name="searchLimitOverride"
                  defaultValue={data.searchLimitOverride ?? ""}
                  style={{ display: "block", marginTop: 6, padding: 8 }}
                />
              </label>
              <label>
                Vector update limit override
                <input
                  type="number"
                  min={0}
                  name="vectorUpdateLimitOverride"
                  defaultValue={data.vectorUpdateLimitOverride ?? ""}
                  style={{ display: "block", marginTop: 6, padding: 8 }}
                />
              </label>
              <s-button
                type="submit"
                {...(fetcher.state !== "idle" ? { loading: true } : {})}
              >
                Lưu quota test
              </s-button>
            </div>
          </fetcher.Form>
        </s-section>
      ) : null}

      <s-section heading="Lưu ý">
        <s-text>
          Plan quota overrides được giữ ở database để hỗ trợ partner/enterprise
          về sau, nhưng chưa mở cho merchant tự chỉnh trong UI.
        </s-text>
      </s-section>
    </s-page>
  );
}