import type { ActionFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { payload, topic, shop } = await authenticate.webhook(request);
  console.log(`[AI Search] Received ${topic} webhook for ${shop}`);

  const current = Array.isArray(payload.current)
    ? payload.current.filter(
        (scope): scope is string => typeof scope === "string",
      )
    : [];

  // Scope changes apply to the app installation, not just whichever session
  // Shopify happened to attach to this webhook. Update all stored sessions for
  // the tenant and acknowledge even when no session row exists yet.
  await db.session.updateMany({
    where: { shop },
    data: { scope: current.join(",") },
  });

  return new Response("OK", { status: 200 });
};
