import { createHash, createHmac, randomUUID } from "node:crypto";

import db from "../../db.server";
import { getProductVectorForShop } from "../search/vector-store.server";
import type { SubscriptionSnapshot, UsageSnapshot } from "./types.server";

type UsageRow = {
  id: number;
  shop: string;
  periodKey: string;
  periodStart: Date | string;
  periodEnd: Date | string;
  searchCount: number;
  vectorUpdateCount: number;
  productIndexCount: number;
  productDeleteCount: number;
  queryEmbeddingCount: number;
  productEmbeddingCount: number;
  fallbackCount: number;
  blockedSearchCount: number;
  blockedVectorCount: number;
};

export const USAGE_RESERVATION_STATUS = {
  pending: "PENDING",
  committed: "COMMITTED",
  rolledBack: "ROLLED_BACK",
} as const;

export type UsageReservationKind =
  "SEARCH" | "VECTOR_UPDATE" | "PRODUCT_EMBEDDING";

export type UsageReservation = {
  id: string;
  shop: string;
  periodId: number;
  kind: UsageReservationKind;
  queryHash?: string;
  productId?: string;
  countsVectorUpdate: boolean;
};

type UsageReservationRow = {
  id: string;
  shop: string;
  periodId: number;
  kind: string;
  status: string;
  countsVectorUpdate: boolean | number;
  productId: string | null;
  queryHash: string | null;
  embeddingConsumedAt: Date | string | null;
  effectAppliedAt: Date | string | null;
  resolvedAt: Date | string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
};

function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function monthWindow(now = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
  );

  return { start, end };
}

export function resolveUsageWindow(subscription: SubscriptionSnapshot) {
  if (
    subscription.billingPeriodStart &&
    subscription.billingPeriodEnd &&
    subscription.billingPeriodEnd > subscription.billingPeriodStart
  ) {
    return {
      start: subscription.billingPeriodStart,
      end: subscription.billingPeriodEnd,
    };
  }

  return monthWindow();
}

function buildPeriodKey(start: Date, end: Date) {
  return `${start.toISOString()}__${end.toISOString()}`;
}

function mapUsage(row: UsageRow): UsageSnapshot {
  return {
    id: row.id,
    shop: row.shop,
    periodKey: row.periodKey,
    periodStart: asDate(row.periodStart),
    periodEnd: asDate(row.periodEnd),
    searchCount: row.searchCount,
    vectorUpdateCount: row.vectorUpdateCount,
    productIndexCount: row.productIndexCount,
    productDeleteCount: row.productDeleteCount,
    queryEmbeddingCount: row.queryEmbeddingCount,
    productEmbeddingCount: row.productEmbeddingCount,
    fallbackCount: row.fallbackCount,
    blockedSearchCount: row.blockedSearchCount,
    blockedVectorCount: row.blockedVectorCount,
  };
}

function mapReservation(row: UsageReservationRow): UsageReservation {
  const kind: UsageReservationKind =
    row.kind === "VECTOR_UPDATE"
      ? "VECTOR_UPDATE"
      : row.kind === "PRODUCT_EMBEDDING"
        ? "PRODUCT_EMBEDDING"
        : "SEARCH";

  return {
    id: row.id,
    shop: row.shop,
    periodId: row.periodId,
    kind,
    queryHash: row.queryHash ?? undefined,
    productId: row.productId ?? undefined,
    countsVectorUpdate: Boolean(row.countsVectorUpdate),
  };
}

export async function ensureUsagePeriod({
  shop,
  subscription,
}: {
  shop: string;
  subscription: SubscriptionSnapshot;
}): Promise<UsageSnapshot> {
  const { start, end } = resolveUsageWindow(subscription);
  const periodKey = buildPeriodKey(start, end);

  await db.$executeRaw`
    INSERT OR IGNORE INTO "AiSearchUsagePeriod" (
      "shop", "periodKey", "periodStart", "periodEnd", "createdAt", "updatedAt"
    ) VALUES (
      ${shop}, ${periodKey}, ${start}, ${end}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    )
  `;

  const rows = await db.$queryRaw<UsageRow[]>`
    SELECT
      "id", "shop", "periodKey", "periodStart", "periodEnd",
      "searchCount", "vectorUpdateCount", "productIndexCount", "productDeleteCount",
      "queryEmbeddingCount", "productEmbeddingCount", "fallbackCount",
      "blockedSearchCount", "blockedVectorCount"
    FROM "AiSearchUsagePeriod"
    WHERE "shop" = ${shop} AND "periodKey" = ${periodKey}
    LIMIT 1
  `;

  if (!rows[0]) {
    throw new Error(`Unable to create AI Search usage period for ${shop}`);
  }

  return mapUsage(rows[0]);
}

