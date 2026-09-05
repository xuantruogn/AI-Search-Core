import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);

  // No customer-level records are stored by the app.
  console.log("[AI Search] Privacy webhook acknowledged:", { shop, topic });

  return new Response("OK", { status: 200 });
};
