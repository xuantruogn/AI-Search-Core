import { getDailySearchMetrics, sumSearchMetrics } from "./search-metrics.server";
import { getMerchantSearchClusters } from "./search-analytics.server";

export type SearchImpactPoint = {
  date: string;
  searches: number;
  clickedSearches: number;
  abnormalSearches: number;
  ctr: number | null;
};

export type SearchImpactAlertType =
  | "SEMANTIC_NO_RESULTS"
  | "LOW_CTR"
  | "CTR_DROP";

export type SearchImpactAlert = {
  type: SearchImpactAlertType;
  severity: "HIGH" | "MEDIUM";
  query: string | null;
  count: number;
  detail: string;
};

export type SearchImpactSnapshot = {
  coverage: { detailSampled: boolean; clusterSampled: boolean; sampledSearches: number; totalLoggedSearches: number };
  windowDays: number;
  generatedAt: string;
  ai: {
    searches: number;
    clickedSearches: number;
    ctr: number | null;
    clicks: number;
    avgClickedRank: number | null;
  };
  comparison: {
    current7dCtr: number | null;
    previous7dCtr: number | null;
    deltaPercentagePoints: number | null;
    deltaRelativePercent: number | null;
  };
  nativeBaseline: {
    available: false;
    ctr: null;
    searches: 0;
    clickedSearches: 0;
    note: string;
  };
  series: SearchImpactPoint[];
  alerts: SearchImpactAlert[];
  anomalyCounts: {
    semanticNoResults: number;
    lowCtr: number;
  };
};


function dayKey(date: Date) {
  return date.toISOString().slice(0, 10);
}

function safeCtr(clicked: number, total: number) {
  return total > 0 ? (clicked / total) * 100 : null;
}

function round1(value: number | null) {
  return value == null ? null : Math.round(value * 10) / 10;
}

function severityFor(count: number): "HIGH" | "MEDIUM" {
  return count >= 10 ? "HIGH" : "MEDIUM";
}

