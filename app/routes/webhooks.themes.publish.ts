import type { ActionFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";
import { invalidateThemeRendererCache } from "../services/theme/theme-renderer-profile.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload, webhookId } = await authenticate.webhook(request);

  const normalizedTopic = String(topic ?? "").trim().toUpperCase();
  const normalizedRole = String(payload?.role ?? "").trim().toLowerCase();
  const affectsActiveTheme =
    normalizedTopic === "THEMES_PUBLISH" ||
    normalizedRole === "main" ||
    // Be conservative when a future payload shape omits role.
    normalizedRole.length === 0;

  // App Embed activation remains merchant-controlled. Publishing a theme only
  // invalidates compiled renderer state; the next Admin status check / eligible
  // storefront request reads the new MAIN theme and its settings.
  if (affectsActiveTheme) invalidateThemeRendererCache(shop);

  console.log("[AI Search] Theme lifecycle event received:", {
    shop,
    topic,
    webhookId,
    themeId: payload?.id ?? null,
    role: payload?.role ?? null,
    cacheInvalidated: affectsActiveTheme,
  });

  return new Response("OK", { status: 200 });
};
