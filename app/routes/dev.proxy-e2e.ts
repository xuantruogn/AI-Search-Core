import crypto from "node:crypto";
import type { LoaderFunctionArgs } from "react-router";
import db from "../db.server";
import { loader as proxyLoader } from "./proxy.ai-search";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (process.env.NODE_ENV === "production") {
    return new Response("Not found", { status: 404 });
  }
  const input = new URL(request.url);
  const q = input.searchParams.get("q")?.trim() ?? "";
  const theme = await db.aiSearchThemeMapV4.findFirst({
    where: { shop: "dev-app-6fvh2isn.myshopify.com", mapStatus: "VERIFIED" },
    orderBy: { updatedAt: "desc" },
    select: { themeId: true, verifiedFingerprint: true, fingerprint: true },
  });
  const params: Record<string, string> = {
    format: "json",
    native_search_url: `/search?q=${encodeURIComponent(q)}&type=product`,
    page: "1",
    path_prefix: "/apps/ai-search",
    q,
    shop: "dev-app-6fvh2isn.myshopify.com",
    timestamp: Math.floor(Date.now() / 1000).toString(),
  };
  if (theme) {
    params.theme_id = theme.themeId;
    params.map_fingerprint = theme.verifiedFingerprint || theme.fingerprint;
  }
  const payload = Object.entries(params)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("");
  params.signature = crypto
    .createHmac("sha256", process.env.SHOPIFY_API_SECRET || "")
    .update(payload)
    .digest("hex");
  const signedUrl = new URL("/proxy/ai-search", request.url);
  for (const [key, value] of Object.entries(params)) signedUrl.searchParams.set(key, value);
  return proxyLoader({ request: new Request(signedUrl), params: {}, context: {} } as LoaderFunctionArgs);
};
