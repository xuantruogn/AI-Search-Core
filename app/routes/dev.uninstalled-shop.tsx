import type { LinksFunction, LoaderFunctionArgs } from "react-router";
import { Form, Link, useLoaderData, useNavigation } from "react-router";

import { DevCenterSidebar, DevLoader } from "../components/dev-center-dashboard";
import { getDevUninstalledShopsData } from "../services/admin/dev-uninstalled-shops.server";
import { requireDevPermission } from "../services/dev-auth.server";
import { devSecurityHeaders } from "../services/dev-security.server";
import devCenterCss from "../styles/dev-center.css?url";

export const links: LinksFunction = () => [
  { rel: "stylesheet", href: devCenterCss },
];

export function headers() {
  return devSecurityHeaders();
}

export async function loader({ request }: LoaderFunctionArgs) {
  const user = await requireDevPermission(request, "shops.read");
  const url = new URL(request.url);
  const data = await getDevUninstalledShopsData(url.searchParams.get("q") ?? "");

  return {
    data,
    devUser: { email: user.email, role: user.role },
    csrfToken: user.csrfToken,
  };
}

export default function DevUninstalledShopRoute() {
  const { data, devUser, csrfToken } = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";

  return (
    <div className="dc-shell">
      {busy ? <DevLoader label="Loading Uninstalled Shops..." /> : null}

      <DevCenterSidebar active="uninstalled" />

      <main className="dc-main">
        <header className="dc-header">
          <div>
            <p className="dc-kicker">Merchant lifecycle</p>
            <h1>Uninstalled Shops</h1>
            <p className="dc-header-sub">
              Review shops that have uninstalled AI-Buyense and inspect the recorded uninstall event.
            </p>
          </div>

          <div className="dc-user">
            <span className="dc-avatar">{devUser.email.slice(0, 1).toUpperCase()}</span>
            <div>
              <strong>{devUser.email}</strong>
              <small>{devUser.role}</small>
            </div>
            <Form method="post" action="/dev/logout">
              <input type="hidden" name="_csrf" value={csrfToken} />
              <button className="dc-button dc-button-ghost" type="submit">Sign out</button>
            </Form>
          </div>
        </header>

        <section className="dc-section">
          <div className="dc-section-head">
            <div>
              <p className="dc-section-eyebrow">Lifecycle records</p>
              <h2>Shops that removed the app</h2>
              <p className="dc-section-note">
                {data.shops.length} matching shop{data.shops.length === 1 ? "" : "s"} · data is sourced from AiSearchShop and APP_UNINSTALLED billing events.
              </p>
            </div>
            <Form method="get" className="dc-search">
              <input
                name="q"
                defaultValue={data.query}
                placeholder="Search shop domain"
                aria-label="Search uninstalled shop domain"
              />
              <button className="dc-button" type="submit">Search</button>
            </Form>
          </div>

          <div className="dc-table-panel">
            <div className="dc-table-scroll">
              <table className="dc-table">
                <thead>
                  <tr>
                    <th>Shop</th>
                    <th>Lifecycle</th>
                    <th>Uninstalled at</th>
                    <th>Plan before uninstall</th>
                    <th>Subscription</th>
                    <th>Subscription GID</th>
                    <th>Webhook</th>
                  </tr>
                </thead>
                <tbody>
                  {data.shops.map((shop) => (
                    <tr key={shop.shop}>
                      <td>
                        <strong className="dc-shop-name">{shop.shop}</strong>
                        <small>Previous status: {shop.previousStatus ?? "—"}</small>
                      </td>
                      <td><StatusBadge>UNINSTALLED</StatusBadge></td>
                      <td>
                        <strong>{formatDate(shop.uninstalledAt)}</strong>
                        <small>Event: {formatDate(shop.eventOccurredAt)}</small>
                      </td>
                      <td>
                        <strong>{shop.currentPlanHandle ?? "—"}</strong>
                      </td>
                      <td>
                        <StatusBadge>{shop.subscriptionStatus ?? "—"}</StatusBadge>
                      </td>
                      <td>
                        <span className="dc-query-trace">{shop.subscriptionGid ?? "—"}</span>
                      </td>
                      <td>
                        <span className="dc-query-trace">{shop.webhookId ?? "—"}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {data.shops.length === 0 ? (
              <div className="dc-empty">No uninstalled shops match this filter.</div>
            ) : null}
          </div>
        </section>
      </main>
    </div>
  );
}

function StatusBadge({ children }: { children: string }) {
  return <span className="dc-badge is-danger"><i />{children}</span>;
}

function formatDate(value: string | null) {
  if (!value) return "—";
  return new Date(value).toLocaleString();
}
