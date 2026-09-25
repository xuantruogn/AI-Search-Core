import type { LoaderFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";
import { getLatestCatalogSyncJob } from "../services/catalog/catalog-sync-job.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const job = await getLatestCatalogSyncJob(session.shop);

  return {
    job,
  };
};