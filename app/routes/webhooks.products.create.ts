import type { ActionFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";
import { enqueueProductSyncJob } from "../services/products/product-sync-job.server";
import { kickProductSyncQueue } from "../services/products/product-sync-queue.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload, webhookId } =
    await authenticate.webhook(request);

  console.log("[AI Search] Webhook received:", {
    webhookId,
    topic,
    shop,
    productId: payload.id,
  });

  const enqueueResult = await enqueueProductSyncJob({
    shop,
    webhookId,
    topic,
    productId: payload.id,
  });

  // Không await OpenAI / Shopify Admin / Qdrant trong webhook request.
  // Job đã durable trong DB, worker sẽ tự lấy offline Admin session.
  kickProductSyncQueue();

  if (enqueueResult.duplicate) {
    console.log("[AI Search] PRODUCTS_CREATE duplicate acknowledged:", {
      webhookId,
      jobId: enqueueResult.jobId,
    });
  }

  return new Response("OK", {
    status: 200,
  });
};
