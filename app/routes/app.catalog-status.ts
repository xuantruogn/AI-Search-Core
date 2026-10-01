import type { LoaderFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";
import { getLatestCatalogSyncJob } from "../services/catalog/catalog-sync-job.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const debugId = crypto.randomUUID().slice(0, 8);
  console.log("[CATALOG DEBUG] status:start", { debugId, method: request.method, url: request.url });
  const { session } = await authenticate.admin(request);
  console.log("[CATALOG DEBUG] status:authenticated", { debugId, shop: session.shop });

  const job = await getLatestCatalogSyncJob(session.shop);
  console.log("[CATALOG DEBUG] status:db-read", {
    debugId, shop: session.shop, jobId: job?.id ?? null, status: job?.status ?? null,
    productsProcessed: job?.productsProcessed ?? 0, productsIndexed: job?.productsIndexed ?? 0,
  });

  return {
    job,
  };
};