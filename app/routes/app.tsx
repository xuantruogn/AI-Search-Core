import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { NavLink, Outlet, useLoaderData, useRouteError } from "react-router";
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
    console.error("[AI Search] Shopify App Pricing refresh failed:", {
      shop: session.shop,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    const reconcile = () =>
      reconcileShopCommercialState({
        shop: session.shop,
        forceCatalogRefresh: billingChanged,
      });

    if (billingChanged) {
      // A plan/status change alters product eligibility immediately. Wait for
      // reconciliation so nested admin loaders never render an old active
      // product count against the new limit.
      await reconcile();
    } else {
      void reconcile().catch((error) => {
        console.error("[AI Search] Commercial reconciliation failed:", {
          shop: session.shop,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
  } catch (error) {
    console.error(
      "[AI Search] Commercial reconciliation scheduling failed:",
      error,
    );
  }

  return {
    apiKey: process.env.SHOPIFY_API_KEY || "",
  };
};

export default function App() {
  const { apiKey } = useLoaderData<typeof loader>();

  const navItems = [
    { label: "Dashboard", to: "/app", end: true },
    { label: "Catalog", to: "/app/catalog-sync" },
    { label: "Usage", to: "/app/usage" },
    { label: "Search Analytics", to: "/app/search-analytics" },
    { label: "Plans & Billing", to: "/app/billing" },
    { label: "Settings", to: "/app/settings" },
    { label: "Product Demo", to: "/demo", external: true },
  ];

  return (
    <AppProvider embedded apiKey={apiKey}>
      {/* THANH TAB NAVIGATION CAO CẤP */}
      <div
        style={{
          background: "#ffffff",
          borderBottom: "1px solid #e1e3e5",
          padding: "0 24px",
          marginBottom: 28, // Tăng khoảng cách tách biệt hoàn toàn với khối nội dung bên dưới
          boxShadow: "0 1px 0 rgba(0, 0, 0, 0.05)",
        }}
      >
        <nav
          aria-label="AI Search navigation"
          style={{
            display: "flex",
            gap: 12, // Tăng khoảng cách giãn cách giữa các nút Tab (từ 4px lên 12px)
            overflowX: "auto",
            fontFamily: "-apple-system, BlinkMacSystemFont, 'San Francisco', 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif",
          }}
        >
          {navItems.map((item) => {
            if (item.external) {
              return (
                <a
                  key={item.to}
                  href={item.to}
                  target="_top"
                  style={{
                    padding: "12px 18px", // Tăng vùng bấm cho thoải mái
                    fontSize: 13,
                    fontWeight: 500,
                    color: "#616161",
                    textDecoration: "none",
                    borderBottom: "3px solid transparent",
                    borderRadius: "8px 8px 0 0",
                    whiteSpace: "nowrap",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 4,
                    transition: "all 0.15s ease",
                  }}
                >
                  {item.label} <span style={{ fontSize: 11, opacity: 0.7 }}>↗</span>
                </a>
              );
            }

            return (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                style={({ isActive }) => ({
                  padding: "12px 18px", // Tăng đệm trong tab giúp tab to rõ nét hơn
                  fontSize: 13,
                  fontWeight: isActive ? 600 : 500,
                  color: isActive ? "#008060" : "#616161", // Tab Active dùng màu xanh lá đậm chuẩn Polaris
                  textDecoration: "none",
                  borderBottom: isActive ? "3px solid #008060" : "3px solid transparent",
                  backgroundColor: isActive ? "#f1f8f5" : "transparent", // Nền xanh nhạt mịn mắt khi được chọn
                  borderRadius: "8px 8px 0 0",
                  transition: "all 0.15s ease-in-out",
                  whiteSpace: "nowrap",
                  display: "inline-flex",
                  alignItems: "center",
                })}
              >
                {item.label}
              </NavLink>
            );
          })}
        </nav>
      </div>

      {/* KHỐI NỘI DUNG BÊN DƯỚI DÃN CÁCH THOẢI MÁI */}
      <div style={{ padding: "0 8px" }}>
        <Outlet />
      </div>
    </AppProvider>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};