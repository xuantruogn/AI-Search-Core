import { useState, useRef, useEffect } from "react";
import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData, useSubmit, useNavigation } from "react-router";

import prisma from "../db.server";
import { authenticate } from "../shopify.server";

export type FilterMode = "all" | "total" | "good" | "abnormal";

export interface ClickedProductDetail {
  productId: string;
  title: string;
  productUrl: string;
  clickCount: number;
}

function formatChartNumber(num: number): string {
  if (num >= 1_000_000) return (num / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (num >= 1_000) return (num / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
  return num.toString();
}

function toLocalDateString(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// 1. TRUY VẤN DỮ LIỆU CSDL & TÍNH TOÁN LOGIC ANALYTICS
async function getShopAnalyticsData(shop: string, requestedDays: number = 30) {
  const earliestLog = await prisma.aiSearchQueryLog.findFirst({
    where: { shop },
    orderBy: { createdAt: "asc" },
    select: { createdAt: true },
  });

  const now = new Date();
  
  let startDate = new Date();
  startDate.setDate(now.getDate() - requestedDays);
  startDate.setHours(0, 0, 0, 0);

  if (earliestLog) {
    const dayBeforeEarliest = new Date(earliestLog.createdAt);
    dayBeforeEarliest.setDate(dayBeforeEarliest.getDate() - 1);
    dayBeforeEarliest.setHours(0, 0, 0, 0);

    if (dayBeforeEarliest > startDate) {
      startDate = dayBeforeEarliest;
    }
  }

  const queryLogs = await prisma.aiSearchQueryLog.findMany({
    where: {
      shop,
      createdAt: { gte: startDate },
    },
    include: {
      clicks: true,
    },
    orderBy: { createdAt: "asc" },
  });

  const indexedProducts = await prisma.aiSearchIndexedProduct.findMany({
    where: { shop },
    select: { productId: true, title: true, handle: true },
  });

  const productMap = new Map<string, { title: string; handle: string }>();
  indexedProducts.forEach((p) => {
    productMap.set(p.productId, { title: p.title, handle: p.handle });
  });

  const totalSearches = queryLogs.length;
  const searchesWithClick = queryLogs.filter((log) => log.clicks.length > 0).length;
  const overallCTR = totalSearches > 0 
    ? ((searchesWithClick / totalSearches) * 100).toFixed(1) + "%" 
    : "0.0%";

  const clusterMap = new Map<string, {
    normalizedQuery: string;
    variants: Set<string>;
    searches: number;
    clicks: number;
    resultCount: number;
    productsClicked: Map<string, number>;
    logs: typeof queryLogs;
  }>();

  queryLogs.forEach((log) => {
    const key = log.normalizedQuery || log.query.toLowerCase().trim();
    const existing = clusterMap.get(key) || {
      normalizedQuery: key,
      variants: new Set<string>(),
      searches: 0,
      clicks: 0,
      resultCount: log.resultCount,
      productsClicked: new Map<string, number>(),
      logs: [],
    };

    existing.variants.add(log.query);
    existing.searches += 1;
    existing.clicks += log.clicks.length;
    existing.logs.push(log);

    log.clicks.forEach((c) => {
      const pCount = existing.productsClicked.get(c.productId) || 0;
      existing.productsClicked.set(c.productId, pCount + 1);
    });

    clusterMap.set(key, existing);
  });

  let abnormalSearchesCount = 0;
  const abnormalLogIds = new Set<string>();

  const tableRows = Array.from(clusterMap.values()).map((cluster) => {
    const ctrValue = cluster.searches > 0 ? (cluster.clicks / cluster.searches) * 100 : 0;
    
    let isAbnormal = false;
    let statusText = "Good";
    let statusBg = "#e4f8f0";
    let statusColor = "#008060";
    let abnormalReason = "—";

    if (cluster.resultCount === 0) {
      isAbnormal = true;
      statusText = "Abnormal";
      statusBg = "#ffebe9";
      statusColor = "#d32f2f";
      abnormalReason = "No products found";
    } else if (cluster.searches >= 20 && cluster.clicks === 0) {
      isAbnormal = true;
      statusText = "Abnormal";
      statusBg = "#ffebe9";
      statusColor = "#d32f2f";
      abnormalReason = "High search volume with 0 clicks (>=20 searches)";
    } else if (cluster.clicks > 0 && ctrValue < 3) {
      isAbnormal = true;
      statusText = "Abnormal";
      statusBg = "#ffebe9";
      statusColor = "#d32f2f";
      abnormalReason = "Low click-through rate (<3%)";
    } else {
      isAbnormal = false;
      statusText = "Good";
      statusBg = "#e4f8f0";
      statusColor = "#008060";
      abnormalReason = cluster.clicks === 0 ? "Insufficient data (<20 searches)" : "—";
    }

    if (isAbnormal) {
      abnormalSearchesCount += cluster.searches;
      cluster.logs.forEach((l) => abnormalLogIds.add(l.id));
    }

    const productListDetails: ClickedProductDetail[] = Array.from(cluster.productsClicked.entries())
      .map(([pId, clickCount]) => {
        const pInfo = productMap.get(pId);
        const handle = pInfo?.handle || "";
        const numericId = pId.replace("gid://shopify/Product/", "");
        
        const productUrl = handle 
          ? `https://${shop}/products/${handle}` 
          : `https://${shop}/admin/products/${numericId}`;

        return {
          productId: pId,
          title: pInfo?.title || `Product ID: ${numericId}`,
          productUrl,
          clickCount,
        };
      })
      .sort((a, b) => b.clickCount - a.clickCount);

    return {
      cluster: cluster.normalizedQuery,
      variants: Array.from(cluster.variants).join(", "),
      searches: cluster.searches,
      clicks: cluster.clicks,
      ctr: ctrValue.toFixed(1) + "%",
      isAbnormal,
      statusText,
      statusBg,
      statusColor,
      abnormalReason,
      products: productListDetails,
    };
  });

  const abnormalRate = totalSearches > 0 
    ? ((abnormalSearchesCount / totalSearches) * 100).toFixed(1) + "%" 
    : "0.0%";

  const dailyMap = new Map<string, { totalSearch: number; clickSearch: number; abnormalSearch: number }>();

  const currentRunner = new Date(startDate);
  const todayStr = toLocalDateString(now);

  while (true) {
    const dateStr = toLocalDateString(currentRunner);
    dailyMap.set(dateStr, { totalSearch: 0, clickSearch: 0, abnormalSearch: 0 });
    if (dateStr === todayStr) break;
    currentRunner.setDate(currentRunner.getDate() + 1);
  }

  queryLogs.forEach((log) => {
    const logDateStr = toLocalDateString(new Date(log.createdAt));
    const dayStat = dailyMap.get(logDateStr);
    
    if (dayStat) {
      dayStat.totalSearch += 1;
      if (log.clicks.length > 0) dayStat.clickSearch += 1;
      if (abnormalLogIds.has(log.id)) {
        dayStat.abnormalSearch += 1;
      }
      dailyMap.set(logDateStr, dayStat);
    }
  });

  const chartData = Array.from(dailyMap.entries()).map(([dateStr, stat], index) => ({
    day: index + 1,
    date: dateStr,
    totalSearch: stat.totalSearch,
    clickSearch: stat.clickSearch,
    abnormalSearch: stat.abnormalSearch,
  }));

  return {
    days: requestedDays,
    kpis: { totalSearches, overallCTR, abnormalSearches: abnormalSearchesCount, abnormalRate },
    chartData,
    tableRows,
  };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  try {
    const { session } = await authenticate.admin(request);
    const url = new URL(request.url);
    const requestedDays = Number.parseInt(url.searchParams.get("days") || "30", 10);
    const days = Number.isSafeInteger(requestedDays)
      ? Math.max(1, Math.min(requestedDays, 365))
      : 30;

    return await getShopAnalyticsData(session.shop, days);
  } catch (error) {
    return {
      days: 30,
      kpis: { totalSearches: 0, overallCTR: "0.0%", abnormalSearches: 0, abnormalRate: "0.0%" },
      chartData: [],
      tableRows: [],
    };
  }
};

export default function SearchAnalyticsPage() {
  const loaderData = useLoaderData<typeof loader>();
  const submit = useSubmit();
  const navigation = useNavigation();

  const isLoading = navigation.state === "loading";

  const [timeRange, setTimeRange] = useState(String(loaderData?.days || "30"));
  const [activeFilter, setActiveFilter] = useState<FilterMode>("all");

  const [tableVisibleCount, setTableVisibleCount] = useState(20);
  const tableBottomRef = useRef<HTMLDivElement>(null);

  const [modalVisibleCount, setModalVisibleCount] = useState(10);
  const modalBottomRef = useRef<HTMLDivElement>(null);

  const [activeModalCluster, setActiveModalCluster] = useState<{
    clusterName: string;
    products: ClickedProductDetail[];
  } | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(1000);

  useEffect(() => {
    if (loaderData?.days) {
      setTimeRange(String(loaderData.days));
    }
  }, [loaderData?.days]);

  useEffect(() => {
    setTableVisibleCount(20);
  }, [activeFilter, timeRange]);

  useEffect(() => {
    if (activeModalCluster) {
      setModalVisibleCount(10);
    }
  }, [activeModalCluster]);

  useEffect(() => {
    const updateWidth = () => {
      if (containerRef.current) {
        setContainerWidth(containerRef.current.clientWidth);
      }
    };
    updateWidth();
    window.addEventListener("resize", updateWidth);
    return () => window.removeEventListener("resize", updateWidth);
  }, []);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          setTableVisibleCount((prev) => prev + 20);
        }
      },
      { threshold: 0.1 }
    );

    if (tableBottomRef.current) {
      observer.observe(tableBottomRef.current);
    }

    return () => observer.disconnect();
  }, [activeFilter, loaderData?.tableRows]);

  useEffect(() => {
    if (!activeModalCluster) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          setModalVisibleCount((prev) => prev + 10);
        }
      },
      { threshold: 0.1 }
    );

    if (modalBottomRef.current) {
      observer.observe(modalBottomRef.current);
    }

    return () => observer.disconnect();
  }, [activeModalCluster]);

  const handleTimeRangeChange = (newDays: string) => {
    setTimeRange(newDays);
    submit({ days: newDays }, { method: "get", preventScrollReset: true });
  };

  const chartData = loaderData.chartData || [];
  const maxDataVal = Math.max(...chartData.map((d) => d.totalSearch), 10);
  const maxVal = Math.ceil(maxDataVal * 1.15);

  const minRequiredWidth = Math.max(chartData.length, 1) * 28;
  const svgWidth = Math.max(containerWidth, minRequiredWidth);
  const svgHeight = 240;
  const paddingY = 40;
  const paddingX = 30;
  const chartAreaHeight = svgHeight - paddingY * 2;

  const points = chartData.map((d, index) => {
    const x = paddingX + (index / (chartData.length - 1 || 1)) * (svgWidth - paddingX * 2);
    const yTotal = svgHeight - paddingY - (d.totalSearch / maxVal) * chartAreaHeight;
    const yClick = svgHeight - paddingY - (d.clickSearch / maxVal) * chartAreaHeight;
    const yAbnormal = svgHeight - paddingY - (d.abnormalSearch / maxVal) * chartAreaHeight;
    return { ...d, x, yTotal, yClick, yAbnormal };
  });

  const totalPolyline = points.map((p) => `${p.x},${p.yTotal}`).join(" ");
  const clickPolyline = points.map((p) => `${p.x},${p.yClick}`).join(" ");
  const abnormalPolyline = points.map((p) => `${p.x},${p.yAbnormal}`).join(" ");

  const allRows = loaderData.tableRows || [];
  const filteredRows = allRows.filter((row) => {
    if (activeFilter === "all" || activeFilter === "total") return true;
    if (activeFilter === "good") return row.clicks > 0;
    if (activeFilter === "abnormal") return row.isAbnormal;
    return true;
  });

  const visibleTableRows = filteredRows.slice(0, tableVisibleCount);

  return (
    <div style={{ width: "100%", padding: "0 24px 40px 24px", boxSizing: "border-box", fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif", opacity: isLoading ? 0.6 : 1, transition: "opacity 0.2s" }}>

      {/* HEADER & TIME RANGE GLOBAL FILTER */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 24, borderBottom: "1px solid #e1e3e5", paddingBottom: 16 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: "#1a1a1a" }}>AI Search Analytics & Insights</h1>
          <p style={{ margin: "4px 0 0 0", fontSize: 13, color: "#616161" }}>
            Monitor search performance, customer interaction rates, and abnormal queries requiring optimization.
          </p>
        </div>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <span style={{ fontSize: 13, color: "#616161", fontWeight: 500 }}>Time Range:</span>
          <select
            value={timeRange}
            onChange={(e) => handleTimeRangeChange(e.target.value)}
            style={{ padding: "8px 16px", borderRadius: 8, border: "1px solid #c9cccf", background: "#fff", fontSize: 13, fontWeight: 600, cursor: "pointer" }}
          >
            <option value="7">Last 7 days</option>
            <option value="30">Last 30 days</option>
            <option value="60">Last 60 days</option>
            <option value="90">Last 90 days</option>
          </select>
        </div>
      </div>

      {/* KHỐI 1: OVERVIEW KPIS */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 16, marginBottom: 28 }}>
        <div style={{ background: "#fff", padding: 20, borderRadius: 12, border: "1px solid #e1e3e5", boxShadow: "0 1px 3px rgba(0,0,0,0.04)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", color: "#616161", fontSize: 13, fontWeight: 500 }}>
            <span>Total Searches</span>
            <span style={{ color: "#008060", background: "#e4f8f0", padding: "2px 6px", borderRadius: 4, fontSize: 11, fontWeight: 700 }}>Real-time</span>
          </div>
          <div style={{ fontSize: 28, fontWeight: 700, marginTop: 10, color: "#1a1a1a" }}>
            {loaderData?.kpis?.totalSearches ? loaderData.kpis.totalSearches.toLocaleString() : 0}
          </div>
          <div style={{ fontSize: 12, color: "#8c9196", marginTop: 6 }}>In the last {timeRange} days</div>
        </div>

        <div style={{ background: "#fff", padding: 20, borderRadius: 12, border: "1px solid #e1e3e5", boxShadow: "0 1px 3px rgba(0,0,0,0.04)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", color: "#616161", fontSize: 13, fontWeight: 500 }}>
            <span>Click-Through Rate (CTR)</span>
            <span style={{ color: "#008060", background: "#e4f8f0", padding: "2px 6px", borderRadius: 4, fontSize: 11, fontWeight: 700 }}>Engagement</span>
          </div>
          <div style={{ fontSize: 28, fontWeight: 700, marginTop: 10, color: "#008060" }}>
            {loaderData?.kpis?.overallCTR || "0.0%"}
          </div>
          <div style={{ fontSize: 12, color: "#8c9196", marginTop: 6 }}>Searches with product clicks</div>
        </div>

        <div style={{ background: "#fff", padding: 20, borderRadius: 12, border: "1px solid #e1e3e5", boxShadow: "0 1px 3px rgba(0,0,0,0.04)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", color: "#616161", fontSize: 13, fontWeight: 500 }}>
            <span>Abnormal Searches</span>
            <span style={{ color: "#d32f2f", background: "#ffebe9", padding: "2px 6px", borderRadius: 4, fontSize: 11, fontWeight: 700 }}>Attention Required</span>
          </div>
          <div style={{ fontSize: 28, fontWeight: 700, marginTop: 10, color: "#d32f2f" }}>
            {loaderData?.kpis?.abnormalRate || "0.0%"}
          </div>
          <div style={{ fontSize: 12, color: "#d32f2f", marginTop: 6 }}>
            {loaderData?.kpis?.abnormalSearches || 0} searches flagged as abnormal
          </div>
        </div>
      </div>

      {/* KHỐI 2: BIỂU ĐỒ - ĐỒNG BỘ 4 NÚT LỌC VỚI KHỐI 3 */}
      <div style={{ background: "#fff", padding: 24, borderRadius: 12, border: "1px solid #e1e3e5", marginBottom: 28, boxShadow: "0 1px 3px rgba(0,0,0,0.04)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
          <div>
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600, color: "#1a1a1a" }}>Search Interactions Over Time</h3>
            <span style={{ fontSize: 12, color: "#616161" }}>Click buttons below to filter chart and table simultaneously</span>
          </div>

          <div style={{ display: "flex", gap: 10, fontSize: 12, fontWeight: 600 }}>
            <button
              type="button"
              onClick={() => setActiveFilter("all")}
              style={{
                background: activeFilter === "all" ? "#1a1a1a" : "transparent",
                color: activeFilter === "all" ? "#ffffff" : "#1a1a1a",
                border: "1px solid",
                borderColor: activeFilter === "all" ? "#1a1a1a" : "#e1e3e5",
                borderRadius: 6,
                padding: "6px 14px",
                cursor: "pointer",
                fontWeight: 600,
                transition: "all 0.15s ease",
              }}
            >
              📊 All
            </button>
            <button
              type="button"
              onClick={() => setActiveFilter("total")}
              style={{
                background: activeFilter === "total" ? "#eef2ff" : "transparent",
                color: "#4f46e5",
                border: "1px solid",
                borderColor: activeFilter === "total" ? "#4f46e5" : "#e1e3e5",
                borderRadius: 6,
                padding: "6px 14px",
                cursor: "pointer",
                fontWeight: 600,
                transition: "all 0.15s ease",
              }}
            >
              🔵 Total Searches
            </button>
            <button
              type="button"
              onClick={() => setActiveFilter("good")}
              style={{
                background: activeFilter === "good" ? "#e4f8f0" : "transparent",
                color: "#008060",
                border: "1px solid",
                borderColor: activeFilter === "good" ? "#008060" : "#e1e3e5",
                borderRadius: 6,
                padding: "6px 14px",
                cursor: "pointer",
                fontWeight: 600,
                transition: "all 0.15s ease",
              }}
            >
              🟢 Searches with Clicks
            </button>
            <button
              type="button"
              onClick={() => setActiveFilter("abnormal")}
              style={{
                background: activeFilter === "abnormal" ? "#ffebe9" : "transparent",
                color: "#d32f2f",
                border: "1px solid",
                borderColor: activeFilter === "abnormal" ? "#d32f2f" : "#e1e3e5",
                borderRadius: 6,
                padding: "6px 14px",
                cursor: "pointer",
                fontWeight: 600,
                transition: "all 0.15s ease",
              }}
            >
              🔴 Abnormal Searches
            </button>
          </div>
        </div>

        <div ref={containerRef} style={{ overflowX: "auto", width: "100%" }}>
          <div style={{ width: svgWidth, position: "relative" }}>
            <svg width={svgWidth} height={svgHeight} style={{ overflow: "visible" }}>
              <line x1={0} y1={paddingY} x2={svgWidth} y2={paddingY} stroke="#f1f2f3" strokeDasharray="4 4" />
              <line x1={0} y1={svgHeight / 2} x2={svgWidth} y2={svgHeight / 2} stroke="#f1f2f3" strokeDasharray="4 4" />
              <line x1={0} y1={svgHeight - paddingY} x2={svgWidth} y2={svgHeight - paddingY} stroke="#e1e3e5" />

              {/* TOTAL SEARCHES (XANH DƯƠNG) */}
              {(activeFilter === "all" || activeFilter === "total") && (
                <>
                  <polyline fill="none" stroke="#4f46e5" strokeWidth="1.5" points={totalPolyline} strokeLinecap="round" strokeLinejoin="round" />
                  {points.map((p) => (
                    <g key={`total-${p.day}`}>
                      <circle cx={p.x} cy={p.yTotal} r="4" fill="#ffffff" stroke="#4f46e5" strokeWidth="2" />
                      <text x={p.x} y={p.yTotal - 8} textAnchor="middle" fontSize="9" fontWeight="700" fill="#4f46e5">{formatChartNumber(p.totalSearch)}</text>
                    </g>
                  ))}
                </>
              )}

              {/* SEARCHES WITH CLICKS (XANH LÁ) */}
              {(activeFilter === "all" || activeFilter === "good") && (
                <>
                  <polyline fill="none" stroke="#008060" strokeWidth="1.5" points={clickPolyline} strokeLinecap="round" strokeLinejoin="round" />
                  {points.map((p) => (
                    <g key={`click-${p.day}`}>
                      <circle cx={p.x} cy={p.yClick} r="4" fill="#ffffff" stroke="#008060" strokeWidth="2" />
                      <text x={p.x} y={p.yClick - 8} textAnchor="middle" fontSize="9" fontWeight="700" fill="#008060">{formatChartNumber(p.clickSearch)}</text>
                    </g>
                  ))}
                </>
              )}

              {/* ABNORMAL SEARCHES (ĐỎ) */}
              {(activeFilter === "all" || activeFilter === "abnormal") && (
                <>
                  <polyline fill="none" stroke="#d32f2f" strokeWidth="1.5" points={abnormalPolyline} strokeLinecap="round" strokeLinejoin="round" />
                  {points.map((p) => (
                    <g key={`abnormal-${p.day}`}>
                      <circle cx={p.x} cy={p.yAbnormal} r="4" fill="#ffffff" stroke="#d32f2f" strokeWidth="2" />
                      <text x={p.x} y={p.yAbnormal + 14} textAnchor="middle" fontSize="9" fontWeight="700" fill="#d32f2f">{formatChartNumber(p.abnormalSearch)}</text>
                    </g>
                  ))}
                </>
              )}

              {points.map((p) => (
                <text key={`label-${p.day}`} x={p.x} y={svgHeight - 10} textAnchor="middle" fontSize="10" fill="#8c9196" fontWeight="500">{`D${p.day}`}</text>
              ))}
            </svg>
          </div>
        </div>
      </div>

      {/* KHỐI 3: BẢNG DỮ LIỆU CÓ PHÂN TRANG CUỘN INFINITE SCROLL */}
      <div style={{ display: "flex", gap: 8, borderBottom: "1px solid #e1e3e5", marginBottom: 20 }}>
        <button
          type="button"
          onClick={() => setActiveFilter("all")}
          style={{
            padding: "12px 20px",
            border: "none",
            background: "none",
            fontWeight: 600,
            fontSize: 14,
            cursor: "pointer",
            color: activeFilter === "all" ? "#1a1a1a" : "#616161",
            borderBottom: activeFilter === "all" ? "3px solid #1a1a1a" : "3px solid transparent",
          }}
        >
          📊 All ({allRows.length})
        </button>
        <button
          type="button"
          onClick={() => setActiveFilter("total")}
          style={{
            padding: "12px 20px",
            border: "none",
            background: "none",
            fontWeight: 600,
            fontSize: 14,
            cursor: "pointer",
            color: activeFilter === "total" ? "#4f46e5" : "#616161",
            borderBottom: activeFilter === "total" ? "3px solid #4f46e5" : "3px solid transparent",
          }}
        >
          🔵 Total Searches ({allRows.length})
        </button>
        <button
          type="button"
          onClick={() => setActiveFilter("good")}
          style={{
            padding: "12px 20px",
            border: "none",
            background: "none",
            fontWeight: 600,
            fontSize: 14,
            cursor: "pointer",
            color: activeFilter === "good" ? "#008060" : "#616161",
            borderBottom: activeFilter === "good" ? "3px solid #008060" : "3px solid transparent",
          }}
        >
          🟢 Searches with Clicks ({allRows.filter(r => r.clicks > 0).length})
        </button>
        <button
          type="button"
          onClick={() => setActiveFilter("abnormal")}
          style={{
            padding: "12px 20px",
            border: "none",
            background: "none",
            fontWeight: 600,
            fontSize: 14,
            cursor: "pointer",
            color: activeFilter === "abnormal" ? "#d32f2f" : "#616161",
            borderBottom: activeFilter === "abnormal" ? "3px solid #d32f2f" : "3px solid transparent",
          }}
        >
          🔴 Abnormal Searches ({allRows.filter(r => r.isAbnormal).length})
        </button>
      </div>

      <div style={{ background: "#fff", borderRadius: 12, border: "1px solid #e1e3e5", overflow: "hidden", boxShadow: "0 1px 3px rgba(0,0,0,0.04)" }}>
        {/* TABLE-LAYOUT: FIXED DÙNG ĐỂ CỐ ĐỊNH HOÀN TOÀN TỶ LỆ CỘT */}
        <table style={{ width: "100%", tableLayout: "fixed", borderCollapse: "collapse", fontSize: 13, textAlign: "left" }}>
          <thead>
            <tr style={{ background: "#f6f6f7", borderBottom: "1px solid #e1e3e5", color: "#4a4a4a" }}>
              <th style={{ padding: "14px 12px", width: "15%" }}>Keyword / Cluster</th>
              <th style={{ padding: "14px 12px", width: "16%" }}>User Query Variants</th>
              <th style={{ padding: "14px 8px", textAlign: "center", width: "6%" }}>Searches</th>
              <th style={{ padding: "14px 8px", textAlign: "center", width: "5%" }}>Clicks</th>
              <th style={{ padding: "14px 8px", textAlign: "center", width: "6%" }}>CTR</th>
              <th style={{ padding: "14px 8px", textAlign: "center", width: "8%" }}>Status</th>
              <th style={{ padding: "14px 12px", width: "19%" }}>Abnormal Reason</th>
              <th style={{ padding: "14px 12px", width: "25%" }}>Top Clicked Products</th>
            </tr>
          </thead>
          <tbody>
            {visibleTableRows.map((row, index) => {
              const topProduct = row.products[0];

              return (
                <tr key={index} style={{ borderBottom: "1px solid #f1f2f3" }}>
                  <td style={{ padding: "16px 18px", fontWeight: 700, color: "#1a1a1a", wordBreak: "break-word" }}>{row.cluster}</td>
                  <td style={{ padding: "16px 18px", color: "#616161", wordBreak: "break-word" }}>{row.variants}</td>
                  <td style={{ padding: "16px 18px", textAlign: "center", fontWeight: 600 }}>{row.searches}</td>
                  <td style={{ padding: "16px 18px", textAlign: "center", fontWeight: 600 }}>{row.clicks}</td>
                  <td style={{ padding: "16px 18px", textAlign: "center", fontWeight: 700, color: row.isAbnormal ? "#d32f2f" : "#008060" }}>{row.ctr}</td>
                  <td style={{ padding: "16px 18px", textAlign: "center" }}>
                    <span style={{ padding: "4px 10px", borderRadius: 6, fontSize: 12, fontWeight: 700, background: row.statusBg, color: row.statusColor, display: "inline-block" }}>{row.statusText}</span>
                  </td>
                  <td style={{ padding: "16px 18px", color: row.isAbnormal ? "#d32f2f" : "#8c9196", fontWeight: row.isAbnormal ? 600 : 400, wordBreak: "break-word" }}>{row.abnormalReason}</td>
                  
                  {/* TÊN SẢN PHẨM & POPUP MODAL */}
                  <td style={{ padding: "16px 18px", wordBreak: "break-word" }}>
                    {topProduct ? (
                      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                        <a
                          href={topProduct.productUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{ fontWeight: 600, color: "#2c6ecb", fontSize: 13, textDecoration: "none", lineHeight: "1.3", wordBreak: "break-word" }}
                          title="Click to open product in a new tab"
                        >
                          {topProduct.title} ↗
                        </a>
                        <div style={{ fontSize: 11, color: "#008060", fontWeight: 600 }}>
                          🔥 {topProduct.clickCount} clicks
                        </div>
                        {row.products.length > 0 && (
                          <button
                            type="button"
                            onClick={() => setActiveModalCluster({ clusterName: row.cluster, products: row.products })}
                            style={{
                              marginTop: 4,
                              alignSelf: "flex-start",
                              background: "#f1f2f3",
                              border: "1px solid #c9cccf",
                              borderRadius: 4,
                              padding: "4px 8px",
                              fontSize: 11,
                              fontWeight: 600,
                              color: "#303030",
                              cursor: "pointer",
                            }}
                          >
                            🔍 View All Products ({row.products.length})
                          </button>
                        )}
                      </div>
                    ) : (
                      <span style={{ color: "#8c9196", fontSize: 12 }}>— No Clicks —</span>
                    )}
                  </td>
                </tr>
              );
            })}
            {filteredRows.length === 0 && (
              <tr>
                <td colSpan={8} style={{ padding: "36px 18px", textAlign: "center", color: "#616161", fontSize: 13, background: "#fafafa" }}>
                  No search query log data found for this filter mode in CSDL.
                </td>
              </tr>
            )}
          </tbody>
        </table>

        {/* PHẦN TỬ CẢM BIẾN CUỘN TRANG BẢNG CHÍNH (KHỐI 3) */}
        {visibleTableRows.length < filteredRows.length && (
          <div ref={tableBottomRef} style={{ padding: "16px", textAlign: "center", color: "#8c9196", fontSize: 12, fontWeight: 500 }}>
            ⏳ Scroll down to load more rows ({visibleTableRows.length}/{filteredRows.length})...
          </div>
        )}
      </div>

      {/* POP-UP MODAL CÓ PHÂN TRANG INFINITE SCROLL */}
      {activeModalCluster && (
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            width: "100vw",
            height: "100vh",
            backgroundColor: "rgba(0, 0, 0, 0.5)",
            display: "flex",
            justifyContent: "center",
            alignItems: "center",
            zIndex: 99999,
          }}
          onClick={() => setActiveModalCluster(null)}
        >
          <div
            style={{
              background: "#fff",
              borderRadius: 12,
              width: "90%",
              maxWidth: "580px",
              maxHeight: "80vh",
              overflow: "hidden",
              boxShadow: "0 10px 25px rgba(0,0,0,0.2)",
              display: "flex",
              flexDirection: "column",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* MODAL HEADER */}
            <div style={{ padding: "16px 20px", borderBottom: "1px solid #e1e3e5", display: "flex", justifyContent: "space-between", alignItems: "center", background: "#f6f6f7" }}>
              <div>
                <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "#1a1a1a" }}>
                  Top Interacted Products
                </h3>
                <span style={{ fontSize: 12, color: "#616161" }}>
                  Keyword Cluster: <strong>"{activeModalCluster.clusterName}"</strong>
                </span>
              </div>
              <button
                type="button"
                onClick={() => setActiveModalCluster(null)}
                style={{ background: "none", border: "none", fontSize: 20, cursor: "pointer", color: "#616161", fontWeight: 700 }}
              >
                ✕
              </button>
            </div>

            {/* MODAL BODY CÓ KHUNG CUỘN RIÊNG */}
            <div style={{ padding: "16px 20px", overflowY: "auto", flex: 1 }}>
              <table style={{ width: "100%", tableLayout: "fixed", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr style={{ borderBottom: "1px solid #e1e3e5", color: "#616161", textAlign: "left" }}>
                    <th style={{ paddingBottom: 10, width: "70%" }}>Product Title</th>
                    <th style={{ paddingBottom: 10, textAlign: "center", width: "30%" }}>Total Clicks</th>
                  </tr>
                </thead>
                <tbody>
                  {activeModalCluster.products.slice(0, modalVisibleCount).map((p, idx) => (
                    <tr key={idx} style={{ borderBottom: "1px solid #f1f2f3" }}>
                      <td style={{ padding: "14px 0", wordBreak: "break-word" }}>
                        <a
                          href={p.productUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{
                            fontWeight: 600,
                            color: "#005bd3",
                            textDecoration: "none",
                            fontSize: 14,
                            display: "inline-block",
                            wordBreak: "break-word",
                          }}
                          title="Click to open product page in a new tab"
                        >
                          {p.title} <span style={{ fontSize: 11, color: "#8c9196" }}>↗</span>
                        </a>
                      </td>
                      <td style={{ padding: "14px 0", textAlign: "center", fontWeight: 700, color: "#008060" }}>
                        {p.clickCount} clicks
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {/* PHẦN TỬ CẢM BIẾN CUỘN TRONG MODAL */}
              {modalVisibleCount < activeModalCluster.products.length && (
                <div ref={modalBottomRef} style={{ padding: "12px", textAlign: "center", color: "#8c9196", fontSize: 11, fontWeight: 500 }}>
                  ⏳ Scroll inside modal to load more products ({Math.min(modalVisibleCount, activeModalCluster.products.length)}/{activeModalCluster.products.length})...
                </div>
              )}
            </div>

            {/* MODAL FOOTER */}
            <div style={{ padding: "12px 20px", borderTop: "1px solid #e1e3e5", textAlign: "right", background: "#fafafa" }}>
              <button
                type="button"
                onClick={() => setActiveModalCluster(null)}
                style={{ padding: "8px 16px", borderRadius: 6, border: "1px solid #c9cccf", background: "#fff", fontWeight: 600, cursor: "pointer" }}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}