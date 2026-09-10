import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";

import { authenticate } from "../shopify.server";
import { getShopEntitlement } from "../services/commerce/entitlement.server";
import {
  enqueueCatalogRefresh,
  enqueueInitialCatalogSyncIfNeeded,
  getLatestCatalogSyncJob,
  retryLatestFailedCatalogSyncJob,
} from "../services/catalog/catalog-sync-job.server";
import { kickCatalogSyncQueue } from "../services/catalog/catalog-sync-queue.server";
import { reconcileShopCommercialState } from "../services/commerce/reconciliation.server";
import { retryFailedProductSyncJobs } from "../services/products/product-sync-job.server";
import { kickProductSyncQueue } from "../services/products/product-sync-queue.server";
import { listIndexedProducts } from "../services/commerce/indexed-products.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const [entitlement, job, products] = await Promise.all([
    getShopEntitlement(session.shop),
    getLatestCatalogSyncJob(session.shop),
    listIndexedProducts(session.shop, 30),
  ]);

  return {
    shop: session.shop,
    entitlement,
    job,
    products: products.map((product) => ({
      id: product.id,
      productId: product.productId,
      handle: product.handle,
      title: product.title,
      status: product.status,
      documentHash: product.documentHash,
    })),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = String(form.get("intent") || "initial");

  if (intent === "retry_product_jobs") {
    const result = await retryFailedProductSyncJobs(session.shop, 100);
    if (result.requeued > 0) kickProductSyncQueue();

    return {
      success: true,
      jobId: null,
      message: `${result.requeued} product sync job FAILED đã được queue lại.`,
    };
  }

  if (intent === "retry_catalog") {
    const jobId = await retryLatestFailedCatalogSyncJob(session.shop);
    if (jobId) kickCatalogSyncQueue();

    return {
      success: true,
      jobId,
      message: jobId
        ? `Catalog job #${jobId} đã được reset và queue lại.`
        : "Không có catalog job FAILED để retry.",
    };
  }

  if (intent === "reconcile") {
    const result = await reconcileShopCommercialState({
      shop: session.shop,
      forceCatalogRefresh: false,
    });

    return {
      success: true,
      jobId: result.catalogJobId,
      message: `Reconcile xong: pruned ${result.pruned}, recovered ${result.recovered}${
        result.catalogJobId ? `, catalog job #${result.catalogJobId}` : ""
      }.`,
    };
  }

  const jobId =
    intent === "refresh"
      ? await enqueueCatalogRefresh(session.shop, "MANUAL_REFRESH")
      : await enqueueInitialCatalogSyncIfNeeded(session.shop);

  if (jobId) kickCatalogSyncQueue();

  return {
    success: true,
    jobId,
    message: jobId
      ? `Catalog sync job #${jobId} đã được queue.`
      : "Không cần tạo sync mới hoặc subscription chưa active.",
  };
};

export default function CatalogSyncPage() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const limit = data.entitlement.limits.productLimit;

  return (
    <s-page heading="Catalog & Vector Index">
      <s-section heading="Catalog quota">
        <s-stack direction="block" gap="base">
          <s-text>Shop: {data.shop}</s-text>
          <s-text>
            Indexed products: {data.entitlement.indexedProducts} /{" "}
            {limit === null ? "Không giới hạn" : limit}
          </s-text>
          <s-text>
            Initial sync không tính vào quota 50 vector updates; mọi product
            embedding vẫn được log để tính chi phí.
          </s-text>
          <fetcher.Form method="post">
            <input type="hidden" name="intent" value="initial" />
            <s-button
              type="submit"
              {...(fetcher.state !== "idle" ? { loading: true } : {})}
            >
              Queue initial sync nếu cần
            </s-button>
          </fetcher.Form>
          <fetcher.Form method="post">
            <input type="hidden" name="intent" value="refresh" />
            <s-button
              type="submit"
              {...(fetcher.state !== "idle" ? { loading: true } : {})}
            >
              Quét lại toàn bộ catalog
            </s-button>
          </fetcher.Form>
          <fetcher.Form method="post">
            <input type="hidden" name="intent" value="reconcile" />
            <s-button
              type="submit"
              {...(fetcher.state !== "idle" ? { loading: true } : {})}
            >
              Reconcile quota / catalog state
            </s-button>
          </fetcher.Form>
          <fetcher.Form method="post">
            <input type="hidden" name="intent" value="retry_product_jobs" />
            <s-button
              type="submit"
              {...(fetcher.state !== "idle" ? { loading: true } : {})}
            >
              Retry product jobs FAILED
            </s-button>
          </fetcher.Form>
          <fetcher.Form method="post">
            <input type="hidden" name="intent" value="retry_catalog" />
            <s-button
              type="submit"
              {...(fetcher.state !== "idle" ? { loading: true } : {})}
            >
              Retry catalog job FAILED
            </s-button>
          </fetcher.Form>
          {fetcher.data?.message ? (
            <s-text>{fetcher.data.message}</s-text>
          ) : null}
        </s-stack>
      </s-section>

      <s-section heading="Background initial sync">
        {data.job ? (
          <s-stack direction="block" gap="base">
            <s-text>Job #{data.job.id}</s-text>
            <s-text>Status: {data.job.status}</s-text>
            <s-text>Reason: {data.job.reason ?? "—"}</s-text>
            <s-text>Plan lúc bắt đầu: {data.job.planAtStart ?? "—"}</s-text>
            <s-text>Processed: {data.job.productsProcessed}</s-text>
            <s-text>Indexed: {data.job.productsIndexed}</s-text>
            <s-text>Skipped: {data.job.productsSkipped}</s-text>
            <s-text>Blocked: {data.job.productsBlocked}</s-text>
            <s-text>Failed: {data.job.productsFailed}</s-text>
            {data.job.lastError ? (
              <s-text>Error: {data.job.lastError}</s-text>
            ) : null}
          </s-stack>
        ) : (
          <s-text>Chưa có catalog sync job.</s-text>
        )}
      </s-section>

      <s-section heading="Indexed product registry (30 gần nhất)">
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left", padding: 8 }}>Product</th>
                <th style={{ textAlign: "left", padding: 8 }}>Handle</th>
                <th style={{ textAlign: "left", padding: 8 }}>Status</th>
                <th style={{ textAlign: "left", padding: 8 }}>Document hash</th>
              </tr>
            </thead>
            <tbody>
              {data.products.map((product) => (
                <tr key={product.id}>
                  <td style={{ padding: 8, borderTop: "1px solid #eee" }}>
                    {product.title}
                  </td>
                  <td style={{ padding: 8, borderTop: "1px solid #eee" }}>
                    {product.handle}
                  </td>
                  <td style={{ padding: 8, borderTop: "1px solid #eee" }}>
                    {product.status}
                  </td>
                  <td style={{ padding: 8, borderTop: "1px solid #eee" }}>
                    {product.documentHash
                      ? `${product.documentHash.slice(0, 14)}…`
                      : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </s-section>
    </s-page>
  );
}
