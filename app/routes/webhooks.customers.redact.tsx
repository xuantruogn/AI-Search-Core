import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);

  // Search logs and result receipts can contain shopper-entered free text,
  // but are not keyed by Shopify customer ID. This acknowledgement cannot
  // identify or selectively remove an individual's unlinked search records.
  console.log("[AI Search] Privacy webhook acknowledged:", { shop, topic });

  return new Response("OK", { status: 200 });
};
