import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import { authenticate } from "../shopify.server";
import { ensureShopFromAdmin } from "../services/commerce/shop-registry.server";
import { refreshShopifyAppPricingIfStale } from "../services/billing/shopify-app-pricing.server";
import { reconcileShopCommercialState } from "../services/commerce/reconciliation.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  await ensureShopFromAdmin({
    shop: session.shop,
    admin,
  });

  const url = new URL(request.url);
  const preferredPlanHandle = url.searchParams.get("plan_handle");

  let billingChanged = false;

  try {
    const billing = await refreshShopifyAppPricingIfStale({
      shop: session.shop,
      admin,
      preferredPlanHandle,
    });
    billingChanged = billing.changed;
  } catch (error) {
    // Billing refresh failures should not lock the merchant out of the admin UI.
    console.error("[AI Search] Shopify App Pricing refresh failed:", {
      shop: session.shop,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    void reconcileShopCommercialState({
      shop: session.shop,
      forceCatalogRefresh: billingChanged,
    }).catch((error) => {
      console.error("[AI Search] Commercial reconciliation failed:", {
        shop: session.shop,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  } catch (error) {
    console.error(
      "[AI Search] Commercial reconciliation scheduling failed:",
      error,
    );
  }

  return {
    // eslint-disable-next-line no-undef
    apiKey: process.env.SHOPIFY_API_KEY || "",
  };
};

export default function App() {
  const { apiKey } = useLoaderData<typeof loader>();

  return (
    <AppProvider embedded apiKey={apiKey}>
      <nav
        aria-label="AI Search navigation"
        style={{
          display: "flex",
          gap: 16,
          flexWrap: "wrap",
          padding: "12px 20px",
          borderBottom: "1px solid #e1e3e5",
        }}
      >
        <s-link href="/app">Dashboard</s-link>
        <s-link href="/app/catalog-sync">Catalog</s-link>
        <s-link href="/app/usage">Usage</s-link>
        <s-link href="/app/billing">Plans &amp; Billing</s-link>
        <s-link href="/app/settings">Settings</s-link>
      </nav>
      <Outlet />
    </AppProvider>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
