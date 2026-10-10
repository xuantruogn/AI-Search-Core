import { randomUUID } from "node:crypto";
import type {
  ActionFunctionArgs,
  LinksFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useActionData, useLoaderData } from "react-router";

import { DevCenterDashboard } from "../components/dev-center-dashboard";
import { handleDevDashboardAction } from "../services/admin/dev-dashboard-actions.server";
import { getDevDashboardData } from "../services/admin/dev-dashboard.server";
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
  const dashboard = await getDevDashboardData(url.searchParams.get("q") ?? "");

  return {
    dashboard,
    managedShop: url.searchParams.get("manage"),
    devUser: { email: user.email, role: user.role },
    csrfToken: user.csrfToken,
    grantRequestId: randomUUID(),
  };
}

export async function action(args: ActionFunctionArgs) {
  return handleDevDashboardAction(args);
}

export default function DevDashboardRoute() {
  const data = useLoaderData<typeof loader>();
  const feedback = useActionData<typeof action>();

  return (
    <DevCenterDashboard
      data={data.dashboard}
      devUser={data.devUser}
      csrfToken={data.csrfToken}
      grantRequestId={data.grantRequestId}
      managedShop={data.managedShop}
      feedback={feedback}
    />
  );
}
