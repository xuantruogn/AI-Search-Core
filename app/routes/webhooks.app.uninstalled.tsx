import type { ActionFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";
import db from "../db.server";
import { markShopUninstalled } from "../services/commerce/shop-registry.server";
import { invalidateThemeMap } from "../services/theme/theme-map-lifecycle.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);

  console.log(`[AI Search] Received ${topic} webhook for ${shop}`);

  // Remove renderer/rejection state from this process immediately. A later
  // reinstall for the same shop must start from its then-current MAIN theme.
  invalidateThemeMap(shop);

  try {
    await markShopUninstalled(shop);
  } catch (error) {
    // Older Phase-1 databases may receive uninstall before the commercial
    // migration is deployed. Session cleanup must still succeed.
    console.error("[AI Search] Failed to mark shop uninstalled:", error);
  }

  // Remove every online/offline session for the shop. Authentication can
  // legitimately return no concrete session for a webhook, but stale session
  // rows must never survive an uninstall and later be reused accidentally.
  await db.session.deleteMany({ where: { shop } });

  return new Response("OK", { status: 200 });
};
