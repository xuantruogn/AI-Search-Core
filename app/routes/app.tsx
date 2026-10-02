import type {
  HeadersFunction,
  LoaderFunctionArgs,
  ShouldRevalidateFunction,
} from "react-router";
import {
  Link,
  NavLink,
  Outlet,
  redirect,
  useLoaderData,
  useNavigation,
  useRouteError,
} from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import "../styles/merchant-app.css";

import { authenticate } from "../shopify.server";
import {
  ensureShopFromAdmin,
  getShopSettings,
} from "../services/commerce/shop-registry.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const debugId = crypto.randomUUID().slice(0, 8);
  const url = new URL(request.url);
  console.log("[APP TRACE] loader:start", { debugId, method: request.method, pathname: url.pathname, search: url.search, referer: request.headers.get("referer"), remixRequest: request.headers.get("x-remix-request"), secFetchMode: request.headers.get("sec-fetch-mode") });
  // const { admin, session } = await authenticate.admin(request);
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
    // throw redirect("/app/settings?onboarding=language");
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
    { label: "Billing", to: "/app/billing" },
    { label: "Settings", to: "/app/settings" },
    { label: "Storefront Demo", to: "/demo", external: true },
  ];

  return (
    <AppProvider embedded apiKey={apiKey}>
      <div className="merchant-shell-nav">
        <div
          className="merchant-shell-progress"
          aria-hidden="true"
          style={{
            width: isNavigating ? "72%" : "0%",
            opacity: isNavigating ? 1 : 0,
          }}
        />
        <div className="merchant-shell-nav__inner">
          <Link className="merchant-shell-brand" to="/app" aria-label="AI-Buyense dashboard">
            <span className="merchant-shell-brand__mark" aria-hidden="true">AI</span>
            <span>AI-Buyense</span>
          </Link>
          <nav className="merchant-shell-tabs" aria-label="Merchant app navigation">
            {navItems.map((item) =>
              item.external ? (
                <a className="merchant-shell-tab" key={item.to} href={item.to} target="_top">
                  {item.label} <span aria-hidden="true">&#8599;</span>
                </a>
              ) : (
                <NavLink
                  className={({ isActive }) =>
                    `merchant-shell-tab${isActive ? " merchant-shell-tab--active" : ""}`
                  }
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  prefetch="intent"
                >
                  {item.label}
                </NavLink>
              ),
            )}
          </nav>
        </div>
      </div>

      <div className="merchant-shell-content">
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
