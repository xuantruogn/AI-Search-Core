import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";

import { destroyDevSession, requireDevUser } from "../services/dev-auth.server";
import { writeDevAudit } from "../services/dev-audit.server";
import {
  assertDevCsrf,
  assertDevOrigin,
  devSecurityHeaders,
  readDevSessionToken,
} from "../services/dev-security.server";

export function headers() {
  return devSecurityHeaders();
}

export async function loader({ request }: LoaderFunctionArgs) {
  void request;
  throw new Response("Not found", { status: 404 });
}

export async function action({ request }: ActionFunctionArgs) {
  const user = await requireDevUser(request);
  assertDevOrigin(request);

  const token = readDevSessionToken(request);
  if (!token) throw new Response("Forbidden", { status: 403 });

  const form = await request.formData();
  assertDevCsrf(token, form.get("_csrf"));

  await writeDevAudit({
    request,
    devUserId: user.id,
    action: "DEV_LOGOUT",
    result: "SUCCESS",
  });
  const clearCookie = await destroyDevSession(request);

  throw redirect("/dev/login", { headers: { "Set-Cookie": clearCookie } });
}

export default function DevLogoutRoute() {
  return null;
}
