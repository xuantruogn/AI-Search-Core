import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";

import { authenticate } from "../shopify.server";
import {
  getShopSettings,
  updateShopSettings,
} from "../services/commerce/shop-registry.server";
import { rebuildActiveThemeMapV4 } from "../services/theme/theme-map-v4-lifecycle.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const settings = await getShopSettings(session.shop);

  return {
    ...settings,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const form = await request.formData();

  const intent = String(form.get("intent") ?? "settings");

  if (intent === "sync_theme_map") {
    try {
      const map = await rebuildActiveThemeMapV4({
        admin,
        shop: session.shop,
      });

      const hasThemeContextRenderer = map.rendererCandidates.some(
        (candidate) =>
          candidate.renderStrategy === "THEME_CONTEXT_REQUIRED" &&
          candidate.mount != null &&
          candidate.usesAllProducts === false &&
          candidate.rejectionReasons.every(
            (reason) => reason === "THEME_CONTEXT_REQUIRED",
          ),
      );

      if (map.status !== "VERIFIED" && !hasThemeContextRenderer) {
        return {
          success: false,
          message: `Theme "${map.theme.name}" does not expose a verified safe renderer: ${
            map.status === "UNSUPPORTED"
              ? map.unsupportedReason ?? "UNKNOWN"
              : "NO_SAFE_RENDERER"
          }. The storefront will keep using Shopify native search.`,
        };
      }

      return {
        success: true,
        message: `Theme Map V4 synced for "${map.theme.name}" · ${map.fingerprint.slice(0, 12)}.`,
      };
    } catch (error) {
      console.error("[Settings] Theme Map V4 manual sync failed", {
        shop: session.shop,
        error:
          error instanceof Error
            ? {
                name: error.name,
                message: error.message,
                stack: error.stack,
              }
            : String(error),
      });

      return {
        success: false,
        message: `Theme Map V4 sync failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  }

  const aiSearchEnabled = form.get("aiSearchEnabled") === "on";
  const customDataModeEnabled = form.get("customDataModeEnabled") === "on";
  const searchLanguage = String(form.get("searchLanguage") ?? "").trim();

  try {
    if (!searchLanguage || Intl.getCanonicalLocales(searchLanguage).length !== 1) {
      throw new Error();
    }
  } catch {
    return { success: false, message: "Please select a valid ISO language code." };
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
    message: "Settings saved successfully!",
  };
};

export default function SettingsPage() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();

  const isSavingSettings = fetcher.state !== "idle";

  return (
    <div
      style={{
        width: "100%",
        padding: "0 24px 60px 24px",
        boxSizing: "border-box",
        fontFamily:
          "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
      }}
    >
      {/* PAGE HEADER */}
      <div
        style={{
          marginBottom: 24,
          borderBottom: "1px solid #e1e3e5",
          paddingBottom: 16,
        }}
      >
        <h1
          style={{ margin: 0, fontSize: 22, fontWeight: 700, color: "#1a1a1a" }}
        >
          AI Search Configuration & Preferences
        </h1>
        <p style={{ margin: "4px 0 0 0", fontSize: 13, color: "#616161" }}>
          Configure AI Search behavior on your Storefront, primary recognition language, and result display limits.
        </p>
      </div>

      {/* LEFT ALIGNED CONTAINER - MAX WIDTH 900PX */}
      <div style={{ maxWidth: 900, marginLeft: 0 }}>
        <div
          style={{
            background: "#fff",
            borderRadius: 12,
            padding: 24,
            border: "1px solid #e1e3e5",
            boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
          }}
        >
          <h2
            style={{
              margin: "0 0 20px 0",
              fontSize: 16,
              fontWeight: 700,
              color: "#1a1a1a",
              borderBottom: "1px solid #f1f2f3",
              paddingBottom: 12,
            }}
          >
            ⚙️ Store Search Settings
          </h2>

          <fetcher.Form method="post">
            <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
              {/* PRIMARY SEARCH LANGUAGE */}
              <div>
                <label
                  htmlFor="searchLanguage"
                  style={{
                    display: "block",
                    fontWeight: 600,
                    fontSize: 13,
                    color: "#1a1a1a",
                    marginBottom: 6,
                  }}
                >
                  Primary Search Language
                </label>
                <input
                  id="searchLanguage"
                  name="searchLanguage"
                  list="search-languages"
                  required
                  defaultValue={data.searchLanguage ?? "en"}
                  placeholder="Example: en, vi, ja..."
                  style={{
                    width: "100%",
                    maxWidth: 360,
                    padding: "10px 12px",
                    borderRadius: 8,
                    border: "1px solid #c9cccf",
                    fontSize: 13,
                    boxSizing: "border-box",
                  }}
                />
                <datalist id="search-languages">
                  <option value="en">English</option>
                  <option value="vi">Vietnamese (Tiếng Việt)</option>
                  <option value="zh-Hans">Simplified Chinese (中文 simplified)</option>
                  <option value="zh-Hant">Traditional Chinese (中文 traditional)</option>
                  <option value="ja">Japanese (日本語)</option>
                  <option value="ko">Korean (한국어)</option>
                  <option value="fr">French (Français)</option>
                  <option value="de">German (Deutsch)</option>
                  <option value="es">Spanish (Español)</option>
                  <option value="th">Thai (ไทย)</option>
                </datalist>
                <p style={{ margin: "6px 0 0 0", fontSize: 12, color: "#616161" }}>
                  💡 <i>Note:</i> After changing the language, please navigate to the <b>Catalog Sync</b> page and re-run synchronization to update your product index.
                </p>
              </div>

              {/* TOGGLE OPTIONS */}
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 12,
                  background: "#fafafa",
                  padding: 16,
                  borderRadius: 8,
                  border: "1px solid #f1f2f3",
                }}
              >
                <label
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    cursor: "pointer",
                    fontWeight: 600,
                    fontSize: 13,
                    color: "#1a1a1a",
                  }}
                >
                  <input
                    type="checkbox"
                    name="aiSearchEnabled"
                    defaultChecked={data.aiSearchEnabled}
                    style={{ width: 18, height: 18, accentColor: "#008060" }}
                  />
                  Enable AI Search Engine on Storefront
                </label>

                <label
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    cursor: "pointer",
                    fontWeight: 600,
                    fontSize: 13,
                    color: "#1a1a1a",
                  }}
                >
                  <input
                    type="checkbox"
                    name="customDataModeEnabled"
                    defaultChecked={data.customDataModeEnabled}
                    style={{ width: 18, height: 18, accentColor: "#008060" }}
                  />
                  Enable Self-Rendering V3 Mode (Bypasses Theme Map dependency)
                </label>
              </div>

              {/* RESULT LIMIT */}
              <div>
                <label
                  htmlFor="resultLimit"
                  style={{
                    display: "block",
                    fontWeight: 600,
                    fontSize: 13,
                    color: "#1a1a1a",
                    marginBottom: 6,
                  }}
                >
                  Maximum AI Search Results Returned Per Query (1 – 20)
                </label>
                <input
                  id="resultLimit"
                  type="number"
                  name="resultLimit"
                  min={1}
                  max={20}
                  defaultValue={data.resultLimit}
                  style={{
                    width: 120,
                    padding: "8px 12px",
                    borderRadius: 8,
                    border: "1px solid #c9cccf",
                    fontSize: 13,
                  }}
                />
              </div>

              {/* SAFE NATIVE FALLBACK NOTICE */}
              <div
                style={{
                  background: "#e4f8f0",
                  border: "1px solid #b7ebc6",
                  borderRadius: 8,
                  padding: 14,
                  fontSize: 12,
                  color: "#004b36",
                  lineHeight: 1.5,
                }}
              >
                <strong>🛡️ Automatic Native Fallback Protection:</strong>
                <br />
                The automatic fallback to Shopify Default Search is <strong>ALWAYS ENABLED</strong>. In the event of network connectivity issues, quota limits, or AI processing errors, customers will seamlessly find products using native search without any disruption.
              </div>

              {/* SAVE BUTTON & FEEDBACK */}
              <div style={{ display: "flex", alignItems: "center", gap: 16, marginTop: 8 }}>
                <button
                  type="submit"
                  disabled={isSavingSettings}
                  style={{
                    padding: "10px 24px",
                    borderRadius: 8,
                    border: "none",
                    background: "#008060",
                    color: "#fff",
                    fontWeight: 700,
                    fontSize: 13,
                    cursor: isSavingSettings ? "wait" : "pointer",
                    boxShadow: "0 1px 3px rgba(0,0,0,0.1)",
                  }}
                >
                  {isSavingSettings ? "Saving settings..." : "Save Settings"}
                </button>

                {fetcher.data?.message ? (
                  <span
                    style={{
                      fontSize: 13,
                      fontWeight: 600,
                      color: fetcher.data.success ? "#008060" : "#d32f2f",
                    }}
                  >
                    {fetcher.data.message}
                  </span>
                ) : null}
              </div>
            </div>
          </fetcher.Form>
        </div>
      </div>
    </div>
  );
}
