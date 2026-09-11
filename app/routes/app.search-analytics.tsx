import type { LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData } from "react-router";

import { authenticate } from "../shopify.server";
import { getMerchantSearchClusters } from "../services/search/search-analytics.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const requestedDays = Number.parseInt(
    url.searchParams.get("days") || "30",
    10,
  );
  const days = Number.isSafeInteger(requestedDays)
    ? Math.max(1, Math.min(requestedDays, 365))
    : 30;
  const view =
    url.searchParams.get("view") === "abnormal" ? "abnormal" : "healthy";

  return {
    days,
    view,
    clusters: await getMerchantSearchClusters(session.shop, days),
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
    case "RESULTS_WITHOUT_CLICKS":
      return "Có kết quả, chưa có click";
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
              "Lớp query",
              "Biến thể",
              "Search",
              "Không kết quả",
              "Result rate",
              "Clicks",
              "CTR",
              "Top score TB",
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
              cluster.classification === "RESULTS_WITHOUT_CLICKS";
            const lowSimilarity = cluster.classification === "LOW_SIMILARITY";
            const cell = { padding: 8, borderBottom: "1px solid #eee" };

            return (
              <tr key={`${cluster.label}-${index}`}>
                <td style={cell}>{cluster.label}</td>
                <td style={{ ...cell, minWidth: 220 }}>
                  {cluster.variants
                    .map(
                      (variant) => `${variant.query} (${variant.searchCount})`,
                    )
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
                  {cluster.clickCount}
                </td>
                <td style={{ ...cell, ...(noClicks ? dangerCell : {}) }}>
                  {percentage(cluster.clickThroughRate)}
                </td>
                <td style={{ ...cell, ...(lowSimilarity ? dangerCell : {}) }}>
                  {score(cluster.averageTopScore)}
                </td>
                <td
                  style={{
                    ...cell,
                    minWidth: 190,
                    ...(abnormal ? dangerCell : {}),
                  }}
                >
                  {classificationLabel(cluster.classification)}
                </td>
                <td style={{ ...cell, minWidth: 260 }}>
                  {cluster.commonProducts.length
                    ? cluster.commonProducts
                        .map(
                          (product) =>
                            `${product.handle} (${product.clickCount} click, #${product.averageRank.toFixed(1)})`,
                        )
                        .join(", ")
                    : "—"}
                </td>
              </tr>
            );
          })}
          {clusters.length === 0 ? (
            <tr>
              <td colSpan={10} style={{ padding: 16 }}>
                Chưa có lớp search thuộc nhóm này trong khoảng thời gian đã
                chọn.
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
        ? right.searchCount - left.searchCount
        : right.clickCount - left.clickCount ||
          right.searchCount - left.searchCount,
    );

  return (
    <s-page heading="Search Analytics">
      <s-section heading={`Phân tích ${data.days} ngày gần nhất`}>
        <s-text>
          Query được gom theo độ tương đồng của danh sách product ID đã xếp
          hạng. Mỗi search chỉ được ghi một lần, không phụ thuộc số trang.
        </s-text>
        <div
          style={{
            display: "flex",
            gap: 8,
            marginTop: 16,
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
            Search hoạt động tốt
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
            Search bất thường
          </Link>
        </div>
        <AnalyticsTable clusters={visibleClusters} abnormal={abnormal} />
      </s-section>
    </s-page>
  );
}
