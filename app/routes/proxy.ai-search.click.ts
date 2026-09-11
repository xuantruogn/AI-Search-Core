import type { ActionFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";
import { recordSearchProductClick } from "../services/search/search-analytics.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.public.appProxy(request);
  if (!session) return new Response(null, { status: 401 });

  const contentType = request.headers.get("content-type") || "";
  let searchLogId = "";
  let productId = "";

  if (contentType.includes("application/json")) {
    const body = (await request.json()) as {
      searchLogId?: unknown;
      productId?: unknown;
    };
    searchLogId =
      typeof body.searchLogId === "string" ? body.searchLogId.trim() : "";
    productId = typeof body.productId === "string" ? body.productId.trim() : "";
  } else {
    const body = await request.formData();
    searchLogId = String(body.get("searchLogId") || "").trim();
    productId = String(body.get("productId") || "").trim();
  }

  if (!searchLogId || !productId) {
    return Response.json({ ok: false, error: "INVALID_CLICK" }, { status: 400 });
  }

  const recorded = await recordSearchProductClick({
    shop: session.shop,
    searchLogId,
    productId,
  });

  return Response.json(
    { ok: recorded },
    { status: recorded ? 200 : 404, headers: { "Cache-Control": "no-store" } },
  );
};

export const loader = async () =>
  new Response(null, { status: 405, headers: { Allow: "POST" } });
