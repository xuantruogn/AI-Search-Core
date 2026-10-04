import type {
  ActionFunctionArgs,
  LinksFunction,
  LoaderFunctionArgs,
} from "react-router";
import {
  Form,
  Link,
  useActionData,
  useLoaderData,
  useNavigation,
} from "react-router";

import { DevLoader, PlanCatalogEditor } from "../components/dev-center-dashboard";
import { handleDevDashboardAction } from "../services/admin/dev-dashboard-actions.server";
import { getDevPlanConfigurationData } from "../services/admin/dev-plan-configuration.server";
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
  const planConfiguration = await getDevPlanConfigurationData();

  return {
    planConfiguration,
    devUser: { email: user.email, role: user.role },
    csrfToken: user.csrfToken,
  };
}

export async function action(args: ActionFunctionArgs) {
  return handleDevDashboardAction(args);
}

export default function DevPlanConfigurationRoute() {
  const { planConfiguration, devUser, csrfToken } =
    useLoaderData<typeof loader>();
  const feedback = useActionData<typeof action>();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";
  const canWrite = devUser.role === "OWNER" || devUser.role === "ADMIN";

  return (
    <div className="dc-shell">
      {busy ? (
        <DevLoader
          label={navigation.state === "submitting" ? "Saving plan..." : "Loading Plan Configuration..."}
        />
      ) : null}
      <aside className="dc-sidebar">
        <div className="dc-brand">
          <span className="dc-brand-mark">B</span>
          <span>
            <strong>AI-Buyense</strong>
            <small>Internal Dev Center</small>
          </span>
        </div>

        <nav className="dc-nav" aria-label="Dev Center navigation">
          <Link to="/dev#overview"><span>01</span>Overview</Link>
          <Link to="/dev#shops"><span>02</span>Shops</Link>
          <Link to="/dev/search-history"><span>03</span>Search History</Link>
          <Link className="is-active" to="/dev/plan-configuration">
            <span>04</span>Plan Configuration
          </Link>
          <Link to="/dev#plans"><span>05</span>Revenue</Link>
          <Link to="/dev#usage"><span>06</span>Usage & Cost</Link>
          <Link to="/dev#audit"><span>07</span>Audit</Link>
        </nav>

        <div className="dc-sidebar-meta">
          <span className="dc-system-dot" />
          <div>
            <strong>Internal access</strong>
            <small>MFA protected session</small>
          </div>
        </div>
      </aside>
      <main className="dc-main">
        <header className="dc-header">
          <div>
            <p className="dc-kicker">Commercial configuration</p>
            <h1>Plan Configuration</h1>
            <p className="dc-header-sub">
              Create and manage app plans, pricing, quotas and included capabilities.
            </p>
          </div>
          <div className="dc-user">
            <span className="dc-avatar">
              {devUser.email.slice(0, 1).toUpperCase()}
            </span>
            <div>
              <strong>{devUser.email}</strong>
              <small>{devUser.role}</small>
            </div>
            <Form method="post" action="/dev/logout">
              <input type="hidden" name="_csrf" value={csrfToken} />
              <button className="dc-button dc-button-ghost" type="submit">
                Sign out
              </button>
            </Form>
          </div>
        </header>

        {feedback ? (
          <div className={`dc-alert ${feedback.ok ? "is-success" : "is-error"}`}>
            {feedback.message}
          </div>
        ) : null}

        <section className="dc-section">
          <div className="dc-kpi-grid">
            <Metric
              label="Configured plans"
              value={String(planConfiguration.plans.length)}
              note="All plan definitions"
            />
            <Metric
              label="Active plans"
              value={String(planConfiguration.plans.filter((plan) => plan.isActive).length)}
              note="Available for current commercial flow"
            />
            <Metric
              label="Active subscriptions"
              value={String(planConfiguration.plans.reduce((sum, plan) => sum + plan.subscriptions.active, 0))}
              note="Billing V2 subscriptions linked to plans"
            />
          </div>

          <PlanCatalogEditor
            plans={planConfiguration.plans}
            csrfToken={csrfToken}
            canWrite={canWrite}
            busy={busy}
          />
        </section>
      </main>
    </div>
  );
}
function Metric({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note: string;
}) {
  return (
    <article className="dc-metric">
      <small>{label}</small>
      <strong>{value}</strong>
      <span>{note}</span>
    </article>
  );
}
