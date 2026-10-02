import type {
  ActionFunctionArgs,
  LinksFunction,
  LoaderFunctionArgs,
} from "react-router";
import { Form, data, redirect, useActionData, useLoaderData } from "react-router";

import {
  createDevMfaChallenge,
  findDevUserByEmail,
  getDevSession,
  normalizeDevEmail,
  verifyDevPassword,
} from "../services/dev-auth.server";
import { writeDevAudit } from "../services/dev-audit.server";
import {
  assertDevOrigin,
  assertLoginCsrf,
  assertThrottleAllowed,
  clearLoginCsrfCookie,
  createLoginCsrf,
  devSecurityHeaders,
  recordThrottleFailure,
  requestIp,
} from "../services/dev-security.server";
import devCenterCss from "../styles/dev-center.css?url";

export const links: LinksFunction = () => [
  { rel: "stylesheet", href: devCenterCss },
];

export function headers() {
  return devSecurityHeaders();
}

export async function loader({ request }: LoaderFunctionArgs) {
  if (await getDevSession(request)) throw redirect("/dev");
  const csrf = createLoginCsrf();
  return data({ csrfToken: csrf.token }, { headers: { "Set-Cookie": csrf.header } });
}

export async function action({ request }: ActionFunctionArgs) {
  assertDevOrigin(request);
  const form = await request.formData();
  assertLoginCsrf(request, form.get("_csrf"));

  const email = normalizeDevEmail(String(form.get("email") ?? ""));
  const password = String(form.get("password") ?? "");
  const ip = requestIp(request);

  await assertThrottleAllowed("LOGIN_IP", ip);
  await assertThrottleAllowed("LOGIN_ACCOUNT", email);

  const user = await findDevUserByEmail(email);
  const valid = Boolean(user && Boolean(user.isActive) && await verifyDevPassword(user.passwordHash, password));

  if (!valid || !user) {
    await Promise.all([
      recordThrottleFailure("LOGIN_IP", ip),
      recordThrottleFailure("LOGIN_ACCOUNT", email),
      writeDevAudit({
        request,
        devUserId: user?.id ?? null,
        action: "DEV_LOGIN_FAILED",
        result: "DENIED",
        metadata: { email },
      }),
    ]);
    return data({ error: "Invalid credentials" }, { status: 401 });
  }

  const challenge = await createDevMfaChallenge(user.id, request);
  await writeDevAudit({
    request,
    devUserId: user.id,
    action: "DEV_PASSWORD_VERIFIED",
    result: "SUCCESS",
  });

  throw redirect("/dev/mfa", {
    headers: [
      ["Set-Cookie", challenge.header],
      ["Set-Cookie", clearLoginCsrfCookie()],
    ],
  });
}

export default function DevLogin() {
  const { csrfToken } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  return (
    <main className="dc-auth-page">
      <section className="dc-auth-card">
        <div className="dc-auth-brand"><span>B</span><div><strong>AI-Buyense</strong><small>Internal Dev Center</small></div></div>
        <div className="dc-auth-heading">
          <p>Restricted access</p>
          <h1>Sign in to Dev Center</h1>
          <span>Use your internal administrator credentials to continue.</span>
        </div>
        {actionData?.error ? <div className="dc-alert is-error">{actionData.error}</div> : null}
        <Form method="post" reloadDocument className="dc-auth-form">
          <input type="hidden" name="_csrf" value={csrfToken} />
          <label><span>Email address</span><input name="email" type="email" autoComplete="username" required /></label>
          <label><span>Password</span><input name="password" type="password" autoComplete="current-password" required /></label>
          <button className="dc-button dc-button-primary" type="submit">Continue securely</button>
        </Form>
        <div className="dc-auth-foot"><i /> Password and TOTP verification required</div>
      </section>
    </main>
  );
}
