import { useState, useMemo, useRef, useEffect } from "react";

// Kiểu dữ liệu bộ lọc
type FilterMode = "all" | "healthy" | "abnormal" | "zero";

// Hàm hỗ trợ rút gọn số lớn (K/M) giúp hiển thị gọn gàng trên biểu đồ
function formatChartNumber(num: number): string {
  if (num >= 1_000_000) {
    return (num / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  }
  if (num >= 1_000) {
    return (num / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
  }
  return num.toString();
}

export default function SearchAnalyticsPage() {
  const [timeRange, setTimeRange] = useState("30");

  // 1. STATE DÀNH RIÊNG CHO KHỐI 2 (BIỂU ĐỒ LINE)
  const [chartFilter, setChartFilter] = useState<FilterMode>("all");

  // 2. STATE DÀNH RIÊNG CHO KHỐI 3 (BẢNG)
  const [tableTab, setTableTab] = useState<FilterMode>("all");

  // Đo chiều rộng thực tế của container biểu đồ
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(1000);

  const daysCount = Number.parseInt(timeRange, 10);

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

  // Dữ liệu cho Biểu đồ Line Khối 2
  const chartData = useMemo(() => {
    return Array.from({ length: daysCount }, (_, i) => {
      const clickSearch = Math.floor(Math.random() * 40) + 15;
      const abnormalSearch = Math.floor(Math.random() * 15) + 5;
      const totalSearch = clickSearch + abnormalSearch + Math.floor(Math.random() * 20) + 10;

      return {
        day: i + 1,
        totalSearch,
        clickSearch,
        abnormalSearch,
      };
    });
  }, [daysCount]);

  // Tự động tìm giá trị lớn nhất trong dữ liệu + thêm 15% không gian phía trên
  const maxDataVal = Math.max(...chartData.map((d) => d.totalSearch), 10);
  const maxVal = Math.ceil(maxDataVal * 1.15);

  // Cấu hình kích thước SVG linh hoạt
  const minRequiredWidth = daysCount * 28;
  const svgWidth = Math.max(containerWidth, minRequiredWidth);
  const svgHeight = 240;
  const paddingY = 40;
  const paddingX = 30;
  const chartAreaHeight = svgHeight - paddingY * 2;

  // Tính tọa độ (X, Y) cho từng điểm dữ liệu
  const points = chartData.map((d, index) => {
    const x = paddingX + (index / (daysCount - 1 || 1)) * (svgWidth - paddingX * 2);
    const yTotal = svgHeight - paddingY - (d.totalSearch / maxVal) * chartAreaHeight;
    const yClick = svgHeight - paddingY - (d.clickSearch / maxVal) * chartAreaHeight;
    const yAbnormal = svgHeight - paddingY - (d.abnormalSearch / maxVal) * chartAreaHeight;
    return { ...d, x, yTotal, yClick, yAbnormal };
  });

  const totalPolyline = points.map((p) => `${p.x},${p.yTotal}`).join(" ");
  const clickPolyline = points.map((p) => `${p.x},${p.yClick}`).join(" ");
  const abnormalPolyline = points.map((p) => `${p.x},${p.yAbnormal}`).join(" ");

  // Dữ liệu dòng cho Bảng Khối 3
  const allRows = [
    {
      cluster: "green snow",
      intent: "Intent: Mua ván trượt tuyết",
      variants: "green snow, snowboard green",
      searches: 142,
      clicks: 48,
      ctr: "33.8%",
      type: "healthy",
      statusText: "Hoạt động tốt",
      statusBg: "#e4f8f0",
      statusColor: "#008060",
      abnormalReason: "—",
      productNote: "the-compare-at-price-snowboard (24 clicks)",
    },
    {
      cluster: "winter jacket",
      intent: "Intent: Áo ấm mùa đông",
      variants: "áo ấm, áo khoác tuyết",
      searches: 89,
      clicks: 0,
      ctr: "0.0%",
      type: "abnormal",
      statusText: "Cần tối ưu",
      statusBg: "#fff8e5",
      statusColor: "#b78103",
      abnormalReason: "Có kết quả tìm kiếm nhưng không có click",
      productNote: "Kết quả chưa khớp nhu cầu giá",
    },
    {
      cluster: "nike air max",
      intent: "Mất cơ hội bán hàng",
      variants: "nike air, giay nike",
      searches: 38,
      clicks: 0,
      ctr: "0.0%",
      type: "zero",
      statusText: "Bất thường",
      statusBg: "#ffebe9",
      statusColor: "#d32f2f",
      abnormalReason: "Không có kết quả",
      productNote: "Gợi ý: Cần nhập thêm dòng sản phẩm này",
    },
    {
      cluster: "running shoes cheap",
      intent: "Intent: Giày chạy giá rẻ",
      variants: "giay chay gia re, shoes sale",
      searches: 64,
      clicks: 2,
      ctr: "3.1%",
      type: "abnormal",
      statusText: "Cần tối ưu",
      statusBg: "#fff8e5",
      statusColor: "#b78103",
      abnormalReason: "Top độ tương đồng thấp",
      productNote: "Sản phẩm gợi ý chưa đúng phân khúc giá",
    },
  ];

  const filteredRows = allRows.filter((row) => {
    if (tableTab === "all") return true;
    if (tableTab === "healthy") return row.type === "healthy";
    if (tableTab === "abnormal") return row.type === "abnormal";
    if (tableTab === "zero") return row.type === "zero";
    return true;
  });

  return (
    <div style={{ width: "100%", padding: "0 24px 40px 24px", boxSizing: "border-box", fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" }}>

      {/* HEADER & BỘ LỌC THỜI GIAN */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 24, borderBottom: "1px solid #e1e3e5", paddingBottom: 16 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: "#1a1a1a" }}>AI Search Analytics & Insights</h1>
          <p style={{ margin: "4px 0 0 0", fontSize: 13, color: "#616161" }}>
            Phân tích hiệu năng công cụ tìm kiếm AI, tỷ lệ tương tác và các truy vấn cần tối ưu.
          </p>
        </div>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <span style={{ fontSize: 13, color: "#616161", fontWeight: 500 }}>Khoảng thời gian:</span>
          <select
            value={timeRange}
            onChange={(e) => setTimeRange(e.target.value)}
            style={{ padding: "8px 16px", borderRadius: 8, border: "1px solid #c9cccf", background: "#fff", fontSize: 13, fontWeight: 600, cursor: "pointer" }}
          >
            <option value="7">7 ngày qua</option>
            <option value="30">30 ngày qua</option>
            <option value="60">60 ngày qua</option>
            <option value="90">90 ngày qua</option>
          </select>
        </div>
      </div>

      {/* KHỐI 1: KPIS TỔNG QUAN */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 16, marginBottom: 28 }}>
        <div style={{ background: "#fff", padding: 20, borderRadius: 12, border: "1px solid #e1e3e5", boxShadow: "0 1px 3px rgba(0,0,0,0.04)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", color: "#616161", fontSize: 13, fontWeight: 500 }}>
            <span>Tổng lượt tìm kiếm</span>
            <span style={{ color: "#008060", background: "#e4f8f0", padding: "2px 6px", borderRadius: 4, fontSize: 11, fontWeight: 700 }}>+12.5%</span>
          </div>
          <div style={{ fontSize: 28, fontWeight: 700, marginTop: 10, color: "#1a1a1a" }}>1,248</div>
          <div style={{ fontSize: 12, color: "#8c9196", marginTop: 6 }}>Trong {timeRange} ngày qua</div>
        </div>

        <div style={{ background: "#fff", padding: 20, borderRadius: 12, border: "1px solid #e1e3e5", boxShadow: "0 1px 3px rgba(0,0,0,0.04)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", color: "#616161", fontSize: 13, fontWeight: 500 }}>
            <span>Tỷ lệ Click (CTR)</span>
            <span style={{ color: "#008060", background: "#e4f8f0", padding: "2px 6px", borderRadius: 4, fontSize: 11, fontWeight: 700 }}>Hiệu quả</span>
          </div>
          <div style={{ fontSize: 28, fontWeight: 700, marginTop: 10, color: "#008060" }}>24.8%</div>
          <div style={{ fontSize: 12, color: "#8c9196", marginTop: 6 }}>Trung bình 3.2 click / tìm kiếm</div>
        </div>

        <div style={{ background: "#fff", padding: 20, borderRadius: 12, border: "1px solid #e1e3e5", boxShadow: "0 1px 3px rgba(0,0,0,0.04)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", color: "#616161", fontSize: 13, fontWeight: 500 }}>
            <span>Search bất thường</span>
            <span style={{ color: "#d32f2f", background: "#ffebe9", padding: "2px 6px", borderRadius: 4, fontSize: 11, fontWeight: 700 }}>Cần chú ý</span>
          </div>
          <div style={{ fontSize: 28, fontWeight: 700, marginTop: 10, color: "#d32f2f" }}>12.4%</div>
          <div style={{ fontSize: 12, color: "#d32f2f", marginTop: 6 }}>155 truy vấn không tối ưu hoặc 0 click</div>
        </div>
      </div>

      {/* KHỐI 2: BIỂU ĐỒ LINE CÓ AUTO-RESPONSIVE & CHỐNG CHỒNG CHỮ */}
      <div style={{ background: "#fff", padding: 24, borderRadius: 12, border: "1px solid #e1e3e5", marginBottom: 28, boxShadow: "0 1px 3px rgba(0,0,0,0.04)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
          <div>
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600, color: "#1a1a1a" }}>Tìm kiếm tương tác theo thời gian</h3>
            <span style={{ fontSize: 12, color: "#616161" }}>Chọn các nút chú thích để bật/tắt hiển thị đường line</span>
          </div>

          <div style={{ display: "flex", gap: 12, fontSize: 12, fontWeight: 600 }}>
            <button
              type="button"
              onClick={() => setChartFilter("all")}
              style={{
                background: chartFilter === "all" ? "#f1f2f3" : "transparent",
                border: "1px solid",
                borderColor: chartFilter === "all" ? "#1a1a1a" : "#e1e3e5",
                borderRadius: 6,
                padding: "6px 12px",
                cursor: "pointer",
                fontWeight: 600,
                color: "#1a1a1a",
              }}
            >
              📊 Hiển thị tất cả
            </button>
            <button
              type="button"
              onClick={() => setChartFilter("healthy")}
              style={{
                background: chartFilter === "healthy" ? "#eef2ff" : "transparent",
                border: "1px solid",
                borderColor: chartFilter === "healthy" ? "#4f46e5" : "#e1e3e5",
                borderRadius: 6,
                padding: "6px 12px",
                cursor: "pointer",
                fontWeight: 600,
                color: "#4f46e5",
                display: "flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              <span style={{ width: 12, height: 3, background: "#4f46e5", borderRadius: 2 }}></span> Tổng lượt search
            </button>
            <button
              type="button"
              onClick={() => setChartFilter("abnormal")}
              style={{
                background: chartFilter === "abnormal" ? "#e4f8f0" : "transparent",
                border: "1px solid",
                borderColor: chartFilter === "abnormal" ? "#008060" : "#e1e3e5",
                borderRadius: 6,
                padding: "6px 12px",
                cursor: "pointer",
                fontWeight: 600,
                color: "#008060",
                display: "flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              <span style={{ width: 12, height: 3, background: "#008060", borderRadius: 2 }}></span> Search kèm click
            </button>
            <button
              type="button"
              onClick={() => setChartFilter("zero")}
              style={{
                background: chartFilter === "zero" ? "#ffebe9" : "transparent",
                border: "1px solid",
                borderColor: chartFilter === "zero" ? "#d32f2f" : "#e1e3e5",
                borderRadius: 6,
                padding: "6px 12px",
                cursor: "pointer",
                fontWeight: 600,
                color: "#d32f2f",
                display: "flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              <span style={{ width: 12, height: 3, background: "#d32f2f", borderRadius: 2 }}></span> Search bất thường
            </button>
          </div>
        </div>

        {/* CONTAINER SVG FULL WIDTH */}
        <div ref={containerRef} style={{ overflowX: "auto", width: "100%" }}>
          <div style={{ width: svgWidth, position: "relative" }}>
            <svg width={svgWidth} height={svgHeight} style={{ overflow: "visible" }}>
              {/* Lưới ngang */}
              <line x1={0} y1={paddingY} x2={svgWidth} y2={paddingY} stroke="#f1f2f3" strokeDasharray="4 4" />
              <line x1={0} y1={svgHeight / 2} x2={svgWidth} y2={svgHeight / 2} stroke="#f1f2f3" strokeDasharray="4 4" />
              <line x1={0} y1={svgHeight - paddingY} x2={svgWidth} y2={svgHeight - paddingY} stroke="#e1e3e5" />

              {/* Đường Tím: Tổng lượt search */}
              {(chartFilter === "all" || chartFilter === "healthy") && (
                <>
                  <polyline fill="none" stroke="#4f46e5" strokeWidth="1" points={totalPolyline} strokeLinecap="round" strokeLinejoin="round" />
                  {points.map((p) => (
                    <g key={`total-${p.day}`}>
                      <circle cx={p.x} cy={p.yTotal} r="4" fill="#ffffff" stroke="#4f46e5" strokeWidth="2" />
                      <text x={p.x} y={p.yTotal - 8} textAnchor="middle" fontSize="9" fontWeight="700" fill="#4f46e5">
                        {formatChartNumber(p.totalSearch)}
                      </text>
                    </g>
                  ))}
                </>
              )}

              {/* Đường Xanh lá: Search kèm click */}
              {(chartFilter === "all" || chartFilter === "abnormal") && (
                <>
                  <polyline fill="none" stroke="#008060" strokeWidth="1" points={clickPolyline} strokeLinecap="round" strokeLinejoin="round" />
                  {points.map((p) => {
                    const closeToTotal = Math.abs(p.yClick - p.yTotal) < 16;
                    const textY = closeToTotal ? p.yClick + 16 : p.yClick - 8;

                    return (
                      <g key={`click-${p.day}`}>
                        <circle cx={p.x} cy={p.yClick} r="4" fill="#ffffff" stroke="#008060" strokeWidth="2" />
                        <text x={p.x} y={textY} textAnchor="middle" fontSize="9" fontWeight="700" fill="#008060">
                          {formatChartNumber(p.clickSearch)}
                        </text>
                      </g>
                    );
                  })}
                </>
              )}

              {/* Đường Đỏ: Search bất thường */}
              {(chartFilter === "all" || chartFilter === "zero") && (
                <>
                  <polyline fill="none" stroke="#d32f2f" strokeWidth="1" points={abnormalPolyline} strokeLinecap="round" strokeLinejoin="round" />
                  {points.map((p) => {
                    const closeToClick = Math.abs(p.yAbnormal - p.yClick) < 18;
                    const textY = closeToClick ? p.yAbnormal + 18 : p.yAbnormal + 14;

                    return (
                      <g key={`abnormal-${p.day}`}>
                        <circle cx={p.x} cy={p.yAbnormal} r="4" fill="#ffffff" stroke="#d32f2f" strokeWidth="2" />
                        <text x={p.x} y={textY} textAnchor="middle" fontSize="9" fontWeight="700" fill="#d32f2f">
                          {formatChartNumber(p.abnormalSearch)}
                        </text>
                      </g>
                    );
                  })}
                </>
              )}

              {/* Nhãn mốc thời gian dưới trục X */}
              {points.map((p) => (
                <text key={`label-${p.day}`} x={p.x} y={svgHeight - 10} textAnchor="middle" fontSize="10" fill="#8c9196" fontWeight="500">
                  {daysCount > 30 ? (p.day % 5 === 0 || p.day === 1 ? `N${p.day}` : "") : `N${p.day}`}
                </text>
              ))}
            </svg>
          </div>
        </div>
      </div>

      {/* KHỐI 3: BẢNG DỮ LIỆU ĐỘC LẬP */}
      <div style={{ display: "flex", gap: 8, borderBottom: "1px solid #e1e3e5", marginBottom: 20 }}>
        <button
          type="button"
          onClick={() => setTableTab("all")}
          style={{
            padding: "12px 20px",
            border: "none",
            background: "none",
            fontWeight: 600,
            fontSize: 14,
            cursor: "pointer",
            color: tableTab === "all" ? "#1a1a1a" : "#616161",
            borderBottom: tableTab === "all" ? "3px solid #1a1a1a" : "3px solid transparent",
          }}
        >
          📊 Tất cả từ khóa ({allRows.length})
        </button>
        <button
          type="button"
          onClick={() => setTableTab("healthy")}
          style={{
            padding: "12px 20px",
            border: "none",
            background: "none",
            fontWeight: 600,
            fontSize: 14,
            cursor: "pointer",
            color: tableTab === "healthy" ? "#008060" : "#616161",
            borderBottom: tableTab === "healthy" ? "3px solid #008060" : "3px solid transparent",
          }}
        >
          🟢 Từ khóa hiệu quả cao (1)
        </button>
        <button
          type="button"
          onClick={() => setTableTab("abnormal")}
          style={{
            padding: "12px 20px",
            border: "none",
            background: "none",
            fontWeight: 600,
            fontSize: 14,
            cursor: "pointer",
            color: tableTab === "abnormal" ? "#b78103" : "#616161",
            borderBottom: tableTab === "abnormal" ? "3px solid #b78103" : "3px solid transparent",
          }}
        >
          🟡 Cần tối ưu Click / Gợi ý (2)
        </button>
        <button
          type="button"
          onClick={() => setTableTab("zero")}
          style={{
            padding: "12px 20px",
            border: "none",
            background: "none",
            fontWeight: 600,
            fontSize: 14,
            cursor: "pointer",
            color: tableTab === "zero" ? "#d32f2f" : "#616161",
            borderBottom: tableTab === "zero" ? "3px solid #d32f2f" : "3px solid transparent",
          }}
        >
          🔴 Không có kết quả (1)
        </button>
      </div>

      {/* BẢNG BÁO CÁO KHỐI 3 */}
      <div style={{ background: "#fff", borderRadius: 12, border: "1px solid #e1e3e5", overflow: "hidden", boxShadow: "0 1px 3px rgba(0,0,0,0.04)" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, textAlign: "left" }}>
          <thead>
            <tr style={{ background: "#f6f6f7", borderBottom: "1px solid #e1e3e5", color: "#4a4a4a" }}>
              <th style={{ padding: "14px 18px", width: "18%" }}>Từ khóa / Cluster</th>
              <th style={{ padding: "14px 18px", width: "15%" }}>Biến thể khách gõ</th>
              <th style={{ padding: "14px 18px", textAlign: "center" }}>Lượt tìm</th>
              <th style={{ padding: "14px 18px", textAlign: "center" }}>Lượt click</th>
              <th style={{ padding: "14px 18px", textAlign: "center" }}>Tỷ lệ CTR</th>
              <th style={{ padding: "14px 18px", textAlign: "center" }}>Trạng thái</th>
              <th style={{ padding: "14px 18px", width: "22%" }}>Nguyên nhân bất thường</th>
              <th style={{ padding: "14px 18px", width: "22%" }}>Top sản phẩm xem nhiều nhất</th>
            </tr>
          </thead>
          <tbody>
            {filteredRows.map((row, index) => (
              <tr key={index} style={{ borderBottom: "1px solid #f1f2f3" }}>
                <td style={{ padding: "16px 18px", fontWeight: 700, color: "#1a1a1a" }}>
                  {row.cluster}
                  <div style={{ fontSize: 11, color: "#8c9196", fontWeight: 400, marginTop: 2 }}>{row.intent}</div>
                </td>
                <td style={{ padding: "16px 18px", color: "#616161" }}>{row.variants}</td>
                <td style={{ padding: "16px 18px", textAlign: "center", fontWeight: 600 }}>{row.searches}</td>
                <td style={{ padding: "16px 18px", textAlign: "center", fontWeight: 600 }}>{row.clicks}</td>
                <td style={{ padding: "16px 18px", textAlign: "center", fontWeight: 700, color: row.type === "healthy" ? "#008060" : "inherit" }}>
                  {row.ctr}
                </td>
                <td style={{ padding: "16px 18px", textAlign: "center" }}>
                  <span style={{ padding: "4px 10px", borderRadius: 6, fontSize: 12, fontWeight: 700, background: row.statusBg, color: row.statusColor, display: "inline-block" }}>
                    {row.statusText}
                  </span>
                </td>
                <td style={{ padding: "16px 18px", color: row.abnormalReason !== "—" ? "#b78103" : "#8c9196", fontWeight: row.abnormalReason !== "—" ? 600 : 400 }}>
                  {row.abnormalReason}
                </td>
                <td style={{ padding: "16px 18px" }}>
                  <span style={{ color: row.type === "zero" ? "#d32f2f" : "#303030", fontSize: 12, fontWeight: row.type === "zero" ? 600 : 400 }}>
                    {row.productNote}
                  </span>
                </td>
              </tr>
            ))}
            {filteredRows.length === 0 && (
              <tr>
                <td colSpan={8} style={{ padding: 32, textAlign: "center", color: "#616161" }}>
                  Không có dữ liệu phù hợp với nhóm bộ lọc đang chọn.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

    </div>
  );
}