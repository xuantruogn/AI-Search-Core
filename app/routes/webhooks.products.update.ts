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

  // Shopify nhận 200 ngay sau khi job được ghi DB.
  // Embedding/Qdrant được xử lý ngoài vòng đời request này.
  kickProductSyncQueue();

  if (enqueueResult.duplicate) {
    console.log("[AI Search] PRODUCTS_UPDATE duplicate acknowledged:", {
      webhookId,
      jobId: enqueueResult.jobId,
    });
  }

  return new Response("OK", {
    status: 200,
  });
};
