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
  const { session } = await authenticate.admin(request);
  const form = await request.formData();

  const intent = String(form.get("intent") || "settings");

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
              buộc khi AI, quota, subscription hoặc Theme Renderer không khả
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

            {fetcher.data?.message ? (
              <s-text>{fetcher.data.message}</s-text>
            ) : null}
          </div>
        </fetcher.Form>
      </s-section>

      <s-section heading="Theme App Embed">
        <s-stack direction="block" gap="base">
          <s-text>
            Trạng thái:{" "}
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
            Theme Renderer: {data.themeIntegration.rendererCompatible ? "TƯƠNG THÍCH" : "CHƯA TƯƠNG THÍCH"}
          </s-text>
          <s-text>Integration: {data.themeIntegration.status}</s-text>
          <s-text>
            App Embed theo dõi điều hướng Shopify /search mà không đoán CSS
            selector/class và không tự render product card. AI chỉ nhận search
            product-only, semantic và không có filter/sort/page chưa hỗ trợ;
            SKU/barcode/mã số, article/page/mixed search và filter nâng cao giữ
            nguyên Shopify Search để không tốn query embedding.
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
            Sau khi bật “AI Search Bridge” trong Theme Editor, merchant cần bấm
            Save.
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
