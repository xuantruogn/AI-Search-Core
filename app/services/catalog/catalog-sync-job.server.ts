import db from "../../db.server";
import { getShopEntitlement } from "../commerce/entitlement.server";
import { withDistributedLease } from "../commerce/lease-lock.server";

export const CATALOG_SYNC_STATUS = {
  pending: "PENDING",
  processing: "PROCESSING",
  done: "DONE",
  failed: "FAILED",
} as const;

export type CatalogJobRow = {
  id: number;
  shop: string;
  reason: string;
  planAtStart: string | null;
  status: string;
  cursor: string | null;
  pagesProcessed: number;
  productsProcessed: number;
  productsIndexed: number;
  productsSkipped: number;
  productsBlocked: number;
  productsFailed: number;
  attempts: number;
  lastError: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
  scanStartedAt: Date | string | null;
  startedAt: Date | string | null;
  processedAt: Date | string | null;
};

function readPositiveInteger(name: string, fallback: number) {
  const value = Number.parseInt(process.env[name] || "", 10);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

const MAX_ATTEMPTS = readPositiveInteger("AI_SEARCH_CATALOG_MAX_ATTEMPTS", 4);
const RETRY_BASE_MS = readPositiveInteger(
  "AI_SEARCH_CATALOG_RETRY_BASE_MS",
  10_000,
);
const RETRY_MAX_MS = readPositiveInteger(
  "AI_SEARCH_CATALOG_RETRY_MAX_MS",
  5 * 60_000,
);
const LEASE_MS = readPositiveInteger("AI_SEARCH_CATALOG_LEASE_MS", 5 * 60_000);

function asDate(value: Date | string | null) {
  if (!value) return null;
  return value instanceof Date ? value : new Date(value);
}

function retryDelay(attempts: number) {
  return Math.min(RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1), RETRY_MAX_MS);
}

function claimable(job: CatalogJobRow, now: Date) {
  if (job.attempts >= MAX_ATTEMPTS) return false;
  if (job.status === CATALOG_SYNC_STATUS.pending) return true;

  if (job.status === CATALOG_SYNC_STATUS.failed) {
    const failedAt = asDate(job.processedAt);
    return (
      !failedAt ||
      failedAt.getTime() + retryDelay(job.attempts) <= now.getTime()
    );
  }

  if (job.status === CATALOG_SYNC_STATUS.processing) {
    // updatedAt acts as the catalog worker heartbeat because page checkpoints
    // refresh it. `startedAt` is static for an attempt and caused healthy long
    // scans to be reclaimed after LEASE_MS.
    const heartbeatAt = asDate(job.updatedAt);
    return !heartbeatAt || heartbeatAt.getTime() + LEASE_MS <= now.getTime();
  }

  return false;
}

async function enqueueCatalogSyncUnlocked({
  shop,
  force,
  reason,
}: {
  shop: string;
  force: boolean;
  reason: string;
}) {
  const active = await db.$queryRaw<Array<{ id: number }>>`
    SELECT "id"
    FROM "AiSearchCatalogSyncJob"
    WHERE
      "shop" = ${shop}
      AND (
        "status" IN ('PENDING', 'PROCESSING')
        OR ("status" = 'FAILED' AND "attempts" < ${MAX_ATTEMPTS})
      )
    ORDER BY "id" DESC
    LIMIT 1
  `;

  if (active[0]) return active[0].id;

  const entitlement = await getShopEntitlement(shop);

  if (!entitlement.active) return null;
  if (!force && entitlement.indexedProducts > 0) return null;

  await db.$executeRaw`
    INSERT INTO "AiSearchCatalogSyncJob" (
      "shop", "reason", "planAtStart", "status", "createdAt", "updatedAt"
    ) VALUES (
      ${shop}, ${reason}, ${entitlement.plan}, 'PENDING', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    )
  `;

  const created = await db.$queryRaw<Array<{ id: number }>>`
    SELECT "id"
    FROM "AiSearchCatalogSyncJob"
    WHERE "shop" = ${shop}
    ORDER BY "id" DESC
    LIMIT 1
  `;

  const jobId = created[0]?.id ?? null;
  console.log("[AI Search] Catalog sync job queued:", {
    shop,
    jobId,
    force,
    reason,
    planAtStart: entitlement.plan,
  });
  return jobId;
}

export async function enqueueCatalogSync({
  shop,
  force = false,
  reason = "INITIAL",
}: {
  shop: string;
  force?: boolean;
  reason?: string;
}) {
  // Serialize the SELECT-active -> INSERT sequence across app instances.
  // Without this, two servers can both observe "no active job" and create two
  // catalog scans for the same shop.
  return withDistributedLease({
    shop,
    resource: "catalog:enqueue",
    leaseMs: 30_000,
    waitTimeoutMs: 10_000,
    pollMs: 100,
    task: () =>
      enqueueCatalogSyncUnlocked({
        shop,
        force,
        reason,
      }),
  });
}

