import db from "../../db.server";
import { getMerchantSearchClusters } from "./search-analytics.server";

type SearchImpactLogRow = {
  id: string;
  query: string;
  normalizedQuery: string;
  resultCount: number;
  topScore: number | null;
  topCandidateScore: number | null;
  vectorThreshold: number;
  createdAt: Date;
  clicks: Array<{
    rank: number;
    createdAt: Date;
  }>;
};

export type SearchImpactPoint = {
  date: string;
  searches: number;
  clickedSearches: number;
  abnormalSearches: number;
  ctr: number | null;
};

export type SearchImpactAlertType =
  | "NO_RESULTS"
  | "LOW_SIMILARITY"
  | "HIGH_SIMILARITY_NO_CLICK"
  | "CTR_DROP";

export type SearchImpactAlert = {
  type: SearchImpactAlertType;
  severity: "HIGH" | "MEDIUM";
  query: string | null;
  count: number;
  detail: string;
};

export type SearchImpactSnapshot = {
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
    noResults: number;
    lowSimilarity: number;
    highSimilarityNoClick: number;
  };
};

const LOW_SIMILARITY_MARGIN = 0.03;
const HIGH_SIMILARITY_MARGIN = 0.08;
const DEFAULT_NO_CLICK_GRACE_MINUTES = 30;

