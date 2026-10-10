import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  isValidComplianceWebhookHmac,
  verifyComplianceWebhookHmac,
} from "../app/services/privacy/compliance-webhook-auth.server";

const topics = [
  ["customers/data_request", "/webhooks/customers/data_request", "app/routes/webhooks.customers.data_request.tsx"],
  ["customers/redact", "/webhooks/customers/redact", "app/routes/webhooks.customers.redact.tsx"],
  ["shop/redact", "/webhooks/shop/redact", "app/routes/webhooks.shop.redact.tsx"],
] as const;

for (const file of [
  "shopify.app.toml",
  "shopify.app.ai-buyense.toml",
  "shopify.app.buyense-search-trung.toml",
]) {
  const toml = readFileSync(file, "utf8");
  for (const [topic, uri, route] of topics) {
    const clause = `compliance_topics = ["${topic}"]\nuri = "${uri}"`;
    assert.ok(toml.includes(clause), `${file} missing webhook subscription ${topic}`);
    assert.ok(readFileSync(route, "utf8").includes("verifyComplianceWebhookHmac(request)"), `${route} must verify HMAC`);
  }
}

const body = JSON.stringify({ shop_domain: "example.myshopify.com", customer: { id: 123 } });
const secret = "not-a-real-shopify-secret-for-ci";
const hmac = createHmac("sha256", secret).update(body).digest("base64");
assert.equal(isValidComplianceWebhookHmac(body, hmac, secret), true);
assert.equal(isValidComplianceWebhookHmac(body, null, secret), false);
assert.equal(isValidComplianceWebhookHmac(body, "not-base64", secret), false);
assert.equal(isValidComplianceWebhookHmac(body + " ", hmac, secret), false);
assert.equal(isValidComplianceWebhookHmac(body, hmac, "a-different-secret"), false);

const previousSecret = process.env.SHOPIFY_API_SECRET;
process.env.SHOPIFY_API_SECRET = secret;
try {
  const request = (signature: string | null) => new Request("https://app.example.com/webhooks/shop/redact", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(signature ? { "X-Shopify-Hmac-Sha256": signature } : {}),
    },
    body,
  });
  const validRequest = request(hmac);
  await verifyComplianceWebhookHmac(validRequest);
  assert.equal(await validRequest.text(), body, "HMAC middleware must not consume the original request");

  for (const signature of [null, "invalid", createHmac("sha256", "wrong-secret").update(body).digest("base64")]) {
    await assert.rejects(
      verifyComplianceWebhookHmac(request(signature)),
      (error: unknown) => error instanceof Response && error.status === 401,
    );
  }
} finally {
  if (previousSecret === undefined) delete process.env.SHOPIFY_API_SECRET;
  else process.env.SHOPIFY_API_SECRET = previousSecret;
}

console.log("PASS Shopify privacy compliance: all TOMLs subscribed; valid HMAC accepted; invalid/missing/tampered HMAC rejected 401; request body preserved");
