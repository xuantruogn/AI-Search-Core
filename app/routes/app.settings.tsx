import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";

import { authenticate } from "../shopify.server";
import {
  getShopSettings,
  updateShopQuotaOverrides,
  updateShopSettings,
} from "../services/commerce/shop-registry.server";
import { getThemeAppEmbedDeepLink } from "../services/theme/app-embed.server";
import { getThemeIntegrationStatus } from "../services/theme/theme-integration.server";
import { canUseQuotaOverrideUi } from "../services/commerce/support-access.server";
import { clearShopThemeCache } from "./proxy.ai-search";
import { getActiveTheme } from "../services/theme/theme-reader.server";
import { buildMainThemeMap, buildClientThemeMapDTO } from "../services/theme-map.server";
import { readThemeMapStorage, saveThemeMap } from "../services/theme-map-storage.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const [settings, themeIntegration] = await Promise.all([
    getShopSettings(session.shop),
    getThemeIntegrationStatus({ admin, shop: session.shop }),
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

  // ĐÃ MỞ VÀ THÊM LOG ĐỂ SOI DỮ LIỆU TẠI VS CODE
  if (intent === "sync_theme_map") {
    try {
      await clearShopThemeCache(session.shop);
      const activeTheme = await getActiveTheme(admin);
      const themeMap = await buildMainThemeMap(admin);
      const clientDto = buildClientThemeMapDTO(themeMap);

      console.log(`\n================== [VS CODE DEBUG: THEME MAP BEFORE SAVE] ==================`);
      console.log(`Shop: ${session.shop} | Active Theme: ${activeTheme.name} (ID: ${activeTheme.id})`);
      
      console.log(`\n--- 📄 1. FULL THEME MAP (Dữ liệu quét từ Liquid Source Graph) ---`);
      console.log(JSON.stringify(themeMap, null, 2));

      console.log(`\n--- 📦 2. CLIENT DTO PAYLOAD (Dữ liệu sẽ stringify gửi vào Metafield) ---`);
      console.log(JSON.stringify(clientDto, null, 2));
      console.log(`===========================================================================\n`);

      const previous = await readThemeMapStorage(admin, activeTheme.id);
      await saveThemeMap(admin, themeMap, previous);

      return {
        success: true,
        message: "Đồng bộ Theme Map vào Shop Metafield thành công!",
      };
    } catch (error) {
      console.error("[Settings] Sync Theme Map error:", error);
      return {
        success: false,
        message: `Lỗi đồng bộ: ${error instanceof Error ? error.message : String(error)}`,
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
  const resultLimit = Number.parseInt(
    String(form.get("resultLimit") || "20"),
    10,
  );

  await updateShopSettings({
    shop: session.shop,
    aiSearchEnabled,
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
            <label style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <input
                type="checkbox"
                name="aiSearchEnabled"
                defaultChecked={data.aiSearchEnabled}
              />
              Bật AI Search trên storefront
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
              {fetcher.state !== "idle" ? "Đang đồng bộ..." : "Đồng bộ lại Theme Map & Metafield"}
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
            Lưu ý: Khi đổi sang Theme mới, bạn hãy nhấn nút "Đồng bộ lại Theme Map" ở trên và bật “AI Search Bridge” trong Theme Editor rồi nhấn Save.
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