export function enqueueInitialCatalogSyncIfNeeded(shop: string) {
  return enqueueCatalogSync({ shop, force: false, reason: "INITIAL" });
}

export function enqueueCatalogRefresh(shop: string, reason = "RECONCILE") {
  return enqueueCatalogSync({ shop, force: true, reason });
}

async function candidates() {
  const [pending, processing, failed] = await Promise.all([
    db.$queryRaw<CatalogJobRow[]>`
      SELECT *
      FROM "AiSearchCatalogSyncJob"
      WHERE "attempts" < ${MAX_ATTEMPTS} AND "status" = 'PENDING'
      ORDER BY "createdAt" ASC, "id" ASC
      LIMIT 20
    `,
    db.$queryRaw<CatalogJobRow[]>`
      SELECT *
      FROM "AiSearchCatalogSyncJob"
      WHERE "attempts" < ${MAX_ATTEMPTS} AND "status" = 'PROCESSING'
      ORDER BY "updatedAt" ASC, "id" ASC
      LIMIT 20
    `,
    db.$queryRaw<CatalogJobRow[]>`
      SELECT *
      FROM "AiSearchCatalogSyncJob"
      WHERE "attempts" < ${MAX_ATTEMPTS} AND "status" = 'FAILED'
      ORDER BY "processedAt" ASC, "id" ASC
      LIMIT 50
    `,
  ]);

  return [...pending, ...processing, ...failed];
}

function catalogEligibleAt(job: CatalogJobRow) {
  const createdAt = asDate(job.createdAt)?.getTime() ?? 0;

  if (job.status === CATALOG_SYNC_STATUS.pending) return createdAt;

  if (job.status === CATALOG_SYNC_STATUS.processing) {
    return (asDate(job.updatedAt)?.getTime() ?? 0) + LEASE_MS;
  }

  if (job.status === CATALOG_SYNC_STATUS.failed) {
    return (asDate(job.processedAt)?.getTime() ?? 0) + retryDelay(job.attempts);
  }

  return Number.POSITIVE_INFINITY;
}

export async function claimNextCatalogSyncJob() {
  const now = new Date();
  const claimableCandidates = (await candidates())
    .filter((candidate) => claimable(candidate, now))
    .sort((left, right) => {
      const byEligibility = catalogEligibleAt(left) - catalogEligibleAt(right);
      if (byEligibility !== 0) return byEligibility;
      const leftCreated = asDate(left.createdAt)?.getTime() ?? 0;
      const rightCreated = asDate(right.createdAt)?.getTime() ?? 0;
      return leftCreated !== rightCreated
        ? leftCreated - rightCreated
        : left.id - right.id;
    });

  for (const candidate of claimableCandidates) {
    // `status + attempts` is the atomic compare-and-swap guard. Do not compare
    // `updatedAt` here: SQLite/Prisma can round-trip the same timestamp with a
    // different textual precision/representation, which can make a valid
    // PENDING job impossible to claim. `attempts` changes on every claim, so
    // concurrent workers are still safely fenced without timestamp equality.
    const updated = await db.$executeRaw`
      UPDATE "AiSearchCatalogSyncJob"
      SET
        "status" = 'PROCESSING',
        "attempts" = "attempts" + 1,
        "scanStartedAt" = COALESCE("scanStartedAt", CURRENT_TIMESTAMP),
        "startedAt" = CURRENT_TIMESTAMP,
        "processedAt" = NULL,
        "lastError" = NULL,
        "updatedAt" = CURRENT_TIMESTAMP
      WHERE
        "id" = ${candidate.id}
        AND "status" = ${candidate.status}
        AND "attempts" = ${candidate.attempts}
    `;

    if (updated === 1) {
      const rows = await db.$queryRaw<CatalogJobRow[]>`
        SELECT * FROM "AiSearchCatalogSyncJob" WHERE "id" = ${candidate.id} LIMIT 1
      `;
      const claimed = rows[0] ?? null;
      if (claimed) {
        console.log("[AI Search] Catalog sync job claimed:", {
          jobId: claimed.id,
          shop: claimed.shop,
          attempt: claimed.attempts,
          reason: claimed.reason,
        });
      }
      return claimed;
    }
  }

  return null;
}

export async function checkpointCatalogSyncJob(
  jobId: number,
  expectedAttempt: number,
  cursor: string | null,
  progress: {
    pagesProcessed: number;
    productsProcessed: number;
    productsIndexed: number;
    productsSkipped: number;
    productsBlocked: number;
    productsFailed: number;
  },
) {
  const updated = await db.$executeRaw`
    UPDATE "AiSearchCatalogSyncJob"
    SET
      "cursor" = ${cursor},
      "pagesProcessed" = ${progress.pagesProcessed},
      "productsProcessed" = ${progress.productsProcessed},
      "productsIndexed" = ${progress.productsIndexed},
      "productsSkipped" = ${progress.productsSkipped},
      "productsBlocked" = ${progress.productsBlocked},
      "productsFailed" = ${progress.productsFailed},
      "updatedAt" = CURRENT_TIMESTAMP
    WHERE
      "id" = ${jobId}
      AND "status" = 'PROCESSING'
      AND "attempts" = ${expectedAttempt}
  `;

  return updated === 1;
}