export async function getSearchImpactSnapshot(
  shop: string,
  options: { windowDays?: number } = {},
): Promise<SearchImpactSnapshot> {
  const windowDays = Math.max(7, Math.min(90, options.windowDays ?? 30));
  const now = new Date();
  const windowStart = new Date(now);
  windowStart.setUTCDate(windowStart.getUTCDate() - (windowDays - 1));
  windowStart.setUTCHours(0, 0, 0, 0);

  const dailyMetrics = await getDailySearchMetrics(shop, windowStart, now);
  const totals = sumSearchMetrics(dailyMetrics);

  const clusters = await getMerchantSearchClusters(shop, windowDays, { from: windowStart, to: now });

  const seriesMap = new Map<
    string,
    { searches: number; clickedSearches: number; abnormalSearches: number }
  >();

  for (let offset = 0; offset < windowDays; offset += 1) {
    const date = new Date(windowStart);
    date.setUTCDate(windowStart.getUTCDate() + offset);
    seriesMap.set(dayKey(date), {
      searches: 0,
      clickedSearches: 0,
      abnormalSearches: 0,
    });
  }

  for (const cluster of clusters) {
    for (const daily of cluster.daily) {
      const bucket = seriesMap.get(daily.date);
      if (bucket) bucket.abnormalSearches += cluster.classification === "LOW_CTR" ? daily.searches : cluster.classification === "SEMANTIC_NO_RESULTS" ? daily.zeroResults : 0;
    }
  }

  const series = Array.from(seriesMap.entries()).map(([date, value]) => ({
    date,
    searches: dailyMetrics.find((metric) => metric.date === date)?.searches ?? 0,
    clickedSearches: dailyMetrics.find((metric) => metric.date === date)?.clickedSearches ?? 0,
    abnormalSearches: value.abnormalSearches,
    ctr: round1(safeCtr(dailyMetrics.find((metric) => metric.date === date)?.clickedSearches ?? 0, dailyMetrics.find((metric) => metric.date === date)?.searches ?? 0)),
  }));

  const cutoffCurrent7d = new Date(now);
  cutoffCurrent7d.setUTCDate(cutoffCurrent7d.getUTCDate() - 6);
  cutoffCurrent7d.setUTCHours(0, 0, 0, 0);

  const cutoffPrevious7d = new Date(cutoffCurrent7d);
  cutoffPrevious7d.setUTCDate(cutoffPrevious7d.getUTCDate() - 7);

  const comparisonMetrics = windowStart > cutoffPrevious7d ? await getDailySearchMetrics(shop, cutoffPrevious7d, now) : dailyMetrics;
  const current7d = sumSearchMetrics(comparisonMetrics.filter((row) => row.date >= dayKey(cutoffCurrent7d)));
  const previous7d = sumSearchMetrics(comparisonMetrics.filter((row) => row.date >= dayKey(cutoffPrevious7d) && row.date < dayKey(cutoffCurrent7d)));
  const current7dCtr = safeCtr(current7d.clickedSearches, current7d.searches);
  const previous7dCtr = safeCtr(previous7d.clickedSearches, previous7d.searches);

  const deltaPercentagePoints =
    current7dCtr != null && previous7dCtr != null
      ? current7dCtr - previous7dCtr
      : null;

  const deltaRelativePercent =
    current7dCtr != null && previous7dCtr != null && previous7dCtr > 0
      ? ((current7dCtr - previous7dCtr) / previous7dCtr) * 100
      : null;

  const alerts: SearchImpactAlert[] = clusters
    .filter((cluster) => cluster.classification !== "HEALTHY")
    .sort((a, b) => b.searchCount - a.searchCount)
    .slice(0, 6)
    .map((cluster) => {
      if (cluster.classification === "SEMANTIC_NO_RESULTS") {
        return {
          type: "SEMANTIC_NO_RESULTS" as const,
          severity: severityFor(cluster.semanticFacetNoResultCount),
          query: cluster.label,
          count: cluster.semanticFacetNoResultCount,
          detail:
            "No sufficiently relevant products were found for this query.",
        };
      }

      return {
        type: "LOW_CTR" as const,
        severity: severityFor(cluster.searchCount),
        query: cluster.label,
        count: cluster.searchCount,
        detail:
          `Query class có ${cluster.searchCount} lượt search, CTR ${(cluster.clickThroughRate * 100).toFixed(1)}% (<5%).`,
      };
    });

  if (
    current7d.searches >= 30 &&
    previous7d.searches >= 30 &&
    deltaRelativePercent != null &&
    deltaRelativePercent <= -20
  ) {
    alerts.unshift({
      type: "CTR_DROP",
      severity: "HIGH",
      query: null,
      count: current7d.searches,
      detail: `CTR 7 ngày gần nhất giảm ${Math.abs(
        round1(deltaRelativePercent) ?? 0,
      )}% so với 7 ngày trước.`,
    });
  }

  const anomalyCounts = {
    semanticNoResults: clusters
      .filter((cluster) => cluster.classification === "SEMANTIC_NO_RESULTS")
      .reduce((sum, cluster) => sum + cluster.semanticFacetNoResultCount, 0),
    lowCtr: clusters
      .filter((cluster) => cluster.classification === "LOW_CTR")
      .reduce((sum, cluster) => sum + cluster.searchCount, 0),
  };

  return {
    windowDays,
    coverage: { detailSampled: false, clusterSampled: false, sampledSearches: totals.searches, totalLoggedSearches: totals.searches },
    generatedAt: now.toISOString(),
    ai: {
      searches: totals.searches,
      clickedSearches: totals.clickedSearches,
      ctr: round1(safeCtr(totals.clickedSearches, totals.searches)),
      clicks: totals.clicks,
      avgClickedRank:
        totals.clicks > 0 ? Math.round((totals.rankTotal / totals.clicks) * 10) / 10 : null,
    },
    comparison: {
      current7dCtr: round1(current7dCtr),
      previous7dCtr: round1(previous7dCtr),
      deltaPercentagePoints: round1(deltaPercentagePoints),
      deltaRelativePercent: round1(deltaRelativePercent),
    },
    nativeBaseline: {
      available: false,
      ctr: null,
      searches: 0,
      clickedSearches: 0,
      note:
        "Không có dữ liệu native trước khi app được cài. Dashboard không thể hiển thị baseline.",
    },
    series,
    alerts: alerts.slice(0, 6),
    anomalyCounts,
  };
}
