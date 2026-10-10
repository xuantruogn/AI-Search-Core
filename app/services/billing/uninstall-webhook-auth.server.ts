import { createHmac, timingSafeEqual } from "node:crypto";
import type { Prisma } from "@prisma/client";

// Uninstall revokes Admin credentials. Authenticate the signed raw delivery,
// never load/refresh an offline session to authorize this lifecycle event.
export async function authenticateUninstallDelivery(request: Request, secret: string) {
  if (request.method !== "POST") throw new Response(null,{status:405});
  if (!secret) throw new Response(null,{status:503});
  const signature = request.headers.get("X-Shopify-Hmac-Sha256") ?? "";
  const raw = await request.text();
  const expected = createHmac("sha256",secret).update(raw).digest();
  const received = Buffer.from(signature,"base64");
  if (received.length !== expected.length || !timingSafeEqual(received,expected)) throw new Response(null,{status:401});
  const shop = request.headers.get("X-Shopify-Shop-Domain") ?? "";
  const webhookId = request.headers.get("X-Shopify-Webhook-Id");
  if (request.headers.get("X-Shopify-Topic") !== "app/uninstalled" || !webhookId || !request.headers.get("X-Shopify-Api-Version") || !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop)) throw new Response(null,{status:400});
  let payload: Prisma.JsonObject;
  try { payload = JSON.parse(raw); } catch { throw new Response(null,{status:400}); }
  // Bind the signed shop payload to the routing header, preventing a captured
  // signed delivery from being replayed against a different shop's records.
  if (!payload || typeof payload !== "object" || payload.myshopify_domain !== shop) throw new Response(null,{status:400});
  return {shop,webhookId,topic:"APP_UNINSTALLED",payload};
}
