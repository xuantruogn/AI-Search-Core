import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useEffect, useState } from "react";
import { redirect, useFetcher, useLoaderData } from "react-router";

import { authenticate } from "../shopify.server";
import {
  getShopSettings,
  updateShopSettings,
} from "../services/commerce/shop-registry.server";
import { rebuildActiveThemeMapV4 } from "../services/theme/theme-map-v4-lifecycle.server";
import {
  FALLBACK_SEARCH_LOCALES,
  isSupportedFallbackLocale,
} from "../services/commerce/shop-locales.server";
import { readCatalogLanguageState, requestCatalogLanguageChange, sampleCatalogSourceLanguage } from "../services/catalog/catalog-language.server";
import { kickCatalogSyncQueue } from "../services/catalog/catalog-sync-queue.server";
import { invalidateSearchCatalogRevisionCache } from "../services/search/search-catalog-revision.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const settings = await getShopSettings(session.shop);
  const languageState = await readCatalogLanguageState(session.shop);
  const sourceLanguageSample = await sampleCatalogSourceLanguage(session.shop);

  let localeOptions = [...FALLBACK_SEARCH_LOCALES];

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
    pendingCatalogLanguage: languageState.pendingCatalogLanguage,
    sourceLanguageSample,
    localeOptions,
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
    return { success: false, message: "Please select a valid product catalog language." };
  }

  const selectedIsAvailable = isSupportedFallbackLocale(searchLanguage);

  if (!selectedIsAvailable) {
    return {
      success: false,
      message: "Please choose one of the supported product catalog languages.",
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

  if (languageChanged && (
    form.get("catalogLanguageConfirmed") !== "on" ||
    String(form.get("confirmedCatalogLanguage") ?? "").toLowerCase() !== searchLanguage.toLowerCase()
  )) {
    return {
      success: false,
      message: "Confirm that this is the language of your product titles and descriptions and that the catalog must be rescanned before saving.",
    };
  }

  if (languageChanged) {
    try {
      await requestCatalogLanguageChange(session.shop, searchLanguage, form.get("catalogLanguageMismatchConfirmed") === "on");
    } catch (error) {
      return { success: false, message: error instanceof Error ? error.message : "Catalog rebuild could not be scheduled. Language was not changed." };
    }
  }
  await updateShopSettings({
    shop: session.shop,
    aiSearchEnabled,
    customDataModeEnabled,
    resultLimit: Number.isFinite(resultLimit) ? resultLimit : 20,
  });
  invalidateSearchCatalogRevisionCache(session.shop);

  // Product embeddings and semantic profiles are language-dependent. Changing
  // the merchant search language without rebuilding them leaves query analysis
  // and the catalog in different semantic spaces. Queue this even on first
  // language selection: the catalog queue coalesces with an existing initial
  // sync, while legacy shops that already have vectors are safely rebuilt.
  if (languageChanged) {
    kickCatalogSyncQueue();
  }

  if (onboardingLanguage) {
    if (!languageChanged) throw redirect("/app");
  }

  return {
    success: true,
    message: languageChanged
      ? "Catalog rebuild scheduled. The new language becomes active only after a complete validated rebuild. Shopify native search is used while rebuilding."
      : "Settings saved successfully!",
  };
};

export default function SettingsPage() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const [selectedLanguage, setSelectedLanguage] = useState(data.searchLanguage ?? "");
  const [languageConfirmed, setLanguageConfirmed] = useState(false);
  const [mismatchConfirmed, setMismatchConfirmed] = useState(false);
  useEffect(() => {
    setSelectedLanguage(data.searchLanguage ?? "");
    setLanguageConfirmed(false);
    setMismatchConfirmed(false);
  }, [data.searchLanguage]);
  const languageChanged = selectedLanguage.toLowerCase() !== (data.searchLanguage ?? "").toLowerCase();
  const sourceMismatch = Boolean(data.sourceLanguageSample.dominant && selectedLanguage && data.sourceLanguageSample.dominant !== selectedLanguage.split("-")[0].toLowerCase());

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
            {data.pendingCatalogLanguage && <p role="status" style={{ padding: 14, background: "#fff8e6", borderRadius: 8 }}>
              Catalog language rebuild pending: {data.pendingCatalogLanguage}. Active language: {data.searchLanguage ?? "not set"}.
              Shopify native search remains available. The new language activates only after the full rebuild is verified.
            </p>}
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
                  Product Catalog Language
                </label>

                <select
                  id="searchLanguage"
                  name="searchLanguage"
                  required
                  value={selectedLanguage}
                  disabled={isSavingSettings}
                  onChange={(event) => {
                    setSelectedLanguage(event.target.value);
                    setLanguageConfirmed(false);
                    setMismatchConfirmed(false);
                  }}
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
                    Select your product catalog language
                  </option>
                  {data.localeOptions.map((item) => (
                    <option key={item.locale} value={item.locale}>
                      {item.name} ({item.locale})
                    </option>
                  ))}
                </select>

                <p style={{ margin: "7px 0 0 0", fontSize: 12, color: "#616161" }}>
                  Select the language used in your product titles and descriptions. This is the
                  catalog language used for product enrichment and semantic retrieval, not your
                  storefront or Shopify admin language. Customers can search in other languages;
                  queries are normalized automatically.
                </p>

                <p style={{ margin: "6px 0 0 0", fontSize: 12, color: "#616161" }}>
                  💡 <i>Note:</i> Changing this language requires a catalog rescan. Saving a
                  confirmed language change requests <b>Catalog Sync</b> automatically to rebuild
                  product semantic data in the selected language.
                </p>
                {languageChanged && selectedLanguage ? (
                  <div role="note" style={{ marginTop: 12, padding: 16, borderRadius: 8, border: "1px solid #e9bb64", background: "#fff8e6", color: "#614500", fontSize: 13, lineHeight: 1.6 }}>
                    <strong>Confirm product catalog language change</strong>
                    <p style={{ margin: "6px 0 12px" }}>
                      Choose the actual language of your product titles and descriptions, not the
                      storefront language. Your products must be rescanned after this change;
                      search quality may be affected until the rescan finishes.
                    </p>
                    <input type="hidden" name="confirmedCatalogLanguage" value={selectedLanguage} />
                    <label style={{ display: "flex", alignItems: "flex-start", gap: 10, cursor: "pointer" }}>
                      <input type="checkbox" name="catalogLanguageConfirmed" required
                        checked={languageConfirmed} disabled={isSavingSettings}
                        onChange={(event) => setLanguageConfirmed(event.target.checked)} />
                      <span>I confirm that {data.localeOptions.find((item) => item.locale === selectedLanguage)?.name ?? selectedLanguage} is
                        the language of my product catalog, and I understand that all products must be rescanned.</span>
                    </label>
                    {sourceMismatch && <label style={{ display: "flex", gap: 10, marginTop: 12 }}>
                      <input type="checkbox" name="catalogLanguageMismatchConfirmed" required
                        checked={mismatchConfirmed} onChange={(event) => setMismatchConfirmed(event.target.checked)} />
                      <span>Existing product analysis suggests {data.sourceLanguageSample.dominant} ({data.sourceLanguageSample.known} sampled profiles).
                        I have checked my source product data and confirm the different language selected here is intentional.
                        This sample may be incomplete or outdated.</span>
                    </label>}
                  </div>
                ) : null}
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
                  disabled={isSavingSettings || (languageChanged && (!languageConfirmed || (sourceMismatch && !mismatchConfirmed)))}
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
