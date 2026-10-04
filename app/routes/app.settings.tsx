import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { redirect, useFetcher, useLoaderData } from "react-router";

import { authenticate } from "../shopify.server";
import {
  getShopSettings,
  updateShopSettings,
} from "../services/commerce/shop-registry.server";
import { rebuildActiveThemeMapV4 } from "../services/theme/theme-map-v4-lifecycle.server";
import {
  getShopLocalesWithFallback,
  isSupportedFallbackLocale,
} from "../services/commerce/shop-locales.server";
import { enqueueCatalogRefresh } from "../services/catalog/catalog-sync-job.server";
import { kickCatalogSyncQueue } from "../services/catalog/catalog-sync-queue.server";
import { invalidateSearchCatalogRevisionCache } from "../services/search/search-catalog-revision.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const settings = await getShopSettings(session.shop);

  const localeState = await getShopLocalesWithFallback(admin);
  let localeOptions = localeState.options;

  if (
    settings.searchLanguage &&
    !localeOptions.some(
      (item) =>
        item.locale.toLowerCase() === settings.searchLanguage?.toLowerCase(),
    )
  ) {
    localeOptions = [
      {
        locale: settings.searchLanguage,
        name: `Current setting (${settings.searchLanguage})`,
        primary: false,
        published: false,
        source: "FALLBACK" as const,
      },
      ...localeOptions,
    ];
  }

  return {
    ...settings,
    localeOptions,
    localeError: localeState.error,
    usingLocaleFallback: localeState.usingFallback,
    onboardingRequired: !settings.searchLanguage?.trim(),
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
  const onboardingLanguage = form.get("onboarding") === "language";
  const rawSearchLanguage = String(form.get("searchLanguage") ?? "").trim();

  let searchLanguage: string;
  try {
    const canonical = Intl.getCanonicalLocales(rawSearchLanguage);
    if (!rawSearchLanguage || canonical.length !== 1) throw new Error();
    searchLanguage = canonical[0];
  } catch {
    return { success: false, message: "Please select a valid shop language." };
  }

  const localeState = await getShopLocalesWithFallback(admin);
  const selectedIsAvailable = localeState.usingFallback
    ? isSupportedFallbackLocale(searchLanguage)
    : localeState.options.some(
        (item) => item.locale.toLowerCase() === searchLanguage.toLowerCase(),
      );

  if (!selectedIsAvailable) {
    return {
      success: false,
      message: localeState.usingFallback
        ? "Please choose one of the supported search languages."
        : "Please choose one of the languages enabled on this Shopify store.",
    };
  }

  const resultLimit = Number.parseInt(
    String(form.get("resultLimit") || "20"),
    10,
  );

  const previousSettings = await getShopSettings(session.shop);
  const previousLanguage = previousSettings.searchLanguage?.trim() || null;
  const languageChanged =
    previousLanguage?.toLowerCase() !== searchLanguage.toLowerCase();

  await updateShopSettings({
    shop: session.shop,
    aiSearchEnabled,
    customDataModeEnabled,
    searchLanguage,
    resultLimit: Number.isFinite(resultLimit) ? resultLimit : 20,
  });
  invalidateSearchCatalogRevisionCache(session.shop);

  // Product embeddings and semantic profiles are language-dependent. Changing
  // the merchant search language without rebuilding them leaves query analysis
  // and the catalog in different semantic spaces. Queue this even on first
  // language selection: the catalog queue coalesces with an existing initial
  // sync, while legacy shops that already have vectors are safely rebuilt.
  if (languageChanged) {
    const refreshJobId = await enqueueCatalogRefresh(
      session.shop,
      "LANGUAGE_CHANGE",
    );
    if (refreshJobId) kickCatalogSyncQueue();
  }

  if (onboardingLanguage) {
    throw redirect("/app");
  }

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
          Search Configuration & Preferences
        </h1>
        <p style={{ margin: "4px 0 0 0", fontSize: 13, color: "#616161" }}>
          Configure search behavior on your Storefront, primary recognition language, and result display limits.
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
            {data.onboardingRequired ? (
              <input type="hidden" name="onboarding" value="language" />
            ) : null}
            <input type="hidden" name="resultLimit" value={data.resultLimit} />

            <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
              {data.onboardingRequired ? (
                <div
                  style={{
                    padding: 14,
                    borderRadius: 8,
                    border: "1px solid #f0c36d",
                    background: "#fff8e6",
                    color: "#5c3b00",
                    fontSize: 13,
                    lineHeight: 1.5,
                  }}
                >
                  <strong>Required setup:</strong> Choose the catalog language before using search.
                  Shopper queries can still be written in any language; Search detects the query
                  language and normalizes it to the language selected here.
                </div>
              ) : null}

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
                  Primary Catalog & Search Language
                </label>

                <select
                  id="searchLanguage"
                  name="searchLanguage"
                  required
                  defaultValue={data.searchLanguage ?? ""}
                  disabled={false}
                  style={{
                    width: "100%",
                    maxWidth: 420,
                    padding: "10px 12px",
                    borderRadius: 8,
                    border: "1px solid #c9cccf",
                    fontSize: 13,
                    boxSizing: "border-box",
                    background: "#fff",
                  }}
                >
                  <option value="" disabled>
                    Select a supported catalog & search language
                  </option>
                  {data.localeOptions.map((item) => (
                    <option key={item.locale} value={item.locale}>
                      {item.name} ({item.locale})
                      {item.primary ? " · Shopify primary" : ""}
                      {item.published ? " · Published" : ""}
                      {item.source === "SHOPIFY" && !item.primary && !item.published
                        ? " · Enabled on Shopify"
                        : ""}
                    </option>
                  ))}
                </select>

                <p style={{ margin: "7px 0 0 0", fontSize: 12, color: "#616161" }}>
                  This is the canonical language used for product enrichment and semantic retrieval.
                  Customers can search in other languages; Gemini detects and translates queries automatically.
                </p>

                {data.usingLocaleFallback ? (
                  <p style={{ margin: "7px 0 0 0", fontSize: 12, color: "#8a6116" }}>
                    Shopify locale access is not active yet, so all supported search languages
                    are shown. You can select and save a language now. Once locale access is granted,
                    this list will automatically use the languages enabled on the store.
                  </p>
                ) : null}

                <p style={{ margin: "6px 0 0 0", fontSize: 12, color: "#616161" }}>
                  💡 <i>Note:</i> After changing this language, re-run <b>Catalog Sync</b> so existing
                  product semantic facets are rebuilt in the selected canonical language.
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
                  Enable Search Engine on Storefront
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
                  {isSavingSettings
                    ? "Saving settings..."
                    : data.onboardingRequired
                      ? "Continue to Search"
                      : "Save Settings"}
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
