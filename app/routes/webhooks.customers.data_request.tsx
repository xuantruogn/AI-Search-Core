import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);

  // AI Search Bridge does not intentionally persist customer identity data.
  // Search query logs use SHA-256 hashes instead of raw query text.
  console.log("[AI Search] Privacy webhook acknowledged:", { shop, topic });

  return new Response("OK", { status: 200 });
};
