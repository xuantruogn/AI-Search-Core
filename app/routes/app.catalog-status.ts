import type { LoaderFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";
import { getLatestCatalogSyncJob } from "../services/catalog/catalog-sync-job.server";
import { getProductSyncQueueStats } from "../services/products/product-sync-job.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const debugId = crypto.randomUUID().slice(0, 8);
  console.log("[CATALOG DEBUG] status:start", { debugId, method: request.method, url: request.url });
  const { session } = await authenticate.admin(request);
  console.log("[CATALOG DEBUG] status:authenticated", { debugId, shop: session.shop });

  const [job, queue] = await Promise.all([
    getLatestCatalogSyncJob(session.shop),
    getProductSyncQueueStats(session.shop),
  ]);
  console.log("[CATALOG DEBUG] status:db-read", {
    debugId,
    shop: session.shop,
    jobId: job?.id ?? null,
    status: job?.status ?? null,
    productsProcessed: job?.productsProcessed ?? 0,
    productsIndexed: job?.productsIndexed ?? 0,
    queue,
  });

  const status = (job?.status ?? "NOT_STARTED").toUpperCase();
  const queueBusy = queue.pending > 0 || queue.processing > 0;
  const jobBusy = ["PENDING", "PROCESSING", "RUNNING"].includes(status);
  const failed =
    status === "FAILED" ||
    Boolean(job?.lastError) ||
    (job?.productsFailed ?? 0) > 0;

  return Response.json({
    updatedAt: new Date().toISOString(),
    busy: jobBusy || queueBusy,
    failed,
    ready:
      status === "DONE" &&
      !failed &&
      !queueBusy,
    status: failed
      ? "FAILED"
      : jobBusy || queueBusy
        ? "PROCESSING"
        : status,
    job: job
      ? {
          id: job.id,
          status: job.status,
          productsProcessed: job.productsProcessed,
          productsIndexed: job.productsIndexed,
          productsSkipped: job.productsSkipped,
          productsBlocked: job.productsBlocked,
          productsFailed: job.productsFailed,
          pagesProcessed: job.pagesProcessed,
          updatedAt:
            job.updatedAt instanceof Date
              ? job.updatedAt.toISOString()
              : String(job.updatedAt),
          lastError: job.lastError,
        }
      : null,
    queue,
  }, {
    headers: {
      "Cache-Control": "no-store, max-age=0",
    },
  });
};