export async function heartbeatCatalogSyncJob(
  jobId: number,
  expectedAttempt: number,
) {
  const updated = await db.$executeRaw`
    UPDATE "AiSearchCatalogSyncJob"
    SET "updatedAt" = CURRENT_TIMESTAMP
    WHERE
      "id" = ${jobId}
      AND "status" = 'PROCESSING'
      AND "attempts" = ${expectedAttempt}
  `;

  return updated === 1;
}

export async function markCatalogSyncDone(
  jobId: number,
  expectedAttempt: number,
  progress: {
    pagesProcessed: number;
    productsProcessed: number;
    productsIndexed: number;
    productsSkipped: number;
    productsBlocked: number;
    productsFailed: number;
  },
) {
  const updated = await db.$executeRaw`
    UPDATE "AiSearchCatalogSyncJob"
    SET
      "status" = 'DONE',
      "cursor" = NULL,
      "pagesProcessed" = ${progress.pagesProcessed},
      "productsProcessed" = ${progress.productsProcessed},
      "productsIndexed" = ${progress.productsIndexed},
      "productsSkipped" = ${progress.productsSkipped},
      "productsBlocked" = ${progress.productsBlocked},
      "productsFailed" = ${progress.productsFailed},
      "processedAt" = CURRENT_TIMESTAMP,
      "updatedAt" = CURRENT_TIMESTAMP
    WHERE
      "id" = ${jobId}
      AND "status" = 'PROCESSING'
      AND "attempts" = ${expectedAttempt}
  `;

  if (updated !== 1) {
    console.warn(
      "[AI Search] Catalog completion ignored for superseded attempt:",
      {
        jobId,
        expectedAttempt,
      },
    );
  }

  return updated === 1;
}

export async function markCatalogSyncFailed(
  jobId: number,
  expectedAttempt: number,
  error: unknown,
) {
  const message = (
    error instanceof Error ? error.message : String(error)
  ).slice(0, 8_000);

  const updated = await db.$executeRaw`
    UPDATE "AiSearchCatalogSyncJob"
    SET
      "status" = 'FAILED',
      "lastError" = ${message},
      "processedAt" = CURRENT_TIMESTAMP,
      "updatedAt" = CURRENT_TIMESTAMP
    WHERE
      "id" = ${jobId}
      AND "status" = 'PROCESSING'
      AND "attempts" = ${expectedAttempt}
  `;

  if (updated !== 1) {
    console.warn(
      "[AI Search] Catalog failure ignored for superseded attempt:",
      {
        jobId,
        expectedAttempt,
      },
    );
    return false;
  }

  const rows = await db.$queryRaw<Array<{ attempts: number }>>`
    SELECT "attempts" FROM "AiSearchCatalogSyncJob" WHERE "id" = ${jobId} LIMIT 1
  `;
  const attempts = rows[0]?.attempts ?? MAX_ATTEMPTS;

  console.error("[AI Search] Catalog sync job failed:", {
    jobId,
    attempts,
    maxAttempts: MAX_ATTEMPTS,
    willRetry: attempts < MAX_ATTEMPTS,
    retryInMs: attempts < MAX_ATTEMPTS ? retryDelay(attempts) : null,
    error: message,
  });

  return true;
}

export async function getCatalogSyncJob(jobId: number) {
  const rows = await db.$queryRaw<CatalogJobRow[]>`
    SELECT *
    FROM "AiSearchCatalogSyncJob"
    WHERE "id" = ${jobId}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function getLatestCatalogSyncJob(shop: string) {
  const rows = await db.$queryRaw<CatalogJobRow[]>`
    SELECT *
    FROM "AiSearchCatalogSyncJob"
    WHERE "shop" = ${shop}
    ORDER BY "id" DESC
    LIMIT 1
  `;
  return rows[0] ?? null;
}

// Manual recovery after a catalog job has exhausted automatic retries.
export async function retryLatestFailedCatalogSyncJob(shop: string) {
  const rows = await db.$queryRaw<Array<{ id: number }>>`
    SELECT "id"
    FROM "AiSearchCatalogSyncJob"
    WHERE "shop" = ${shop} AND "status" = 'FAILED'
    ORDER BY "id" DESC
    LIMIT 1
  `;

  const jobId = rows[0]?.id ?? null;
  if (!jobId) return null;

  const updated = await db.$executeRaw`
    UPDATE "AiSearchCatalogSyncJob"
    SET
      "status" = 'PENDING',
      "attempts" = 0,
      "lastError" = NULL,
      "startedAt" = NULL,
      "processedAt" = NULL,
      "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = ${jobId} AND "shop" = ${shop} AND "status" = 'FAILED'
  `;

  return updated === 1 ? jobId : null;
}
