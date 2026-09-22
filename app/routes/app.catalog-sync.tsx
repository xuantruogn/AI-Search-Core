import { useEffect } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useNavigate } from "react-router";

import { authenticate } from "../shopify.server";
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

  const [job, products] = await Promise.all([
    getLatestCatalogSyncJob(session.shop),
    listIndexedProducts(session.shop, 30),
  ]);

  return {
    shop: session.shop,
    job,
    products: products.map((product) => ({
      id: product.id,
      productId: product.productId,
      handle: product.handle,
      title: product.title,
      status: product.status,
      hasVector: Boolean(product.documentHash),
    })),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = String(form.get("intent") || "sync_auto");

  // RESCUE ACTION: Retry both Product Jobs and Catalog Jobs that FAILED
  if (intent === "retry_all_failed") {
    const productResult = await retryFailedProductSyncJobs(session.shop, 100);
    if (productResult.requeued > 0) kickProductSyncQueue();

    const catalogJobId = await retryLatestFailedCatalogSyncJob(session.shop);
    if (catalogJobId) kickCatalogSyncQueue();

    const totalRequeued = productResult.requeued + (catalogJobId ? 1 : 0);

    return {
      success: true,
      jobId: catalogJobId,
      message: totalRequeued > 0
        ? `Requeued ${totalRequeued} FAILED sync jobs into the processing queue.`
        : "No FAILED sync jobs available to retry.",
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
      message: `Reconciliation completed: Pruned ${result.pruned}, recovered ${result.recovered}${
        result.catalogJobId ? `, Catalog job #${result.catalogJobId}` : ""
      }.`,
    };
  }

  // PRIMARY ACTION: Auto-detect Initial Sync vs Full Catalog Refresh
  if (intent === "sync_auto") {
    const jobId = await enqueueInitialCatalogSyncIfNeeded(session.shop);
    
    if (jobId) {
      kickCatalogSyncQueue();
      return {
        success: true,
        jobId,
        message: `Initial catalog sync job #${jobId} queued successfully.`,
      };
    }

    const refreshJobId = await enqueueCatalogRefresh(session.shop, "MANUAL_REFRESH");
    if (refreshJobId) {
      kickCatalogSyncQueue();
      return {
        success: true,
        jobId: refreshJobId,
        message: `Full catalog refresh job #${refreshJobId} triggered successfully.`,
      };
    }

    return {
      success: false,
      jobId: null,
      message: "Unable to create sync job or subscription is inactive.",
    };
  }

  return { success: false, jobId: null, message: "Invalid action intent." };
};

const catalogCss = `
  .cat-shell {
    width: 100%;
    padding: 0 24px 60px 24px;
    box-sizing: border-box;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    color: #1a1c23;
  }
  .cat-header {
    margin-bottom: 24px;
    border-bottom: 1px solid #e2e4ed;
    padding-bottom: 16px;
  }
  .cat-grid {
    display: grid;
    grid-template-columns: minmax(0, 1.2fr) minmax(320px, 1fr);
    gap: 20px;
    align-items: stretch;
    margin-bottom: 24px;
  }
  .cat-card {
    background: #ffffff;
    border: 1px solid #e2e4ed;
    border-radius: 18px;
    padding: 24px;
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.03);
    display: flex;
    flex-direction: column;
    justify-content: space-between;
  }
  .cat-card-title {
    margin: 0 0 16px 0;
    font-size: 17px;
    font-weight: 800;
    color: #1a1c23;
    display: flex;
    justify-content: space-between;
    align-items: center;
    border-bottom: 1px solid #f0f0f4;
    padding-bottom: 12px;
  }
  .cat-btn {
    padding: 10px 18px;
    border-radius: 10px;
    border: 1px solid #c9cccf;
    background: #ffffff;
    color: #1a1a1a;
    font-weight: 700;
    font-size: 13px;
    cursor: pointer;
    transition: all 0.15s ease;
  }
  .cat-btn:hover {
    background: #f6f6f7;
    border-color: #a8abaf;
  }
  .cat-btn-primary {
    background: #008060;
    color: #ffffff;
    border: none;
    box-shadow: 0 2px 6px rgba(0, 128, 96, 0.25);
  }
  .cat-btn-primary:hover {
    background: #006e52;
  }
  .cat-btn-warning {
    background: #fff6df;
    color: #8a5b00;
    border: 1px solid #f3d489;
  }
  .cat-btn-warning:hover {
    background: #fde8b3;
  }
  .cat-status-row {
    display: flex;
    justify-content: space-between;
    padding: 11px 0;
    border-bottom: 1px solid #f0f0f4;
    font-size: 13px;
  }
  .cat-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
  }
  .cat-table th {
    text-align: left;
    padding: 12px 12px;
    background: #fafafa;
    border-bottom: 1px solid #e2e4ed;
    color: #5c6270;
    font-weight: 700;
  }
  .cat-table td {
    padding: 12px 12px;
    border-bottom: 1px solid #f0f0f4;
  }
  @keyframes spin {
    0% { transform: rotate(0deg); }
    100% { transform: rotate(360deg); }
  }
  .spinner {
    display: inline-block;
    width: 12px;
    height: 12px;
    border: 2px solid rgba(138, 91, 0, 0.3);
    border-radius: 50%;
    border-top-color: #8a5b00;
    animation: spin 0.8s linear infinite;
    margin-right: 6px;
  }
`;