export async function getUsagePeriodById(periodId: number) {
  const rows = await db.$queryRaw<UsageRow[]>`
    SELECT
      "id", "shop", "periodKey", "periodStart", "periodEnd",
      "searchCount", "vectorUpdateCount", "productIndexCount", "productDeleteCount",
      "queryEmbeddingCount", "productEmbeddingCount", "fallbackCount",
      "blockedSearchCount", "blockedVectorCount"
    FROM "AiSearchUsagePeriod"
    WHERE "id" = ${periodId}
    LIMIT 1
  `;

  return rows[0] ? mapUsage(rows[0]) : null;
}

export function hashSearchQuery(query: string) {
  const normalized = query.trim().toLowerCase();
  const key =
    process.env.AI_SEARCH_QUERY_HASH_KEY?.trim() ||
    process.env.SHOPIFY_API_SECRET?.trim();

  // Production analytics use a keyed digest so common search terms cannot be
  // recovered by comparing a dictionary of plain SHA-256 values.
  return key
    ? createHmac("sha256", key).update(normalized, "utf8").digest("hex")
    : createHash("sha256").update(normalized, "utf8").digest("hex");
}

function metadataJson(metadata: Record<string, unknown> | undefined) {
  if (!metadata) return null;

  const serialized = JSON.stringify(metadata);
  if (serialized.length <= 8_000) return serialized;

  return JSON.stringify({
    truncated: true,
    originalLength: serialized.length,
    preview: serialized.slice(0, 7_500),
  });
}

async function insertUsageEvent({
  shop,
  periodId,
  type,
  quantity = 1,
  success,
  productId,
  queryHash,
  jobId,
  metadata,
}: {
  shop: string;
  periodId: number | null;
  type: string;
  quantity?: number;
  success: boolean;
  productId?: string | null;
  queryHash?: string | null;
  jobId?: number | null;
  metadata?: Record<string, unknown>;
}) {
  const json = metadataJson(metadata);

  await db.$executeRaw`
    INSERT INTO "AiSearchUsageEvent" (
      "shop", "periodId", "type", "quantity", "success", "productId",
      "queryHash", "jobId", "metadataJson", "createdAt"
    ) VALUES (
      ${shop}, ${periodId}, ${type}, ${quantity}, ${success}, ${productId ?? null},
      ${queryHash ?? null}, ${jobId ?? null}, ${json}, CURRENT_TIMESTAMP
    )
  `;
}

