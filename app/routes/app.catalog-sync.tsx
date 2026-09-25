import { useEffect, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";

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
import prisma from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);

  const activeTab = url.searchParams.get("tab") || "indexed"; // 'indexed' | 'unindexed'
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
  const pageSize = 50; // THAY ĐỔI THÀNH 50 SẢN PHẨM / TRANG
  const skip = (page - 1) * pageSize;

  // 1. Đếm tổng quan kho hàng
  const [job, totalProducts, indexedProductsCount] = await Promise.all([
    getLatestCatalogSyncJob(session.shop),
    prisma.aiSearchIndexedProduct.count({ where: { shop: session.shop } }),
    prisma.aiSearchIndexedProduct.count({
      where: {
        shop: session.shop,
        hasVector: true,
        documentHash: { not: null },
      },
    }),
  ]);

  const unindexedProductsCount = Math.max(0, totalProducts - indexedProductsCount);

  // 2. Lọc đúng sản phẩm cho từng Tab
  const targetHasVector = activeTab === "indexed";
  const targetTotal = targetHasVector ? indexedProductsCount : unindexedProductsCount;

  const rawProducts = await prisma.aiSearchIndexedProduct.findMany({
    where: {
      shop: session.shop,
      ...(targetHasVector
        ? { hasVector: true, documentHash: { not: null } }
        : { OR: [{ hasVector: false }, { documentHash: null }] }),
    },
    orderBy: { updatedAt: "desc" },
    skip,
    take: pageSize,
    select: {
      id: true,
      productId: true,
      handle: true,
      title: true,
      status: true,
      documentHash: true,
      hasVector: true,
    },
  });

  const products = rawProducts.map((p) => ({
    id: p.id,
    productId: p.productId,
    handle: p.handle,
    title: p.title,
    status: p.status,
    hasVector: Boolean(p.hasVector && p.documentHash),
  }));

  const totalPages = Math.ceil(targetTotal / pageSize) || 1;

  return {
    shop: session.shop,
    job,
    stats: {
      total: totalProducts,
      indexed: indexedProductsCount,
      unindexed: unindexedProductsCount,
    },
    tableData: {
      activeTab,
      page,
      pageSize,
      totalPages,
      totalItems: targetTotal,
      products,
    },
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = String(form.get("intent") || "sync_auto");

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
    padding: 8px 14px;
    border-radius: 8px;
    border: 1px solid #c9cccf;
    background: #ffffff;
    color: #1a1a1a;
    font-weight: 700;
    font-size: 13px;
    cursor: pointer;
    transition: all 0.15s ease;
  }
  .cat-btn:hover:not(:disabled) {
    background: #f6f6f7;
    border-color: #a8abaf;
  }
  .cat-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .cat-btn-primary {
    background: #008060;
    color: #ffffff;
    border: none;
    box-shadow: 0 2px 6px rgba(0, 128, 96, 0.25);
  }
  .cat-btn-primary:hover:not(:disabled) {
    background: #006e52;
  }
  .cat-btn-warning {
    background: #fff6df;
    color: #8a5b00;
    border: 1px solid #f3d489;
  }
  .cat-btn-warning:hover:not(:disabled) {
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
    table-layout: fixed;
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
    word-break: break-word;
  }
  
  /* TABS STYLES - GREEN FOR INDEXED, RED FOR UNINDEXED */
  .cat-tabs {
    display: flex;
    gap: 12px;
    border-bottom: 1px solid #e2e4ed;
    margin-bottom: 16px;
  }
  .cat-tab-item {
    padding: 10px 16px;
    font-size: 14px;
    font-weight: 700;
    color: #5c6270;
    cursor: pointer;
    border-bottom: 2px solid transparent;
    transition: all 0.2s ease;
  }
  .cat-tab-item.tab-indexed.active {
    color: #008060;
    border-bottom-color: #008060;
  }
  .cat-tab-item.tab-unindexed.active {
    color: #d32f2f;
    border-bottom-color: #d32f2f;
  }

  /* ADVANCED PAGINATION STYLES */
  .cat-pagination {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding-top: 16px;
    border-top: 1px solid #f0f0f4;
    margin-top: 16px;
    flex-wrap: wrap;
    gap: 12px;
  }
  .cat-page-btn {
    min-width: 34px;
    height: 34px;
    padding: 0 8px;
    border-radius: 8px;
    border: 1px solid #c9cccf;
    background: #ffffff;
    color: #1a1a1a;
    font-weight: 700;
    font-size: 13px;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    transition: all 0.15s ease;
  }
  .cat-page-btn:hover:not(:disabled):not(.active) {
    background: #f6f6f7;
    border-color: #a8abaf;
  }
  .cat-page-btn.active {
    background: #008060;
    color: #ffffff;
    border-color: #008060;
    cursor: default;
  }
  .cat-page-btn:disabled {
    opacity: 0.35;
    cursor: not-allowed;
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
  const initialData = useLoaderData<typeof loader>();
  const actionFetcher = useFetcher<typeof action>();
  const tableFetcher = useFetcher<typeof loader>();
  const statusFetcher = useFetcher<{
    job: typeof initialData.job;
  }>();

  const [activeTab, setActiveTab] = useState<"indexed" | "unindexed">("indexed");
  const [currentPage, setCurrentPage] = useState(1);

  const isActionBusy = actionFetcher.state !== "idle";
  const isTableLoading = tableFetcher.state !== "idle";

  const liveJob = statusFetcher.data?.job ?? initialData.job;

    const isProcessing =
      liveJob?.status === "PROCESSING" ||
      liveJob?.status === "PENDING" ||
      liveJob?.status === "RUNNING";

  const currentTableData = tableFetcher.data?.tableData || initialData.tableData;
  const currentStats = tableFetcher.data?.stats || initialData.stats;

  const loadTableData = (tab: "indexed" | "unindexed", page: number) => {
    setActiveTab(tab);
    setCurrentPage(page);
    tableFetcher.load(`.?tab=${tab}&page=${page}`);
  };

  useEffect(() => {
  if (!isProcessing) return;

  const loadStatus = () => {
    statusFetcher.load("/app/catalog-status");
  };

  loadStatus();

  const timer = window.setInterval(loadStatus, 3000);

  return () => window.clearInterval(timer);
}, [isProcessing]);

  // HÀM TÍNH TOÁN CÁC NÚT SỐ TRANG HIỂN THỊ (VD: 1, 2, 3, 4, 5...)
  const getPageNumbers = (current: number, total: number) => {
    const pages: number[] = [];
    const maxVisible = 5;
    let start = Math.max(1, current - Math.floor(maxVisible / 2));
    let end = Math.min(total, start + maxVisible - 1);

    if (end - start + 1 < maxVisible) {
      start = Math.max(1, end - maxVisible + 1);
    }

    for (let i = start; i <= end; i++) {
      pages.push(i);
    }
    return pages;
  };

  const pageNumbers = getPageNumbers(currentTableData.page, currentTableData.totalPages);

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
                {initialData.shop}
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
            <actionFetcher.Form method="post">
              <input type="hidden" name="intent" value="sync_auto" />
              <button
                type="submit"
                disabled={isActionBusy || isProcessing}
                className="cat-btn cat-btn-primary"
                style={{ width: "100%", padding: "12px 20px", fontSize: 14 }}
              >
                {isActionBusy || isProcessing ? "Processing Sync..." : "🔄 Sync Catalog Now (Refresh Vectors)"}
              </button>
            </actionFetcher.Form>

            {actionFetcher.data?.message ? (
              <div
                style={{
                  marginTop: 12,
                  padding: 12,
                  borderRadius: 10,
                  background: actionFetcher.data.success ? "#e4f8f0" : "#ffebe9",
                  color: actionFetcher.data.success ? "#008060" : "#d32f2f",
                  fontSize: 13,
                  fontWeight: 600,
                }}
              >
                {actionFetcher.data.message}
              </div>
            ) : null}
          </div>
        </div>

        {/* BLOCK 2: CATALOG SUMMARY */}
        <div className="cat-card">
          <div>
            <div className="cat-card-title">
              <span>📊 Catalog Overview</span>
              {liveJob?.status ? (
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: 800,
                    padding: "3px 10px",
                    borderRadius: 12,
                    display: "inline-flex",
                    alignItems: "center",
                    background: initialData.job.status === "DONE" ? "#e4f8f0" : "#fff6df",
                    color: initialData.job.status === "DONE" ? "#008060" : "#8a5b00",
                  }}
                >
                  {isProcessing ? <span className="spinner" /> : null}
                 {liveJob.status === "DONE"
                    ? "SYNC COMPLETED"
                    : isProcessing
                    ? "SYNCING..."
                    : initialData.job.status}
                </span>
              ) : null}
            </div>

            <div style={{ marginBottom: 12 }}>
              <div className="cat-status-row">
                <span style={{ color: "#5c6270" }}>Total Products:</span>
                <strong>{currentStats.total}</strong>
              </div>

              <div className="cat-status-row">
                <span style={{ color: "#5c6270" }}>Indexed Products:</span>
                <strong style={{ color: "#008060" }}>{currentStats.indexed}</strong>
              </div>

              <div className="cat-status-row">
                <span style={{ color: "#5c6270" }}>Unindexed Products:</span>
                <strong style={{ color: currentStats.unindexed > 0 ? "#d32f2f" : "#1a1c23" }}>
                  {currentStats.unindexed}
                </strong>
              </div>

              {liveJob?.lastError ? (
                <div style={{ marginTop: 10, padding: 10, background: "#ffebe9", color: "#d32f2f", borderRadius: 8, fontSize: 12 }}>
                  <strong>Error details:</strong> {initialData.job.lastError}
                </div>
              ) : null}
            </div>
          </div>

          {/* TROUBLESHOOTING & RESCUE TOOLS */}
          <div style={{ borderTop: "1px solid #f0f0f4", paddingTop: 12, marginTop: 10 }}>
            <div style={{ fontSize: 11, fontWeight: 800, color: "#5c6270", marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.05em" }}>
              🛠️ Troubleshooting & Maintenance
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <actionFetcher.Form method="post">
                <input type="hidden" name="intent" value="reconcile" />
                <button type="submit" disabled={isActionBusy} className="cat-btn" style={{ width: "100%", fontSize: 12 }}>
                  Reconcile Quota
                </button>
              </actionFetcher.Form>

              <actionFetcher.Form method="post">
                <input type="hidden" name="intent" value="retry_all_failed" />
                <button type="submit" disabled={isActionBusy} className="cat-btn cat-btn-warning" style={{ width: "100%", fontSize: 12 }}>
                  Retry Failed Jobs
                </button>
              </actionFetcher.Form>
            </div>
          </div>
        </div>
      </div>

      {/* BLOCK 3: PRODUCT REGISTRY WITH FULL PAGINATION CONTROLS */}
      <div className="cat-card">
        {/* ENGLISH TABS HEADER */}
        <div className="cat-tabs">
          <div
            className={`cat-tab-item tab-indexed ${activeTab === "indexed" ? "active" : ""}`}
            onClick={() => loadTableData("indexed", 1)}
          >
            ✅ Indexed Products ({currentStats.indexed})
          </div>
          <div
            className={`cat-tab-item tab-unindexed ${activeTab === "unindexed" ? "active" : ""}`}
            onClick={() => loadTableData("unindexed", 1)}
          >
            ⏳ Unindexed Products ({currentStats.unindexed})
          </div>
        </div>

        {/* TABLE CONTENT */}
        <div style={{ overflowX: "auto", opacity: isTableLoading ? 0.6 : 1, transition: "opacity 0.2s" }}>
          <table className="cat-table">
            <thead>
              <tr>
                <th style={{ width: "35%" }}>Product Title</th>
                <th style={{ width: "25%" }}>Handle / Path</th>
                <th style={{ width: "20%" }}>Store Status</th>
                <th style={{ width: "20%" }}>Status</th>
              </tr>
            </thead>
            <tbody>
              {currentTableData.products.length > 0 ? (
                currentTableData.products.map((product) => {
                  const isIndexed = activeTab === "indexed" ? true : false;

                  return (
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
                        {isIndexed ? (
                          <span
                            style={{
                              padding: "4px 10px",
                              borderRadius: 12,
                              fontSize: 11,
                              fontWeight: 700,
                              background: "#e4f8f0",
                              color: "#008060",
                              border: "1px solid #b7ebc6",
                            }}
                          >
                            ✓ Indexed
                          </span>
                        ) : (
                          <span
                            style={{
                              padding: "4px 10px",
                              borderRadius: 12,
                              fontSize: 11,
                              fontWeight: 700,
                              background: "#ffebe9",
                              color: "#d32f2f",
                              border: "1px solid #f3b8b8",
                            }}
                          >
                            ❌ Unindexed
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td colSpan={4} style={{ textAlign: "center", padding: 24, color: "#8c9196" }}>
                    {isTableLoading
                      ? "Loading product list..."
                      : activeTab === "indexed"
                      ? "No indexed products found."
                      : "No unindexed products found."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* ADVANCED MULTI-PAGE PAGINATION CONTROLS */}
        <div className="cat-pagination">
          <div style={{ fontSize: 13, color: "#5c6270" }}>
            Showing <strong>{currentTableData.products.length}</strong> of <strong>{currentTableData.totalItems}</strong> products 
            (Page {currentTableData.page} of {currentTableData.totalPages})
          </div>

          <div style={{ display: "flex", gap: 5, alignItems: "center" }}>
            {/* 1. NÚT VỀ TRANG ĐẦU »» */}
            <button
              className="cat-page-btn"
              title="First Page"
              disabled={currentPage <= 1 || isTableLoading}
              onClick={() => loadTableData(activeTab, 1)}
            >
              «
            </button>

            {/* 2. NÚT TRANG TRƯỚC */}
            <button
              className="cat-page-btn"
              style={{ padding: "0 10px" }}
              disabled={currentPage <= 1 || isTableLoading}
              onClick={() => loadTableData(activeTab, currentPage - 1)}
            >
              ◄ Previous
            </button>

            {/* 3. DÃY NÚT SỐ TRANG TRỰC TIẾP (VD: 1, 2, 3, 4, 5) */}
            {pageNumbers.map((p) => (
              <button
                key={p}
                className={`cat-page-btn ${p === currentPage ? "active" : ""}`}
                disabled={isTableLoading}
                onClick={() => loadTableData(activeTab, p)}
              >
                {p}
              </button>
            ))}

            {/* 4. NÚT TRANG SAU */}
            <button
              className="cat-page-btn"
              style={{ padding: "0 10px" }}
              disabled={currentPage >= currentTableData.totalPages || isTableLoading}
              onClick={() => loadTableData(activeTab, currentPage + 1)}
            >
              Next ►
            </button>

            {/* 5. NÚT ĐẾN TRANG CUỐI »» */}
            <button
              className="cat-page-btn"
              title="Last Page"
              disabled={currentPage >= currentTableData.totalPages || isTableLoading}
              onClick={() => loadTableData(activeTab, currentTableData.totalPages)}
            >
              »
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}