export default function CatalogSyncPage() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const navigate = useNavigate();
  const isBusy = fetcher.state !== "idle";

  const isProcessing =
    data.job?.status === "PROCESSING" ||
    data.job?.status === "PENDING" ||
    data.job?.status === "RUNNING";

  // AUTO-REFRESH PAGE EVERY 3 SECONDS WHEN SYNC IS PROCESSING
  useEffect(() => {
    if (!isProcessing) return;

    const timer = setInterval(() => {
      navigate(".", { replace: true });
    }, 3000);

    return () => clearInterval(timer);
  }, [isProcessing, navigate]);

  return (
    <div className="cat-shell">
      <style>{catalogCss}</style>

      {/* PAGE HEADER */}
      <div className="cat-header">
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800 }}>
          Catalog & AI Vector Index Management
        </h1>
        <p style={{ margin: "4px 0 0 0", fontSize: 13, color: "#5c6270" }}>
          Trigger product catalog synchronization, monitor background jobs, and review vector index registry logs.
        </p>
      </div>

      {/* BLOCK 1 & BLOCK 2: TOP GRID */}
      <div className="cat-grid">
        {/* BLOCK 1: AUTOMATED CATALOG SYNC */}
        <div className="cat-card">
          <div>
            <div className="cat-card-title">
              <span>📦 Catalog Data Synchronization</span>
              <span style={{ fontSize: 12, padding: "4px 10px", borderRadius: 20, background: "#f1f2f3", color: "#5c6270" }}>
                {data.shop}
              </span>
            </div>

            <p style={{ fontSize: 13, color: "#5c6270", lineHeight: 1.6, margin: "0 0 16px 0" }}>
              Click the button below to update product details and refresh AI vector indexes for your store catalog.
            </p>

            <div style={{ fontSize: 12, color: "#616161", background: "#f8f9fa", padding: 12, borderRadius: 10, lineHeight: 1.5, marginBottom: 20 }}>
              💡 <i>Note:</i> Initial catalog sync does not count against your 50 vector update quota. Subsequent product updates will be tracked automatically.
            </div>
          </div>

          <div>
            {/* PRIMARY SYNC BUTTON */}
            <fetcher.Form method="post">
              <input type="hidden" name="intent" value="sync_auto" />
              <button
                type="submit"
                disabled={isBusy || isProcessing}
                className="cat-btn cat-btn-primary"
                style={{ width: "100%", padding: "12px 20px", fontSize: 14 }}
              >
                {isBusy || isProcessing ? "Processing Sync..." : "🔄 Sync Catalog Now (Refresh Vectors)"}
              </button>
            </fetcher.Form>

            {/* ACTION FEEDBACK MESSAGE */}
            {fetcher.data?.message ? (
              <div
                style={{
                  marginTop: 12,
                  padding: 12,
                  borderRadius: 10,
                  background: fetcher.data.success ? "#e4f8f0" : "#ffebe9",
                  color: fetcher.data.success ? "#008060" : "#d32f2f",
                  fontSize: 13,
                  fontWeight: 600,
                }}
              >
                {fetcher.data.message}
              </div>
            ) : null}
          </div>
        </div>

        {/* BLOCK 2: BACKGROUND SYNC JOB & TROUBLESHOOTING */}
        <div className="cat-card">
          <div>
            <div className="cat-card-title">
              <span>⚡ Background Sync Progress</span>
              {data.job?.status ? (
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: 800,
                    padding: "3px 10px",
                    borderRadius: 12,
                    display: "inline-flex",
                    alignItems: "center",
                    background: data.job.status === "DONE" ? "#e4f8f0" : "#fff6df",
                    color: data.job.status === "DONE" ? "#008060" : "#8a5b00",
                  }}
                >
                  {isProcessing ? <span className="spinner" /> : null}
                  {data.job.status === "DONE"
                    ? "COMPLETED"
                    : isProcessing
                    ? "PROCESSING..."
                    : data.job.status}
                </span>
              ) : null}
            </div>

            {data.job ? (
              <div style={{ marginBottom: 12 }}>
                <div className="cat-status-row">
                  <span style={{ color: "#5c6270" }}>Job ID:</span>
                  <strong>#{data.job.id}</strong>
                </div>
                <div className="cat-status-row">
                  <span style={{ color: "#5c6270" }}>Trigger Reason:</span>
                  <span>{data.job.reason ?? "—"}</span>
                </div>
                <div className="cat-status-row">
                  <span style={{ color: "#5c6270" }}>Processed / Indexed:</span>
                  <strong>{data.job.productsProcessed} / {data.job.productsIndexed}</strong>
                </div>
                <div className="cat-status-row">
                  <span style={{ color: "#5c6270" }}>Skipped / Blocked:</span>
                  <span>{data.job.productsSkipped} / {data.job.productsBlocked}</span>
                </div>
                <div className="cat-status-row">
                  <span style={{ color: "#5c6270" }}>Failed:</span>
                  <strong style={{ color: data.job.productsFailed > 0 ? "#d32f2f" : "#1a1c23" }}>
                    {data.job.productsFailed}
                  </strong>
                </div>
                {data.job.lastError ? (
                  <div style={{ marginTop: 10, padding: 10, background: "#ffebe9", color: "#d32f2f", borderRadius: 8, fontSize: 12 }}>
                    <strong>Error details:</strong> {data.job.lastError}
                  </div>
                ) : null}
              </div>
            ) : (
              <div style={{ padding: "16px 0", textAlign: "center", color: "#8c9196", fontSize: 13 }}>
                No active or past catalog sync jobs recorded.
              </div>
            )}
          </div>

          {/* TROUBLESHOOTING & RESCUE TOOLS */}
          <div style={{ borderTop: "1px solid #f0f0f4", paddingTop: 12, marginTop: 10 }}>
            <div style={{ fontSize: 11, fontWeight: 800, color: "#5c6270", marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.05em" }}>
              🛠️ Troubleshooting & Maintenance
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <fetcher.Form method="post">
                <input type="hidden" name="intent" value="reconcile" />
                <button type="submit" disabled={isBusy} className="cat-btn" style={{ width: "100%", fontSize: 12 }}>
                  Reconcile Quota
                </button>
              </fetcher.Form>

              <fetcher.Form method="post">
                <input type="hidden" name="intent" value="retry_all_failed" />
                <button type="submit" disabled={isBusy} className="cat-btn cat-btn-warning" style={{ width: "100%", fontSize: 12 }}>
                  Retry Failed Jobs
                </button>
              </fetcher.Form>
            </div>
          </div>
        </div>
      </div>

      {/* BLOCK 3: INDEXED PRODUCT REGISTRY */}
      <div className="cat-card">
        <div className="cat-card-title">
          <span>🗂️ Indexed Product Registry (Last 30 Products)</span>
        </div>
        <div style={{ overflowX: "auto" }}>
          <table className="cat-table">
            <thead>
              <tr>
                <th>Product Title</th>
                <th>Handle / Path</th>
                <th>Store Status</th>
                <th>AI Vector Status</th>
              </tr>
            </thead>
            <tbody>
              {data.products.length > 0 ? (
                data.products.map((product) => (
                  <tr key={product.id}>
                    <td style={{ fontWeight: 700, color: "#1a1c23" }}>{product.title}</td>
                    <td style={{ color: "#5c6270" }}>{product.handle}</td>
                    <td>
                      <span
                        style={{
                          padding: "4px 10px",
                          borderRadius: 12,
                          fontSize: 11,
                          fontWeight: 700,
                          background: product.status === "ACTIVE" ? "#e4f8f0" : "#f1f2f3",
                          color: product.status === "ACTIVE" ? "#008060" : "#5c6270",
                        }}
                      >
                        {product.status === "ACTIVE" ? "ACTIVE" : product.status}
                      </span>
                    </td>
                    <td>
                      <span
                        style={{
                          padding: "4px 10px",
                          borderRadius: 12,
                          fontSize: 11,
                          fontWeight: 700,
                          background: product.hasVector ? "#e4f8f0" : "#fff6df",
                          color: product.hasVector ? "#008060" : "#8a5b00",
                        }}
                      >
                        {product.hasVector ? "✓ Vector Indexed" : "⏳ Pending Vector"}
                      </span>
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={4} style={{ textAlign: "center", padding: 24, color: "#8c9196" }}>
                    No product vectors found in the search index registry.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}