async function reservationStatus(id: string) {
  const rows = await db.$queryRaw<UsageReservationRow[]>`
    SELECT
      "id", "shop", "periodId", "kind", "status", "countsVectorUpdate",
      "productId", "queryHash", "embeddingConsumedAt", "effectAppliedAt",
      "resolvedAt", "createdAt", "updatedAt"
    FROM "AiSearchUsageReservation"
    WHERE "id" = ${id}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

function reservationKindMatches(
  row: UsageReservationRow | null,
  expected: UsageReservationKind | "PRODUCT",
) {
  if (!row) return false;
  if (expected === "PRODUCT") {
    return row.kind === "VECTOR_UPDATE" || row.kind === "PRODUCT_EMBEDDING";
  }
  return row.kind === expected;
}

export async function reserveSearchUsage({
  shop,
  periodId,
  searchLimit,
  query,
}: {
  shop: string;
  periodId: number;
  searchLimit: number | null;
  query: string;
}): Promise<
  { allowed: true; reservation: UsageReservation } | { allowed: false }
> {
  const id = randomUUID();
  const queryHash = hashSearchQuery(query);

  const allowed = await db.$transaction(async (tx) => {
    const updated =
      searchLimit === null
        ? await tx.$executeRaw`
            UPDATE "AiSearchUsagePeriod"
            SET "searchCount" = "searchCount" + 1, "updatedAt" = CURRENT_TIMESTAMP
            WHERE "id" = ${periodId} AND "shop" = ${shop}
          `
        : await tx.$executeRaw`
            UPDATE "AiSearchUsagePeriod"
            SET "searchCount" = "searchCount" + 1, "updatedAt" = CURRENT_TIMESTAMP
            WHERE
              "id" = ${periodId}
              AND "shop" = ${shop}
              AND "searchCount" < ${searchLimit}
          `;

    if (updated !== 1) {
      await tx.$executeRaw`
        UPDATE "AiSearchUsagePeriod"
        SET "blockedSearchCount" = "blockedSearchCount" + 1, "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = ${periodId} AND "shop" = ${shop}
      `;
      return false;
    }

    await tx.$executeRaw`
      INSERT INTO "AiSearchUsageReservation" (
        "id", "shop", "periodId", "kind", "status", "countsVectorUpdate",
        "queryHash", "createdAt", "updatedAt"
      ) VALUES (
        ${id}, ${shop}, ${periodId}, 'SEARCH', 'PENDING', false,
        ${queryHash}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      )
    `;

    return true;
  });

  if (!allowed) {
    await insertUsageEvent({
      shop,
      periodId,
      type: "SEARCH_BLOCKED",
      success: false,
      queryHash,
      metadata: { reason: "SEARCH_QUOTA_EXCEEDED", limit: searchLimit },
    });
    return { allowed: false };
  }

  return {
    allowed: true,
    reservation: {
      id,
      shop,
      periodId,
      kind: "SEARCH",
      queryHash,
      countsVectorUpdate: false,
    },
  };
}

export async function reserveProductEmbeddingUsage({
  shop,
  periodId,
  vectorUpdateLimit,
  productId,
  countAsVectorUpdate,
}: {
  shop: string;
  periodId: number;
  vectorUpdateLimit: number | null;
  productId: string;
  countAsVectorUpdate: boolean;
}): Promise<
  { allowed: true; reservation: UsageReservation } | { allowed: false }
> {
  const id = randomUUID();
  const kind: UsageReservationKind = countAsVectorUpdate
    ? "VECTOR_UPDATE"
    : "PRODUCT_EMBEDDING";

  const allowed = await db.$transaction(async (tx) => {
    let updated = 0;

    if (!countAsVectorUpdate) {
      const rows = await tx.$queryRaw<Array<{ id: number }>>`
        SELECT "id"
        FROM "AiSearchUsagePeriod"
        WHERE "id" = ${periodId} AND "shop" = ${shop}
        LIMIT 1
      `;
      updated = rows[0]?.id === periodId ? 1 : 0;
    } else if (vectorUpdateLimit === null) {
      updated = await tx.$executeRaw`
        UPDATE "AiSearchUsagePeriod"
        SET "vectorUpdateCount" = "vectorUpdateCount" + 1, "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = ${periodId} AND "shop" = ${shop}
      `;
    } else {
      updated = await tx.$executeRaw`
        UPDATE "AiSearchUsagePeriod"
        SET "vectorUpdateCount" = "vectorUpdateCount" + 1, "updatedAt" = CURRENT_TIMESTAMP
        WHERE
          "id" = ${periodId}
          AND "shop" = ${shop}
          AND "vectorUpdateCount" < ${vectorUpdateLimit}
      `;
    }

    if (updated !== 1) {
      await tx.$executeRaw`
        UPDATE "AiSearchUsagePeriod"
        SET "blockedVectorCount" = "blockedVectorCount" + 1, "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = ${periodId} AND "shop" = ${shop}
      `;
      return false;
    }

    await tx.$executeRaw`
      INSERT INTO "AiSearchUsageReservation" (
        "id", "shop", "periodId", "kind", "status", "countsVectorUpdate",
        "productId", "createdAt", "updatedAt"
      ) VALUES (
        ${id}, ${shop}, ${periodId}, ${kind}, 'PENDING', ${countAsVectorUpdate},
        ${productId}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      )
    `;

    return true;
  });

  if (!allowed) {
    await insertUsageEvent({
      shop,
      periodId,
      type: "VECTOR_UPDATE_BLOCKED",
      success: false,
      productId,
      metadata: {
        reason: "VECTOR_UPDATE_QUOTA_EXCEEDED",
        limit: vectorUpdateLimit,
      },
    });
    return { allowed: false };
  }

  return {
    allowed: true,
    reservation: {
      id,
      shop,
      periodId,
      kind,
      productId,
      countsVectorUpdate: countAsVectorUpdate,
    },
  };
}

export async function recordQueryEmbeddingConsumed(
  reservation: UsageReservation,
) {
  await recordEmbeddingConsumed(reservation, "queryEmbeddingCount", "SEARCH");
}

export async function recordProductEmbeddingConsumed(
  reservation: UsageReservation,
) {
  await recordEmbeddingConsumed(
    reservation,
    "productEmbeddingCount",
    "PRODUCT",
  );
}

async function recordEmbeddingConsumed(
  reservation: UsageReservation,
  counter: "queryEmbeddingCount" | "productEmbeddingCount",
  expectedKind: UsageReservationKind | "PRODUCT",
) {
  const current = await reservationStatus(reservation.id);
  if (!reservationKindMatches(current, expectedKind)) {
    throw new Error(
      `Usage reservation kind mismatch: ${reservation.id}/${current?.kind ?? "missing"}`,
    );
  }

  const changed = await db.$transaction(async (tx) => {
    const reservationUpdated = await tx.$executeRaw`
      UPDATE "AiSearchUsageReservation"
      SET "embeddingConsumedAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP
      WHERE
        "id" = ${reservation.id}
        AND "shop" = ${reservation.shop}
        AND "periodId" = ${reservation.periodId}
        AND "status" = 'PENDING'
        AND "embeddingConsumedAt" IS NULL
    `;

    if (reservationUpdated !== 1) return false;

    const usageUpdated =
      counter === "queryEmbeddingCount"
        ? await tx.$executeRaw`
            UPDATE "AiSearchUsagePeriod"
            SET "queryEmbeddingCount" = "queryEmbeddingCount" + 1, "updatedAt" = CURRENT_TIMESTAMP
            WHERE "id" = ${reservation.periodId} AND "shop" = ${reservation.shop}
          `
        : await tx.$executeRaw`
            UPDATE "AiSearchUsagePeriod"
            SET "productEmbeddingCount" = "productEmbeddingCount" + 1, "updatedAt" = CURRENT_TIMESTAMP
            WHERE "id" = ${reservation.periodId} AND "shop" = ${reservation.shop}
          `;

    if (usageUpdated !== 1) {
      throw new Error(
        `Unable to record embedding usage for ${reservation.shop}/${reservation.periodId}`,
      );
    }

    return true;
  });

  if (changed) return;

  const row = await reservationStatus(reservation.id);
  if (row?.embeddingConsumedAt) return;

  throw new Error(`Usage reservation is not pending: ${reservation.id}`);
}

export async function markUsageReservationEffectApplied(
  reservation: UsageReservation,
) {
  const updated = await db.$executeRaw`
    UPDATE "AiSearchUsageReservation"
    SET "effectAppliedAt" = COALESCE("effectAppliedAt", CURRENT_TIMESTAMP),
        "updatedAt" = CURRENT_TIMESTAMP
    WHERE
      "id" = ${reservation.id}
      AND "shop" = ${reservation.shop}
      AND "periodId" = ${reservation.periodId}
      AND "status" = 'PENDING'
  `;

  if (updated === 1) return;

  const row = await reservationStatus(reservation.id);
  if (
    row?.effectAppliedAt ||
    row?.status === USAGE_RESERVATION_STATUS.committed
  ) {
    return;
  }

  throw new Error(`Unable to mark usage effect applied: ${reservation.id}`);
}

export async function commitSearchUsage(
  reservation: UsageReservation,
  metadata?: Record<string, unknown>,
) {
  const json = metadataJson(metadata);

  const committed = await db.$transaction(async (tx) => {
    const updated = await tx.$executeRaw`
      UPDATE "AiSearchUsageReservation"
      SET
        "status" = 'COMMITTED',
        "effectAppliedAt" = COALESCE("effectAppliedAt", CURRENT_TIMESTAMP),
        "resolvedAt" = CURRENT_TIMESTAMP,
        "updatedAt" = CURRENT_TIMESTAMP
      WHERE
        "id" = ${reservation.id}
        AND "shop" = ${reservation.shop}
        AND "periodId" = ${reservation.periodId}
        AND "kind" = 'SEARCH'
        AND "status" = 'PENDING'
    `;

    if (updated !== 1) return false;

    await tx.$executeRaw`
      INSERT INTO "AiSearchUsageEvent" (
        "shop", "periodId", "type", "quantity", "success", "queryHash",
        "metadataJson", "createdAt"
      ) VALUES (
        ${reservation.shop}, ${reservation.periodId}, 'SEARCH', 1, true,
        ${reservation.queryHash ?? null}, ${json}, CURRENT_TIMESTAMP
      )
    `;
    return true;
  });

  if (committed) return;
  const row = await reservationStatus(reservation.id);
  if (row?.status === USAGE_RESERVATION_STATUS.committed) return;
  throw new Error(
    `Search usage reservation cannot be committed: ${reservation.id}`,
  );
}

export async function rollbackSearchUsage(
  reservation: UsageReservation,
  error: unknown,
) {
  const json = metadataJson({
    error: error instanceof Error ? error.message : String(error),
  });

  const rolledBack = await db.$transaction(async (tx) => {
    const updated = await tx.$executeRaw`
      UPDATE "AiSearchUsageReservation"
      SET "status" = 'ROLLED_BACK', "resolvedAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP
      WHERE
        "id" = ${reservation.id}
        AND "shop" = ${reservation.shop}
        AND "periodId" = ${reservation.periodId}
        AND "kind" = 'SEARCH'
        AND "status" = 'PENDING'
    `;

    if (updated !== 1) return false;

    await tx.$executeRaw`
      UPDATE "AiSearchUsagePeriod"
      SET
        "searchCount" = CASE WHEN "searchCount" > 0 THEN "searchCount" - 1 ELSE 0 END,
        "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = ${reservation.periodId} AND "shop" = ${reservation.shop}
    `;

    await tx.$executeRaw`
      INSERT INTO "AiSearchUsageEvent" (
        "shop", "periodId", "type", "quantity", "success", "queryHash",
        "metadataJson", "createdAt"
      ) VALUES (
        ${reservation.shop}, ${reservation.periodId}, 'SEARCH', 0, false,
        ${reservation.queryHash ?? null}, ${json}, CURRENT_TIMESTAMP
      )
    `;
    return true;
  });

  if (rolledBack) return;
  const row = await reservationStatus(reservation.id);
  if (
    row?.status === USAGE_RESERVATION_STATUS.rolledBack ||
    row?.status === USAGE_RESERVATION_STATUS.committed
  ) {
    return;
  }
  throw new Error(
    `Search usage reservation cannot be rolled back: ${reservation.id}`,
  );
}

export async function commitProductEmbeddingUsage(
  reservation: UsageReservation,
  metadata?: Record<string, unknown>,
) {
  const json = metadataJson(metadata);

  const committed = await db.$transaction(async (tx) => {
    const updated = await tx.$executeRaw`
      UPDATE "AiSearchUsageReservation"
      SET
        "status" = 'COMMITTED',
        "effectAppliedAt" = COALESCE("effectAppliedAt", CURRENT_TIMESTAMP),
        "resolvedAt" = CURRENT_TIMESTAMP,
        "updatedAt" = CURRENT_TIMESTAMP
      WHERE
        "id" = ${reservation.id}
        AND "shop" = ${reservation.shop}
        AND "periodId" = ${reservation.periodId}
        AND "kind" IN ('VECTOR_UPDATE', 'PRODUCT_EMBEDDING')
        AND "status" = 'PENDING'
    `;

    if (updated !== 1) return false;

    await tx.$executeRaw`
      INSERT INTO "AiSearchUsageEvent" (
        "shop", "periodId", "type", "quantity", "success", "productId",
        "metadataJson", "createdAt"
      ) VALUES (
        ${reservation.shop}, ${reservation.periodId},
        ${reservation.countsVectorUpdate ? "VECTOR_UPDATE" : "PRODUCT_INDEX"},
        1, true, ${reservation.productId ?? null}, ${json}, CURRENT_TIMESTAMP
      )
    `;

    if (!reservation.countsVectorUpdate) {
      await tx.$executeRaw`
        UPDATE "AiSearchUsagePeriod"
        SET "productIndexCount" = "productIndexCount" + 1, "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = ${reservation.periodId} AND "shop" = ${reservation.shop}
      `;
    }

    return true;
  });

  if (committed) return;
  const row = await reservationStatus(reservation.id);
  if (row?.status === USAGE_RESERVATION_STATUS.committed) return;
  throw new Error(
    `Product usage reservation cannot be committed: ${reservation.id}`,
  );
}

export async function rollbackProductEmbeddingUsage(
  reservation: UsageReservation,
  error: unknown,
) {
  const json = metadataJson({
    error: error instanceof Error ? error.message : String(error),
  });

  const rolledBack = await db.$transaction(async (tx) => {
    const updated = await tx.$executeRaw`
      UPDATE "AiSearchUsageReservation"
      SET "status" = 'ROLLED_BACK', "resolvedAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP
      WHERE
        "id" = ${reservation.id}
        AND "shop" = ${reservation.shop}
        AND "periodId" = ${reservation.periodId}
        AND "kind" IN ('VECTOR_UPDATE', 'PRODUCT_EMBEDDING')
        AND "status" = 'PENDING'
    `;

    if (updated !== 1) return false;

    if (reservation.countsVectorUpdate) {
      await tx.$executeRaw`
        UPDATE "AiSearchUsagePeriod"
        SET
          "vectorUpdateCount" = CASE WHEN "vectorUpdateCount" > 0 THEN "vectorUpdateCount" - 1 ELSE 0 END,
          "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = ${reservation.periodId} AND "shop" = ${reservation.shop}
      `;
    }

    await tx.$executeRaw`
      INSERT INTO "AiSearchUsageEvent" (
        "shop", "periodId", "type", "quantity", "success", "productId",
        "metadataJson", "createdAt"
      ) VALUES (
        ${reservation.shop}, ${reservation.periodId},
        ${reservation.countsVectorUpdate ? "VECTOR_UPDATE" : "PRODUCT_INDEX"},
        0, false, ${reservation.productId ?? null}, ${json}, CURRENT_TIMESTAMP
      )
    `;

    return true;
  });

  if (rolledBack) return;
  const row = await reservationStatus(reservation.id);
  if (
    row?.status === USAGE_RESERVATION_STATUS.rolledBack ||
    row?.status === USAGE_RESERVATION_STATUS.committed
  ) {
    return;
  }
  throw new Error(
    `Product usage reservation cannot be rolled back: ${reservation.id}`,
  );
}

export async function reconcileStaleUsageReservations({
  staleAfterMs = 30 * 60_000,
  limit = 200,
}: {
  staleAfterMs?: number;
  limit?: number;
} = {}) {
  const safeStaleAfterMs = Math.max(60_000, staleAfterMs);
  const cutoff = new Date(Date.now() - safeStaleAfterMs);
  const safeLimit = Math.max(1, Math.min(Math.trunc(limit), 500));

  const rows = await db.$queryRaw<UsageReservationRow[]>`
    SELECT
      "id", "shop", "periodId", "kind", "status", "countsVectorUpdate",
      "productId", "queryHash", "embeddingConsumedAt", "effectAppliedAt",
      "resolvedAt", "createdAt", "updatedAt"
    FROM "AiSearchUsageReservation"
    WHERE "status" = 'PENDING' AND "updatedAt" < ${cutoff}
    ORDER BY "updatedAt" ASC
    LIMIT ${safeLimit}
  `;

  let committed = 0;
  let rolledBack = 0;

  for (const row of rows) {
    const reservation = mapReservation(row);

    try {
      let effectApplied = Boolean(row.effectAppliedAt);

      // A product vector write and the SQL reservation cannot participate in
      // one cross-system transaction. If the process dies after Qdrant accepts
      // the upsert but before SQL records effectAppliedAt, verify the exact
      // reservation marker stored in the vector payload before deciding whether
      // to charge or refund the reserved vector quota. This avoids silently
      // under-counting a real vector update after a narrow DB outage/crash.
      if (
        !effectApplied &&
        reservation.kind !== "SEARCH" &&
        reservation.productId
      ) {
        try {
          const vector = await getProductVectorForShop({
            shop: reservation.shop,
            productId: reservation.productId,
          });
          effectApplied = vector?.payload.usageReservationId === reservation.id;

          if (effectApplied) {
            await markUsageReservationEffectApplied(reservation);
          }
        } catch (verificationError) {
          // Do not refund quota when the external effect cannot be verified.
          // Leave the reservation PENDING for the next housekeeping pass.
          console.error(
            "[AI Search] Stale product reservation effect verification failed:",
            {
              reservationId: row.id,
              shop: row.shop,
              productId: reservation.productId,
              error:
                verificationError instanceof Error
                  ? verificationError.message
                  : String(verificationError),
            },
          );
          continue;
        }
      }

      if (effectApplied) {
        if (reservation.kind === "SEARCH") {
          await commitSearchUsage(reservation, {
            recoveredReservation: true,
            reason: "STALE_RESERVATION_EFFECT_APPLIED",
          });
        } else {
          await commitProductEmbeddingUsage(reservation, {
            recoveredReservation: true,
            reason: "STALE_RESERVATION_EFFECT_APPLIED",
          });
        }
        committed += 1;
      } else if (reservation.kind === "SEARCH") {
        await rollbackSearchUsage(
          reservation,
          new Error("STALE_USAGE_RESERVATION_RECOVERED"),
        );
        rolledBack += 1;
      } else {
        await rollbackProductEmbeddingUsage(
          reservation,
          new Error("STALE_USAGE_RESERVATION_RECOVERED"),
        );
        rolledBack += 1;
      }
    } catch (error) {
      console.error("[AI Search] Usage reservation recovery failed:", {
        reservationId: row.id,
        shop: row.shop,
        kind: row.kind,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { scanned: rows.length, committed, rolledBack };
}

export async function deleteResolvedUsageReservations({
  olderThanDays = 7,
}: {
  olderThanDays?: number;
} = {}) {
  const safeDays = Math.max(1, Math.min(Math.trunc(olderThanDays), 365));
  const cutoff = new Date(Date.now() - safeDays * 24 * 60 * 60_000);

  return db.$executeRaw`
    DELETE FROM "AiSearchUsageReservation"
    WHERE
      "status" IN ('COMMITTED', 'ROLLED_BACK')
      AND "resolvedAt" IS NOT NULL
      AND "resolvedAt" < ${cutoff}
  `;
}

export async function recordUsageEvent({
  shop,
  periodId,
  type,
  quantity = 1,
  success = true,
  productId,
  metadata,
}: {
  shop: string;
  periodId: number | null;
  type: string;
  quantity?: number;
  success?: boolean;
  productId?: string | null;
  metadata?: Record<string, unknown>;
}) {
  await insertUsageEvent({
    shop,
    periodId,
    type,
    quantity,
    success,
    productId,
    metadata,
  });
}

export async function recordProductDelete({
  shop,
  periodId,
  productId,
}: {
  shop: string;
  periodId: number;
  productId: string;
}) {
  await db.$executeRaw`
    UPDATE "AiSearchUsagePeriod"
    SET "productDeleteCount" = "productDeleteCount" + 1, "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = ${periodId} AND "shop" = ${shop}
  `;

  await insertUsageEvent({
    shop,
    periodId,
    type: "PRODUCT_DELETE",
    success: true,
    productId,
  });
}

export async function recordFallback({
  shop,
  periodId,
  query,
  reason,
}: {
  shop: string;
  periodId: number;
  query: string;
  reason: string;
}) {
  await db.$executeRaw`
    UPDATE "AiSearchUsagePeriod"
    SET "fallbackCount" = "fallbackCount" + 1, "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = ${periodId} AND "shop" = ${shop}
  `;

  await insertUsageEvent({
    shop,
    periodId,
    type: "FALLBACK",
    success: true,
    queryHash: hashSearchQuery(query),
    metadata: { reason },
  });
}

export async function getRecentUsageEvents(shop: string, limit = 50) {
  const safeLimit = Math.max(1, Math.min(Math.trunc(limit), 200));

  return db.$queryRaw<
    Array<{
      id: number;
      type: string;
      quantity: number;
      success: boolean | number;
      productId: string | null;
      queryHash: string | null;
      jobId: number | null;
      metadataJson: string | null;
      createdAt: Date | string;
    }>
  >`
    SELECT
      "id", "type", "quantity", "success", "productId", "queryHash",
      "jobId", "metadataJson", "createdAt"
    FROM "AiSearchUsageEvent"
    WHERE "shop" = ${shop}
    ORDER BY "id" DESC
    LIMIT ${safeLimit}
  `;
}

export async function getUsageEventTypeCounts(shop: string, periodId: number) {
  const rows = await db.$queryRaw<
    Array<{ type: string; count: bigint | number }>
  >`
    SELECT "type", COUNT(*) AS "count"
    FROM "AiSearchUsageEvent"
    WHERE "shop" = ${shop} AND "periodId" = ${periodId}
    GROUP BY "type"
  `;

  return Object.fromEntries(
    rows.map((row) => [row.type, Number(row.count ?? 0)]),
  ) as Record<string, number>;
}
