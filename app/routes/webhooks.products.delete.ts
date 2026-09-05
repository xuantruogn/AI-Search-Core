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

  // DELETE không cần Admin API, nhưng vẫn đi qua cùng durable queue
  // để có dedupe, retry và recovery nếu Qdrant tạm lỗi.
  kickProductSyncQueue();

  if (enqueueResult.duplicate) {
    console.log("[AI Search] PRODUCTS_DELETE duplicate acknowledged:", {
      webhookId,
      jobId: enqueueResult.jobId,
    });
  }

  return new Response("OK", {
    status: 200,
  });
};
