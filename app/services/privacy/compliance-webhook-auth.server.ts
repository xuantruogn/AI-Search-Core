import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Mandatory compliance webhook verification must not depend on an installed
 * merchant session: Shopify sends shop/redact after app uninstall.
 * Validate the raw request bytes before passing the original Request to
 * Shopify's webhook authenticator.
 */
export function isValidComplianceWebhookHmac(
  rawBody: string,
  suppliedHmac: string | null,
  secret: string,
): boolean {
  if (!secret || !suppliedHmac || !/^[A-Za-z0-9+/]{43}=$/.test(suppliedHmac)) {
    return false;
  }
  const supplied = Buffer.from(suppliedHmac, "base64");
  if (supplied.length !== 32) return false;
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest();
  return timingSafeEqual(expected, supplied);
}

export async function verifyComplianceWebhookHmac(request: Request): Promise<void> {
  const secret = process.env.SHOPIFY_API_SECRET?.trim();
  if (!secret) {
    // Missing server configuration is not a client auth failure.
    throw new Response("Webhook authentication unavailable", { status: 503 });
  }

  const body = await request.clone().text();
  if (!isValidComplianceWebhookHmac(
    body,
    request.headers.get("X-Shopify-Hmac-Sha256"),
    secret,
  )) {
    throw new Response("Unauthorized", { status: 401 });
  }
}
