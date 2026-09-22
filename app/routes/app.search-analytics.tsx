import type { LoaderFunctionArgs } from "react-router";
import { Form, Link, useLoaderData } from "react-router";

import { authenticate } from "../shopify.server";
import { getMerchantSearchClusters } from "../services/search/search-analytics.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const requestedDays = Number.parseInt(url.searchParams.get("days") || "30", 10);
  const days = Number.isSafeInteger(requestedDays)
    ? Math.max(1, Math.min(requestedDays, 365))
    : 30;
  const view = url.searchParams.get("view") === "abnormal" ? "abnormal" : "healthy";

  const clusters = await getMerchantSearchClusters(session.shop, days);
  const healthyClusters = clusters.filter(
    (cluster) => cluster.classification === "HEALTHY",
  );
  const abnormalClusters = clusters.filter(
    (cluster) => cluster.classification !== "HEALTHY",
  );

  return {
    days,
    view,
    clusters,
    summary: {
      recurringClusters: clusters.length,
      recurringSearches: clusters.reduce(
        (sum, cluster) => sum + cluster.searchCount,
        0,
      ),
      healthyClusters: healthyClusters.length,
      abnormalClusters: abnormalClusters.length,
      noResultsClusters: abnormalClusters.filter(
        (cluster) => cluster.classification === "NO_RESULTS",
      ).length,
      lowSimilarityClusters: abnormalClusters.filter(
        (cluster) => cluster.classification === "LOW_SIMILARITY",
      ).length,
      highSimilarityNoClickClusters: abnormalClusters.filter(
        (cluster) => cluster.classification === "HIGH_SIMILARITY_NO_CLICK",
      ).length,
    },
  };
};

function percentage(value: number) {
  return `${(value * 100).toFixed(1)}%`;
}

function score(value: number | null) {
  return value === null ? "—" : value.toFixed(3);
}

function classificationLabel(value: string) {
  switch (value) {
    case "NO_RESULTS":
      return "Không có kết quả";
    case "HIGH_SIMILARITY_NO_CLICK":
      return "Tương đồng cao, không click";
    case "LOW_SIMILARITY":
      return "Độ tương đồng thấp";
    default:
      return "Hoạt động tốt";
  }
}

const dangerCell = {
  background: "#fee2e2",
  color: "#b42318",
  fontWeight: 600,
} as const;

const warningCell = {
  background: "#fff4e5",
  color: "#8a4b08",
  fontWeight: 600,
} as const;

const cardStyle = {
  border: "1px solid #ddd",
  borderRadius: 10,
  padding: 14,
  minWidth: 150,
  flex: "1 1 150px",
  background: "#fff",
} as const;

const cardValueStyle = {
  display: "block",
  fontSize: 24,
  fontWeight: 700,
  marginTop: 4,
} as const;

type Cluster = Awaited<ReturnType<typeof getMerchantSearchClusters>>[number];

