import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { verifyComplianceWebhookHmac } from "../services/privacy/compliance-webhook-auth.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  await verifyComplianceWebhookHmac(request);
  const { shop, topic } = await authenticate.webhook(request);

  // Search history stores raw free-text queries; shoppers can enter personal data.
  // These records are not linked to Shopify customer IDs, so this delivery
  // cannot be used to attribute or export a specific customer's searches.
  // Acknowledgement is not proof that a customer-data request is fulfilled.
  console.log("[AI Search] Privacy webhook acknowledged:", { shop, topic });

  return new Response("OK", { status: 200 });
};
