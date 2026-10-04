import db from "../../db.server";

function utcDayStart(value: Date) {
  const result = new Date(value);
  result.setUTCHours(0, 0, 0, 0);
  return result;
}

export async function compactApiUsageEvents({
  rawCutoff,
  dailyCutoff,
  rawBatchSize = 5_000,
  maxRawBatches = 20,
  deleteBatchSize = 5_000,
  maxDeleteBatches = 20,
}: {
  rawCutoff: Date;
  dailyCutoff: Date;
  rawBatchSize?: number;
  maxRawBatches?: number;
  deleteBatchSize?: number;
  maxDeleteBatches?: number;
}) {
  const safeRawCutoff = utcDayStart(rawCutoff);
  const safeRawBatchSize = Math.max(
    100,
    Math.min(Math.trunc(rawBatchSize), 50_000),
  );
  const safeMaxRawBatches = Math.max(
    1,
    Math.min(Math.trunc(maxRawBatches), 100),
  );
  const safeDeleteBatchSize = Math.max(
    100,
    Math.min(Math.trunc(deleteBatchSize), 50_000),
  );
  const safeMaxDeleteBatches = Math.max(
    1,
    Math.min(Math.trunc(maxDeleteBatches), 100),
  );

  let aggregated = 0;
  let aggregatedBatches = 0;
  let rawDeleted = 0;

  for (let batch = 0; batch < safeMaxRawBatches; batch += 1) {
    const ids = await db.$queryRaw<Array<{ id: number }>>`
      SELECT id
      FROM AiSearchApiUsageEvent
      WHERE createdAt < ${safeRawCutoff}
      ORDER BY id ASC
      LIMIT ${safeRawBatchSize}
    `;
    if (ids.length === 0) break;

    const maxId = ids[ids.length - 1].id;
    const result = await db.$transaction(async (tx) => {
      const aggregateStatements = await tx.$executeRaw`
        INSERT INTO AiSearchApiUsageDaily (
          day, shop, provider, operation, model,
          requestCount, inputTokens, cachedInputTokens,
          outputTokens, totalTokens, estimatedCostMicros,
          createdAt, updatedAt
        )
        SELECT
          DATE(createdAt) AS day,
          IFNULL(shop, '__UNSCOPED__') AS shop,
          provider, operation, model,
          COUNT(*) AS requestCount,
          COALESCE(SUM(inputTokens), 0),
          COALESCE(SUM(cachedInputTokens), 0),
          COALESCE(SUM(outputTokens), 0),
          COALESCE(SUM(totalTokens), 0),
          COALESCE(SUM(estimatedCostMicros), 0),
          UTC_TIMESTAMP(3),
          UTC_TIMESTAMP(3)
        FROM AiSearchApiUsageEvent
        WHERE
          id <= ${maxId}
          AND createdAt < ${safeRawCutoff}
        GROUP BY
          DATE(createdAt),
          IFNULL(shop, '__UNSCOPED__'),
          provider, operation, model
        ON DUPLICATE KEY UPDATE
          requestCount = requestCount + VALUES(requestCount),
          inputTokens = inputTokens + VALUES(inputTokens),
          cachedInputTokens = cachedInputTokens + VALUES(cachedInputTokens),
          outputTokens = outputTokens + VALUES(outputTokens),
          totalTokens = totalTokens + VALUES(totalTokens),
          estimatedCostMicros =
            estimatedCostMicros + VALUES(estimatedCostMicros),
          updatedAt = UTC_TIMESTAMP(3)
      `;
      const deleted = await tx.$executeRaw`
        DELETE FROM AiSearchApiUsageEvent
        WHERE
          id <= ${maxId}
          AND createdAt < ${safeRawCutoff}
      `;
      return { aggregateStatements, deleted };
    });

    aggregated += result.aggregateStatements;
    rawDeleted += result.deleted;
    aggregatedBatches += 1;
    if (ids.length < safeRawBatchSize) break;
  }

  let dailyDeleted = 0;
  for (let batch = 0; batch < safeMaxDeleteBatches; batch += 1) {
    const deleted = await db.$executeRaw`
      DELETE FROM AiSearchApiUsageDaily
      WHERE day < DATE(${dailyCutoff})
      LIMIT ${safeDeleteBatchSize}
    `;
    dailyDeleted += deleted;
    if (deleted < safeDeleteBatchSize) break;
  }

  return {
    aggregated,
    aggregatedBatches,
    rawDeleted,
    dailyDeleted,
  };
}
