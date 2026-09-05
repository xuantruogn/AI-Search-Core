import type { ActionFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";
import db from "../db.server";
import { deleteShopCommercialData } from "../services/commerce/shop-registry.server";
import { deleteShopProductVectors } from "../services/search/vector-store.server";
import { ensureProductCollection } from "../services/search/qdrant.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);

  console.log("[AI Search] Shop redact started:", { shop, topic });

  try {
    await ensureProductCollection();
    await deleteShopProductVectors(shop);
  } catch (error) {
    console.error("[AI Search] Qdrant shop cleanup failed:", {
      shop,
      error: error instanceof Error ? error.message : String(error),
    });

    // Return 500 so Shopify can retry the compliance webhook instead of
    // silently leaving vector data behind.
    return new Response("Vector cleanup failed", { status: 500 });
  }

  await db.session.deleteMany({ where: { shop } });
  await deleteShopCommercialData(shop);

  console.log("[AI Search] Shop redact completed:", { shop });

  return new Response("OK", { status: 200 });
};