function AnalyticsTable({
  clusters,
  abnormal,
}: {
  clusters: Cluster[];
  abnormal: boolean;
}) {
  return (
    <div style={{ overflowX: "auto", marginTop: 16 }}>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr>
            {[
              "Query đại diện",
              "Biến thể cùng lớp",
              "Search",
              "Không kết quả",
              "Result rate",
              "Search có click",
              "Clicks",
              "CTR",
              "Top score TB",
              "Threshold TB",
              "Trạng thái",
              "Sản phẩm nổi bật",
            ].map((heading) => (
              <th
                key={heading}
                style={{
                  textAlign: "left",
                  padding: 8,
                  borderBottom: "1px solid #ddd",
                  whiteSpace: "nowrap",
                }}
              >
                {heading}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {clusters.map((cluster, index) => {
            const noResults = cluster.classification === "NO_RESULTS";
            const noClicks =
              cluster.classification === "HIGH_SIMILARITY_NO_CLICK";
            const lowSimilarity = cluster.classification === "LOW_SIMILARITY";
            const cell = { padding: 8, borderBottom: "1px solid #eee" };

            return (
              <tr key={`${cluster.label}-${index}`}>
                <td style={{ ...cell, minWidth: 180, fontWeight: 600 }}>
                  {cluster.label}
                </td>
                <td style={{ ...cell, minWidth: 260 }}>
                  {cluster.variants
                    .map((variant) => `${variant.query} (${variant.searchCount})`)
                    .join(", ")}
                </td>
                <td style={cell}>{cluster.searchCount}</td>
                <td style={{ ...cell, ...(noResults ? dangerCell : {}) }}>
                  {cluster.zeroResultCount}
                </td>
                <td style={{ ...cell, ...(noResults ? dangerCell : {}) }}>
                  {percentage(cluster.resultRate)}
                </td>
                <td style={{ ...cell, ...(noClicks ? dangerCell : {}) }}>
                  {cluster.clickedSearches}
                </td>
                <td style={{ ...cell, ...(noClicks ? dangerCell : {}) }}>
                  {cluster.clickCount}
                </td>
                <td style={{ ...cell, ...(noClicks ? dangerCell : {}) }}>
                  {percentage(cluster.clickThroughRate)}
                </td>
                <td
                  style={{
                    ...cell,
                    ...(lowSimilarity ? warningCell : {}),
                  }}
                >
                  {score(cluster.averageTopScore)}
                </td>
                <td style={cell}>{score(cluster.averageThreshold)}</td>
                <td
                  style={{
                    ...cell,
                    minWidth: 210,
                    ...(abnormal ? dangerCell : {}),
                  }}
                >
                  {classificationLabel(cluster.classification)}
                </td>
                <td style={{ ...cell, minWidth: 300 }}>
                  {cluster.commonProducts.length
                    ? cluster.commonProducts
                        .map(
                          (product) =>
                            `${product.handle} (${product.appearances} lần, ${product.clickCount} click, rank TB #${product.averageRank.toFixed(1)})`,
                        )
                        .join(", ")
                    : "—"}
                </td>
              </tr>
            );
          })}
          {clusters.length === 0 ? (
            <tr>
              <td colSpan={12} style={{ padding: 16 }}>
                Chưa có lớp search lặp lại thuộc nhóm này trong khoảng thời gian
                đã chọn. Dashboard cố ý bỏ các search đơn lẻ để tránh báo động
                nhiễu.
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}

export default function SearchAnalyticsPage() {
  const data = useLoaderData<typeof loader>();
  const abnormal = data.view === "abnormal";
  const visibleClusters = data.clusters
    .filter((cluster) =>
      abnormal
        ? cluster.classification !== "HEALTHY"
        : cluster.classification === "HEALTHY",
    )
    .sort((left, right) =>
      abnormal
        ? right.searchCount - left.searchCount ||
          left.clickThroughRate - right.clickThroughRate
        : right.clickCount - left.clickCount ||
          right.searchCount - left.searchCount,
    );

  return (
    <s-page heading="Search Analytics">
      <s-section heading={`Phân tích ${data.days} ngày gần nhất`}>
        <s-text>
          Dashboard chỉ hiển thị các lớp query lặp lại. Query có kết quả được
          gom chủ yếu theo top product ID + vị trí xếp hạng; NO_RESULTS dùng
          fingerprint nhỏ sinh từ embedding đã có sẵn, không gọi thêm AI.
        </s-text>

        <Form
          method="get"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginTop: 16,
            flexWrap: "wrap",
          }}
        >
          <input type="hidden" name="view" value={data.view} />
          <label htmlFor="analytics-days" style={{ fontWeight: 600 }}>
            Khoảng thời gian
          </label>
          <select id="analytics-days" name="days" defaultValue={String(data.days)}>
            <option value="7">7 ngày</option>
            <option value="30">30 ngày</option>
            <option value="90">90 ngày</option>
            <option value="180">180 ngày</option>
            <option value="365">365 ngày</option>
          </select>
          <button type="submit">Áp dụng</button>
        </Form>

        <div
          style={{
            display: "flex",
            gap: 10,
            flexWrap: "wrap",
            marginTop: 16,
          }}
        >
          <div style={cardStyle}>
            <span>Lớp lặp lại</span>
            <strong style={cardValueStyle}>{data.summary.recurringClusters}</strong>
          </div>
          <div style={cardStyle}>
            <span>Search trong các lớp</span>
            <strong style={cardValueStyle}>{data.summary.recurringSearches}</strong>
          </div>
          <div style={cardStyle}>
            <span>Hoạt động tốt</span>
            <strong style={cardValueStyle}>{data.summary.healthyClusters}</strong>
          </div>
          <div style={cardStyle}>
            <span>Bất thường</span>
            <strong style={cardValueStyle}>{data.summary.abnormalClusters}</strong>
          </div>
        </div>

        <div
          style={{
            display: "flex",
            gap: 8,
            marginTop: 18,
            borderBottom: "1px solid #ddd",
          }}
        >
          <Link
            to={`/app/search-analytics?view=healthy&days=${data.days}`}
            style={{
              padding: "10px 14px",
              textDecoration: "none",
              fontWeight: 600,
              color: !abnormal ? "#004299" : "#616161",
              borderBottom: !abnormal
                ? "3px solid #004299"
                : "3px solid transparent",
            }}
          >
            Search hoạt động tốt ({data.summary.healthyClusters})
          </Link>
          <Link
            to={`/app/search-analytics?view=abnormal&days=${data.days}`}
            style={{
              padding: "10px 14px",
              textDecoration: "none",
              fontWeight: 600,
              color: abnormal ? "#b42318" : "#616161",
              borderBottom: abnormal
                ? "3px solid #b42318"
                : "3px solid transparent",
            }}
          >
            Search bất thường ({data.summary.abnormalClusters})
          </Link>
        </div>

        {abnormal ? (
          <div
            style={{
              display: "flex",
              gap: 12,
              flexWrap: "wrap",
              marginTop: 14,
              fontSize: 13,
            }}
          >
            <span>Không kết quả: {data.summary.noResultsClusters}</span>
            <span>Độ tương đồng thấp: {data.summary.lowSimilarityClusters}</span>
            <span>
              Tương đồng cao nhưng không click: {data.summary.highSimilarityNoClickClusters}
            </span>
          </div>
        ) : null}

        <AnalyticsTable clusters={visibleClusters} abnormal={abnormal} />
      </s-section>
    </s-page>
  );
}
