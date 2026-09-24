import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";

import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { PLAN_DEFINITIONS } from "../services/commerce/plans.server";

// ============================================================================
// 1. BACKEND LOADER: TRUY VẤN CSDL TRỰC TIẾP TỪ PRISMA SCHEMA
// ============================================================================
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const now = new Date();

  // A. Lấy thông tin Shop & Subscription từ CSDL
  const shopRecord = await prisma.aiSearchShop.findUnique({
    where: { shop },
    include: {
      subscription: true,
      settings: true,
    },
  });

  // B. Lấy Kỳ Usage hiện tại (AiSearchUsagePeriod)
  let currentPeriod = await prisma.aiSearchUsagePeriod.findFirst({
    where: {
      shop,
      periodStart: { lte: now },
      periodEnd: { gte: now },
    },
    orderBy: { createdAt: "desc" },
  });

  // Fallback: Nếu chưa tạo Period cho tháng này thì lấy kỳ gần nhất
  if (!currentPeriod) {
    currentPeriod = await prisma.aiSearchUsagePeriod.findFirst({
      where: { shop },
      orderBy: { createdAt: "desc" },
    });
  }

  // C. Product capacity is based on searchable products. Cached vectors are
  // retained independently so plan downgrades do not force re-embedding.
  const [activeProductsCount, cachedVectorCount, cachedProductLimitBlockedCount] =
    await Promise.all([
      prisma.aiSearchIndexedProduct.count({ where: { shop, searchable: true } }),
      prisma.aiSearchIndexedProduct.count({ where: { shop, hasVector: true } }),
      prisma.aiSearchIndexedProduct.count({
        where: { shop, status: "PRODUCT_LIMIT_BLOCKED", hasVector: true },
      }),
    ]);

  // D. Lấy 50 Sự kiện Usage gần nhất (AiSearchUsageEvent)
  const recentEvents = await prisma.aiSearchUsageEvent.findMany({
    where: { shop },
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  // E. Xác định Giới hạn Hạn ngạch (Limits) dựa trên Gói Subscription (BASIC / PRO)
  const currentPlanKey = (shopRecord?.subscription?.plan || "BASIC").toUpperCase();
  const planDef = PLAN_DEFINITIONS[currentPlanKey as keyof typeof PLAN_DEFINITIONS] || PLAN_DEFINITIONS.BASIC;

  const limits = {
    productLimit: shopRecord?.settings?.productLimitOverride ?? planDef.limits.productLimit,
    searchLimit: shopRecord?.settings?.searchLimitOverride ?? planDef.limits.searchLimit,
    vectorUpdateLimit: shopRecord?.settings?.vectorUpdateLimitOverride ?? planDef.limits.vectorUpdateLimit,
  };

  // F. Đếm số sản phẩm bị vượt trần giới hạn gói cước
  const totalCatalogProducts = await prisma.aiSearchIndexedProduct.count({ where: { shop } });
  const productLimitBlocked = limits.productLimit !== null 
    ? Math.max(0, totalCatalogProducts - limits.productLimit)
    : 0;

  return {
    shop,
    subscription: {
      plan: currentPlanKey,
      status: shopRecord?.subscription?.status || "ACTIVE",
      source: shopRecord?.subscription?.source || "LOCAL",
    },
    period: currentPeriod
      ? {
          periodStart: currentPeriod.periodStart.toISOString(),
          periodEnd: currentPeriod.periodEnd.toISOString(),
          searchCount: currentPeriod.searchCount,
          vectorUpdateCount: currentPeriod.vectorUpdateCount,
          fallbackCount: currentPeriod.fallbackCount,
          blockedSearchCount: currentPeriod.blockedSearchCount,
          blockedVectorCount: currentPeriod.blockedVectorCount,
        }
      : {
          periodStart: new Date(now.getFullYear(), now.getMonth(), 1).toISOString(),
          periodEnd: new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString(),
          searchCount: 0,
          vectorUpdateCount: 0,
          fallbackCount: 0,
          blockedSearchCount: 0,
          blockedVectorCount: 0,
        },
    activeProductsCount,
    cachedVectorCount,
    cachedProductLimitBlockedCount,
    productLimitBlocked,
    limits,
    events: recentEvents.map((event) => ({
      id: event.id,
      type: event.type,
      success: event.success,
      quantity: event.quantity,
      productId: event.productId,
      createdAt: event.createdAt.toISOString(),
    })),
  };
};

// ============================================================================
// 2. HELPER COMPONENTS: THANH TIẾN ĐỘ & FORMAT TÊN SỰ KIỆN
// ============================================================================
function renderProgressBar(current: number, max: number | null, color = "#008060") {
  if (max === null) {
    return (
      <div style={{ marginTop: 8 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: "#1a1a1a" }}>
          {current.toLocaleString("en-US")} / <span style={{ color: "#008060" }}>Unlimited</span>
        </div>
        <div
          style={{
            height: 6,
            background: "#e4f8f0",
            borderRadius: 3,
            marginTop: 6,
            width: "100%",
          }}
        />
      </div>
    );
  }

  const percentage = Math.min(100, Math.round((current / max) * 100));
  const isHigh = percentage >= 85;
  const barColor = isHigh ? "#d32f2f" : color;

  return (
    <div style={{ marginTop: 8 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontSize: 13,
          fontWeight: 600,
        }}
      >
        <span>
          {current.toLocaleString("en-US")} / {max.toLocaleString("en-US")}
        </span>
        <span style={{ color: barColor }}>{percentage}% used</span>
      </div>
      <div
        style={{
          height: 6,
          background: "#f1f2f3",
          borderRadius: 3,
          marginTop: 6,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            height: "100%",
            width: `${percentage}%`,
            background: barColor,
            borderRadius: 3,
            transition: "width 0.3s ease",
          }}
        />
      </div>
    </div>
  );
}

function formatEventType(type: string) {
  switch (type) {
    case "SEARCH":
      return "🔍 AI Storefront Search";
    case "PRODUCT_SYNC":
      return "🔄 Catalog Product Sync";
    case "VECTOR_UPDATE":
      return "⚡ Vector Data Indexing";
    case "FALLBACK_SEARCH":
      return "↩️ Fallback Native Search";
    default:
      return type.replace(/_/g, " ");
  }
}

// ============================================================================
// 3. FRONTEND COMPONENT: GIAO DIỆN HẠN NGẠCH VÀ NHẬT KÝ CHUYÊN NGHIỆP
// ============================================================================
export default function UsagePage() {
  const data = useLoaderData<typeof loader>();
  const period = data.period;
  const limits = data.limits;

  const formattedPeriodStart = new Date(period.periodStart).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const formattedPeriodEnd = new Date(period.periodEnd).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  return (
    <div
      style={{
        width: "100%",
        padding: "0 24px 60px 24px",
        boxSizing: "border-box",
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
      }}
    >
      {/* HEADER */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-end",
          marginBottom: 24,
          borderBottom: "1px solid #e1e3e5",
          paddingBottom: 16,
        }}
      >
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: "#1a1a1a" }}>
            Usage & Capacity Consumption
          </h1>
          <p style={{ margin: "4px 0 0 0", fontSize: 13, color: "#616161" }}>
            Monitor your monthly plan allowances, catalog capacity, and real-time execution logs.
          </p>
        </div>
        <div
          style={{
            background: "#f1f2f3",
            padding: "6px 12px",
            borderRadius: 8,
            fontSize: 12,
            fontWeight: 600,
            color: "#4a4a4a",
          }}
        >
          Billing Cycle: {formattedPeriodStart} → {formattedPeriodEnd}
        </div>
      </div>

      {/* SECTION 1: RESOURCE QUOTA PROGRESS BARS */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
          gap: 16,
          marginBottom: 28,
        }}
      >
        {/* AI SEARCHES */}
        <div
          style={{
            background: "#fff",
            padding: 20,
            borderRadius: 12,
            border: "1px solid #e1e3e5",
            boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
          }}
        >
          <div style={{ fontSize: 13, fontWeight: 600, color: "#616161" }}>
            AI Storefront Searches
          </div>
          {renderProgressBar(period.searchCount, limits.searchLimit, "#008060")}
          <div style={{ fontSize: 11, color: "#8c9196", marginTop: 8 }}>
            Auto-fallbacks to Shopify Search when limit is reached.
          </div>
        </div>

        {/* ACTIVE AI PRODUCTS */}
        <div
          style={{
            background: "#fff",
            padding: 20,
            borderRadius: 12,
            border: "1px solid #e1e3e5",
            boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
          }}
        >
          <div style={{ fontSize: 13, fontWeight: 600, color: "#616161" }}>
            Active AI Products
          </div>
          {renderProgressBar(data.activeProductsCount, limits.productLimit, "#5c6ac4")}
          <div style={{ fontSize: 11, color: "#8c9196", marginTop: 8 }}>
            {data.cachedVectorCount.toLocaleString("en-US")} vectors cached · {data.cachedProductLimitBlockedCount.toLocaleString("en-US")} cached & blocked from AI Search.
          </div>
        </div>

        {/* VECTOR UPDATES */}
        <div
          style={{
            background: "#fff",
            padding: 20,
            borderRadius: 12,
            border: "1px solid #e1e3e5",
            boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
          }}
        >
          <div style={{ fontSize: 13, fontWeight: 600, color: "#616161" }}>
            Vector Data Updates
          </div>
          {renderProgressBar(period.vectorUpdateCount, limits.vectorUpdateLimit, "#47c1bf")}
          <div style={{ fontSize: 11, color: "#8c9196", marginTop: 8 }}>
            Re-indexing executions triggered by product changes.
          </div>
        </div>
      </div>

      {/* SECTION 2: HEALTH METRICS & EXECUTION SUMMARY */}
      <div
        style={{
          background: "#fff",
          borderRadius: 12,
          padding: 20,
          border: "1px solid #e1e3e5",
          marginBottom: 28,
          boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
        }}
      >
        <h3 style={{ margin: "0 0 16px 0", fontSize: 15, fontWeight: 700, color: "#1a1a1a" }}>
          ⚡ Search Execution & Reliability Summary
        </h3>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
            gap: 16,
            fontSize: 13,
          }}
        >
          <div
            style={{
              padding: 12,
              borderRadius: 8,
              background: "#fafafa",
              border: "1px solid #f1f2f3",
            }}
          >
            <span style={{ color: "#616161", display: "block", fontSize: 12 }}>
              Total Storefront Searches
            </span>
            <strong style={{ fontSize: 18, color: "#1a1a1a" }}>
              {(period.searchCount + period.fallbackCount).toLocaleString("en-US")}
            </strong>
          </div>

          <div
            style={{
              padding: 12,
              borderRadius: 8,
              background: "#fafafa",
              border: "1px solid #f1f2f3",
            }}
          >
            <span style={{ color: "#616161", display: "block", fontSize: 12 }}>
              Native Fallback Searches
            </span>
            <strong style={{ fontSize: 18, color: period.fallbackCount > 0 ? "#e67c00" : "#008060" }}>
              {period.fallbackCount.toLocaleString("en-US")}
            </strong>
          </div>

          <div
            style={{
              padding: 12,
              borderRadius: 8,
              background: "#fafafa",
              border: "1px solid #f1f2f3",
            }}
          >
            <span style={{ color: "#616161", display: "block", fontSize: 12 }}>
              Blocked Searches
            </span>
            <strong style={{ fontSize: 18, color: period.blockedSearchCount > 0 ? "#d32f2f" : "#008060" }}>
              {period.blockedSearchCount.toLocaleString("en-US")}
            </strong>
          </div>

          <div
            style={{
              padding: 12,
              borderRadius: 8,
              background: "#fafafa",
              border: "1px solid #f1f2f3",
            }}
          >
            <span style={{ color: "#616161", display: "block", fontSize: 12 }}>
              Products Blocked by Product Limit
            </span>
            <strong style={{ fontSize: 18, color: data.productLimitBlocked > 0 ? "#d32f2f" : "#008060" }}>
              {data.productLimitBlocked.toLocaleString("en-US")}
            </strong>
          </div>
        </div>
      </div>

      {/* SECTION 3: RECENT AUDIT LOGS TABLE */}
      <div
        style={{
          background: "#fff",
          borderRadius: 12,
          border: "1px solid #e1e3e5",
          overflow: "hidden",
          boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
        }}
      >
        <div
          style={{
            padding: "16px 20px",
            borderBottom: "1px solid #e1e3e5",
            background: "#f6f6f7",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: "#1a1a1a" }}>
            Recent Usage Activity Logs (Last 50 Events)
          </h3>
          <span style={{ fontSize: 12, color: "#616161" }}>Real-time audit trail</span>
        </div>

        <div style={{ overflowX: "auto" }}>
          <table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              fontSize: 13,
              textAlign: "left",
            }}
          >
            <thead>
              <tr
                style={{
                  borderBottom: "1px solid #e1e3e5",
                  color: "#616161",
                  background: "#fafafa",
                }}
              >
                <th style={{ padding: "12px 16px", width: "18%" }}>Timestamp</th>
                <th style={{ padding: "12px 16px", width: "25%" }}>Event Type</th>
                <th style={{ padding: "12px 16px", width: "12%", textAlign: "center" }}>Status</th>
                <th style={{ padding: "12px 16px", width: "10%", textAlign: "center" }}>Qty</th>
                <th style={{ padding: "12px 16px", width: "35%" }}>Product Reference</th>
              </tr>
            </thead>
            <tbody>
              {data.events.map((event) => (
                <tr key={event.id} style={{ borderBottom: "1px solid #f1f2f3" }}>
                  <td style={{ padding: "14px 16px", color: "#616161", whiteSpace: "nowrap" }}>
                    {new Date(event.createdAt).toLocaleString("en-US", {
                      month: "short",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                      second: "2-digit",
                    })}
                  </td>
                  <td style={{ padding: "14px 16px", fontWeight: 600, color: "#1a1a1a" }}>
                    {formatEventType(event.type)}
                  </td>
                  <td style={{ padding: "14px 16px", textAlign: "center" }}>
                    <span
                      style={{
                        padding: "3px 8px",
                        borderRadius: 4,
                        fontSize: 11,
                        fontWeight: 700,
                        background: event.success ? "#e4f8f0" : "#ffebe9",
                        color: event.success ? "#008060" : "#d32f2f",
                      }}
                    >
                      {event.success ? "SUCCESS" : "FAILED"}
                    </span>
                  </td>
                  <td style={{ padding: "14px 16px", textAlign: "center", fontWeight: 600 }}>
                    {event.quantity}
                  </td>
                  <td style={{ padding: "14px 16px", color: "#616161", wordBreak: "break-all" }}>
                    {event.productId ? (
                      <span style={{ fontFamily: "monospace", fontSize: 12 }}>
                        {event.productId.replace("gid://shopify/Product/", "Product #")}
                      </span>
                    ) : (
                      <span style={{ color: "#8c9196" }}>— System Execution —</span>
                    )}
                  </td>
                </tr>
              ))}

              {data.events.length === 0 && (
                <tr>
                  <td
                    colSpan={5}
                    style={{
                      padding: "32px 16px",
                      textAlign: "center",
                      color: "#616161",
                      fontSize: 13,
                    }}
                  >
                    No recent usage events recorded in this billing cycle.
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