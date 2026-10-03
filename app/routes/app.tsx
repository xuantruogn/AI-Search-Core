import type {
  HeadersFunction,
  LoaderFunctionArgs,
  ShouldRevalidateFunction,
} from "react-router";
import {
  NavLink,
  Outlet,
  useLoaderData,
  useNavigation,
  useRouteError,
} from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import { authenticate } from "../shopify.server";
import {
  ensureShopFromAdmin,
  getShopSettings,
} from "../services/commerce/shop-registry.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const debugId = crypto.randomUUID().slice(0, 8);
  const url = new URL(request.url);
  console.log("[APP TRACE] loader:start", { debugId, method: request.method, pathname: url.pathname, search: url.search, referer: request.headers.get("referer"), remixRequest: request.headers.get("x-remix-request"), secFetchMode: request.headers.get("sec-fetch-mode") });
  const { admin, session, redirect } = await authenticate.admin(request);
  console.log("[APP DEBUG] loader:authenticated", { debugId, shop: session.shop, pathname: url.pathname });

  // 1. Đảm bảo record Shop tồn tại trong DB
  console.log("[APP DEBUG] ensureShopFromAdmin:start", { debugId, shop: session.shop });
  await ensureShopFromAdmin({
    shop: session.shop,
    admin,
  });

  console.log("[APP DEBUG] ensureShopFromAdmin:done", { debugId, shop: session.shop });

  // Billing/commercial reconciliation is event-driven (callback/webhook/API).
  // Do not run it from the parent /app loader: that path executes frequently
  // and previously caused duplicate billing refresh/reconciliation loops.

  // First-install onboarding remains parent-route owned so merchants cannot
  // use catalog/search features before choosing the canonical shop language.
  const settings = await getShopSettings(session.shop, { ensure: false });
  const isLanguageSetupRoute = url.pathname.startsWith("/app/settings");

  if (!settings.searchLanguage?.trim() && !isLanguageSetupRoute) {
    return redirect("/app/settings?onboarding=language");
  }

  return {
    apiKey: process.env.SHOPIFY_API_KEY || "",
  };
};

/**
 * Child routes authenticate and load their own data. Re-running this root
 * loader on every tab/page/query-string navigation needlessly repeats shop
 * registry and billing freshness work. Keep explicit same-URL revalidation
 * working, and reload when Shopify returns with a different plan handle.
 */
export const shouldRevalidate: ShouldRevalidateFunction = ({
  currentUrl,
  nextUrl,
  defaultShouldRevalidate,
}) => {
  const currentPlanHandle = currentUrl.searchParams.get("plan_handle");
  const nextPlanHandle = nextUrl.searchParams.get("plan_handle");

  if (nextPlanHandle && nextPlanHandle !== currentPlanHandle) {
    return true;
  }

  if (
    currentUrl.pathname !== nextUrl.pathname ||
    currentUrl.search !== nextUrl.search
  ) {
    return false;
  }

  return defaultShouldRevalidate;
};

export default function App() {
  const { apiKey } = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const isNavigating = navigation.state === "loading";

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
          position: "relative",
          background: "#ffffff",
          borderBottom: "1px solid #e1e3e5",
          padding: "0 24px",
          marginBottom: 28, // Tăng khoảng cách tách biệt hoàn toàn với khối nội dung bên dưới
          boxShadow: "0 1px 0 rgba(0, 0, 0, 0.05)",
        }}
      >
        <div
          aria-hidden="true"
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: isNavigating ? "72%" : "0%",
            height: 2,
            opacity: isNavigating ? 1 : 0,
            background: "linear-gradient(90deg, #008060, #00a47c)",
            transition: isNavigating
              ? "width 0.8s ease-out, opacity 0.1s"
              : "width 0.15s, opacity 0.2s",
            pointerEvents: "none",
          }}
        />
        <nav
          aria-label="Search navigation"
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
                prefetch="intent"
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
