import db from "../../db.server";

type SearchImpactLogRow = {
  id: string;
  query: string;
  normalizedQuery: string;
  resultCount: number;
  topScore: number | null;
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

  const lowScore = envNumber("AI_SEARCH_QUALITY_LOW_SCORE", 0.35);
  const highScore = envNumber("AI_SEARCH_QUALITY_HIGH_SCORE", 0.65);
  const noClickGraceMinutes = envNumber(
    "AI_SEARCH_QUALITY_NO_CLICK_GRACE_MINUTES",
    30,
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
      createdAt: true,
      clicks: {
        select: {
          rank: true,
          createdAt: true,
        },
      },
    },
  });

  const seriesMap = new Map<
    string,
    { searches: number; clickedSearches: number }
  >();

  for (let offset = 0; offset < windowDays; offset += 1) {
    const date = new Date(windowStart);
    date.setUTCDate(windowStart.getUTCDate() + offset);
    seriesMap.set(dayKey(date), { searches: 0, clickedSearches: 0 });
  }

  let clickedSearches = 0;
  let clickCount = 0;
  let clickedRankSum = 0;

  const anomalies = new Map<
    string,
    {
      type: Exclude<SearchImpactAlertType, "CTR_DROP">;
      query: string;
      count: number;
      scoreSum: number;
      scoreCount: number;
    }
  >();

  const addAnomaly = (
    type: Exclude<SearchImpactAlertType, "CTR_DROP">,
    query: string,
    score: number | null,
  ) => {
    const normalized = query.trim().toLocaleLowerCase("en-US") || "(empty)";
    const key = `${type}\u0000${normalized}`;
    const current = anomalies.get(key) ?? {
      type,
      query,
      count: 0,
      scoreSum: 0,
      scoreCount: 0,
    };
    current.count += 1;
    if (typeof score === "number" && Number.isFinite(score)) {
      current.scoreSum += score;
      current.scoreCount += 1;
    }
    anomalies.set(key, current);
  };

  for (const log of logs) {
    const key = dayKey(log.createdAt);
    const bucket = seriesMap.get(key);
    if (bucket) {
      bucket.searches += 1;
      if (log.clicks.length > 0) bucket.clickedSearches += 1;
    }

    if (log.clicks.length > 0) {
      clickedSearches += 1;
      clickCount += log.clicks.length;
      clickedRankSum += log.clicks.reduce((sum: number, click: SearchImpactLogRow["clicks"][number]) => sum + click.rank, 0);
    }

    const displayQuery = log.query || log.normalizedQuery || "(unknown query)";

    if (log.resultCount <= 0) {
      addAnomaly("NO_RESULTS", displayQuery, log.topScore);
      continue;
    }

    if (typeof log.topScore === "number" && log.topScore < lowScore) {
      addAnomaly("LOW_SIMILARITY", displayQuery, log.topScore);
    }

    if (
      typeof log.topScore === "number" &&
      log.topScore >= highScore &&
      log.clicks.length === 0 &&
      log.createdAt <= graceCutoff
    ) {
      addAnomaly("HIGH_SIMILARITY_NO_CLICK", displayQuery, log.topScore);
    }
  }

  const series = Array.from(seriesMap.entries()).map(([date, value]) => ({
    date,
    searches: value.searches,
    clickedSearches: value.clickedSearches,
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

  const alerts: SearchImpactAlert[] = Array.from(anomalies.values())
    .filter((item) => item.count >= 3)
    .sort((a, b) => b.count - a.count)
    .slice(0, 6)
    .map((item) => {
      const avgScore =
        item.scoreCount > 0 ? item.scoreSum / item.scoreCount : null;

      if (item.type === "NO_RESULTS") {
        return {
          type: item.type,
          severity: severityFor(item.count),
          query: item.query,
          count: item.count,
          detail: `Không có kết quả hợp lệ trong ${item.count} lượt search.`,
        };
      }

      if (item.type === "LOW_SIMILARITY") {
        return {
          type: item.type,
          severity: severityFor(item.count),
          query: item.query,
          count: item.count,
          detail:
            avgScore == null
              ? "Kết quả có độ tương đồng thấp."
              : `Top similarity trung bình ${avgScore.toFixed(2)}.`,
        };
      }

      return {
        type: item.type,
        severity: severityFor(item.count),
        query: item.query,
        count: item.count,
        detail:
          avgScore == null
            ? "Kết quả có điểm cao nhưng không tạo click."
            : `Top similarity trung bình ${avgScore.toFixed(2)} nhưng không có click.`,
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
    noResults: logs.filter((log: SearchImpactLogRow) => log.resultCount <= 0).length,
    lowSimilarity: logs.filter(
      (log: SearchImpactLogRow) => typeof log.topScore === "number" && log.topScore < lowScore,
    ).length,
    highSimilarityNoClick: logs.filter(
      (log: SearchImpactLogRow) =>
        typeof log.topScore === "number" &&
        log.topScore >= highScore &&
        log.clicks.length === 0 &&
        log.createdAt <= graceCutoff,
    ).length,
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
        "Không có dữ liệu native trước khi app được cài. Dashboard không bịa baseline.",
    },
    series,
    alerts: alerts.slice(0, 6),
    anomalyCounts,
  };
}
