import type {
  ActionFunctionArgs,
  LinksFunction,
  LoaderFunctionArgs,
} from "react-router";
import { Form, data, redirect, useActionData, useLoaderData } from "react-router";

import {
  createDevSession,
  failDevMfaChallenge,
  getDevMfaChallenge,
  verifyDevUserTotp,
} from "../services/dev-auth.server";
import { writeDevAudit } from "../services/dev-audit.server";
import {
  assertDevOrigin,
  assertLoginCsrf,
  assertThrottleAllowed,
  clearLoginCsrfCookie,
  clearThrottle,
  createLoginCsrf,
  devSecurityHeaders,
  hashRequestIp,
  recordThrottleFailure,
} from "../services/dev-security.server";
import devCenterCss from "../styles/dev-center.css?url";

export const links: LinksFunction = () => [
  { rel: "stylesheet", href: devCenterCss },
];

export function headers() {
  return devSecurityHeaders();
}

export async function loader({ request }: LoaderFunctionArgs) {
  const challenge = await getDevMfaChallenge(request);
  if (!challenge) throw redirect("/dev/login");
  const csrf = createLoginCsrf();
  return data(
    { csrfToken: csrf.token, email: challenge.email },
    { headers: { "Set-Cookie": csrf.header } },
  );
}

export async function action({ request }: ActionFunctionArgs) {
  assertDevOrigin(request);
  const form = await request.formData();
  assertLoginCsrf(request, form.get("_csrf"));

  const challenge = await getDevMfaChallenge(request);
  if (!challenge) throw redirect("/dev/login");

  const throttleKey = `${challenge.userId}:${hashRequestIp(request)}`;
  await assertThrottleAllowed("MFA", throttleKey);

  if (challenge.attempts >= 6 || !verifyDevUserTotp(challenge.totpSecretEncrypted, String(form.get("code") ?? ""))) {
    await failDevMfaChallenge(challenge.id);
    await recordThrottleFailure("MFA", throttleKey);
    await writeDevAudit({
      request,
      devUserId: challenge.userId,
      action: "DEV_MFA_FAILED",
      result: "DENIED",
    });
    return data({ error: "Invalid authentication code" }, { status: 401 });
  }

  await clearThrottle("MFA", throttleKey);
  const session = await createDevSession(challenge.userId, request);
  await writeDevAudit({
    request,
    devUserId: challenge.userId,
    action: "DEV_LOGIN_SUCCESS",
    result: "SUCCESS",
  });

  throw redirect("/dev", {
    headers: [
      ...session.headers.map((value) => ["Set-Cookie", value] as [string, string]),
      ["Set-Cookie", clearLoginCsrfCookie()],
    ],
  });
}

export default function DevMfa() {
  const { csrfToken, email } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  return (
    <main className="dc-auth-page">
      <section className="dc-auth-card">
        <div className="dc-auth-brand"><span>B</span><div><strong>AI-Buyense</strong><small>Internal Dev Center</small></div></div>
        <div className="dc-auth-heading">
          <p>Identity verification</p>
          <h1>Two-factor authentication</h1>
          <span>Enter the six-digit code for <strong>{email}</strong>.</span>
        </div>
        {actionData?.error ? <div className="dc-alert is-error">{actionData.error}</div> : null}
        <Form method="post" reloadDocument className="dc-auth-form">
          <input type="hidden" name="_csrf" value={csrfToken} />
          <label><span>Authentication code</span><input className="dc-auth-code" name="code" inputMode="numeric" pattern="[0-9]{6}" autoComplete="one-time-code" required maxLength={6} placeholder="000000" /></label>
          <button className="dc-button dc-button-primary" type="submit">Verify and sign in</button>
        </Form>
        <div className="dc-auth-foot"><i /> Session protected by server-side authentication</div>
      </section>
    </main>
  );
}