function envNumber(name: string, fallback: number) {
  const value = Number.parseFloat(process.env[name] ?? "");
  return Number.isFinite(value) ? value : fallback;
}

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
  const windowDays = Math.max(14, Math.min(90, options.windowDays ?? 30));
  const now = new Date();
  const windowStart = new Date(now);
  windowStart.setUTCDate(windowStart.getUTCDate() - (windowDays - 1));
  windowStart.setUTCHours(0, 0, 0, 0);

  const noClickGraceMinutes = Math.max(
    0,
    envNumber(
      "AI_SEARCH_QUALITY_NO_CLICK_GRACE_MINUTES",
      DEFAULT_NO_CLICK_GRACE_MINUTES,
    ),
  );
  const graceCutoff = new Date(now.getTime() - noClickGraceMinutes * 60_000);

  const logs: SearchImpactLogRow[] = await db.aiSearchQueryLog.findMany({
    where: {
      shop,
      createdAt: { gte: windowStart },
    },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      query: true,
      normalizedQuery: true,
      resultCount: true,
      topScore: true,
      topCandidateScore: true,
      vectorThreshold: true,
      createdAt: true,
      clicks: {
        select: {
          rank: true,
          createdAt: true,
        },
      },
    },
  });

  const clusters = await getMerchantSearchClusters(shop, windowDays);

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

  let clickedSearches = 0;
  let clickCount = 0;
  let clickedRankSum = 0;


  for (const log of logs) {
    const comparisonScore = log.topScore ?? log.topCandidateScore;
    const noResults = log.resultCount <= 0;
    const lowSimilarity =
      !noResults &&
      comparisonScore !== null &&
      comparisonScore < log.vectorThreshold + LOW_SIMILARITY_MARGIN;
    const highSimilarityNoClick =
      !noResults &&
      comparisonScore !== null &&
      comparisonScore >= log.vectorThreshold + HIGH_SIMILARITY_MARGIN &&
      log.clicks.length === 0 &&
      log.createdAt <= graceCutoff;
    const abnormalSearch =
      noResults || lowSimilarity || highSimilarityNoClick;

    const key = dayKey(log.createdAt);
    const bucket = seriesMap.get(key);
    if (bucket) {
      bucket.searches += 1;
      if (log.clicks.length > 0) bucket.clickedSearches += 1;
      if (abnormalSearch) bucket.abnormalSearches += 1;
    }

    if (log.clicks.length > 0) {
      clickedSearches += 1;
      clickCount += log.clicks.length;
      clickedRankSum += log.clicks.reduce((sum: number, click: SearchImpactLogRow["clicks"][number]) => sum + click.rank, 0);
    }

  }

  const series = Array.from(seriesMap.entries()).map(([date, value]) => ({
    date,
    searches: value.searches,
    clickedSearches: value.clickedSearches,
    abnormalSearches: value.abnormalSearches,
    ctr: round1(safeCtr(value.clickedSearches, value.searches)),
  }));

  const cutoffCurrent7d = new Date(now);
  cutoffCurrent7d.setUTCDate(cutoffCurrent7d.getUTCDate() - 6);
  cutoffCurrent7d.setUTCHours(0, 0, 0, 0);

  const cutoffPrevious7d = new Date(cutoffCurrent7d);
  cutoffPrevious7d.setUTCDate(cutoffPrevious7d.getUTCDate() - 7);

  const current7d = logs.filter((log: SearchImpactLogRow) => log.createdAt >= cutoffCurrent7d);
  const previous7d = logs.filter(
    (log: SearchImpactLogRow) =>
      log.createdAt >= cutoffPrevious7d && log.createdAt < cutoffCurrent7d,
  );

  const current7dClicked = current7d.filter((log: SearchImpactLogRow) => log.clicks.length > 0).length;
  const previous7dClicked = previous7d.filter((log: SearchImpactLogRow) => log.clicks.length > 0).length;
  const current7dCtr = safeCtr(current7dClicked, current7d.length);
  const previous7dCtr = safeCtr(previous7dClicked, previous7d.length);

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
      if (cluster.classification === "NO_RESULTS") {
        return {
          type: "NO_RESULTS" as const,
          severity: severityFor(cluster.searchCount),
          query: cluster.label,
          count: cluster.searchCount,
          detail: `Không có kết quả hợp lệ trong ${cluster.searchCount} lượt search cùng lớp.`,
        };
      }

      if (cluster.classification === "LOW_SIMILARITY") {
        return {
          type: "LOW_SIMILARITY" as const,
          severity: severityFor(cluster.searchCount),
          query: cluster.label,
          count: cluster.searchCount,
          detail:
            cluster.averageTopScore == null
              ? "Kết quả có độ tương đồng thấp."
              : `Top similarity trung bình ${cluster.averageTopScore.toFixed(2)} (threshold TB ${cluster.averageThreshold.toFixed(2)}).`,
        };
      }

      return {
        type: "HIGH_SIMILARITY_NO_CLICK" as const,
        severity: severityFor(cluster.searchCount),
        query: cluster.label,
        count: cluster.searchCount,
        detail:
          cluster.averageTopScore == null
            ? "Kết quả có độ tương đồng cao nhưng không tạo click sau thời gian chờ."
            : `Top similarity trung bình ${cluster.averageTopScore.toFixed(2)} nhưng không có click sau thời gian chờ.`,
      };
    });

  if (
    current7d.length >= 30 &&
    previous7d.length >= 30 &&
    deltaRelativePercent != null &&
    deltaRelativePercent <= -20
  ) {
    alerts.unshift({
      type: "CTR_DROP",
      severity: "HIGH",
      query: null,
      count: current7d.length,
      detail: `CTR 7 ngày gần nhất giảm ${Math.abs(
        round1(deltaRelativePercent) ?? 0,
      )}% so với 7 ngày trước.`,
    });
  }

  const anomalyCounts = {
    noResults: clusters
      .filter((cluster) => cluster.classification === "NO_RESULTS")
      .reduce((sum, cluster) => sum + cluster.searchCount, 0),
    lowSimilarity: clusters
      .filter((cluster) => cluster.classification === "LOW_SIMILARITY")
      .reduce((sum, cluster) => sum + cluster.searchCount, 0),
    highSimilarityNoClick: clusters
      .filter((cluster) => cluster.classification === "HIGH_SIMILARITY_NO_CLICK")
      .reduce((sum, cluster) => sum + cluster.searchCount, 0),
  };

  return {
    windowDays,
    generatedAt: now.toISOString(),
    ai: {
      searches: logs.length,
      clickedSearches,
      ctr: round1(safeCtr(clickedSearches, logs.length)),
      clicks: clickCount,
      avgClickedRank:
        clickCount > 0 ? Math.round((clickedRankSum / clickCount) * 10) / 10 : null,
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
