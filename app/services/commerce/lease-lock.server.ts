import { randomUUID } from "node:crypto";

import db from "../../db.server";

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function readPositiveInteger(name: string, fallback: number) {
  const value = Number.parseInt(process.env[name] || "", 10);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

type LeaseOptions<T> = {
  shop: string;
  resource: string;
  task: () => Promise<T>;
  leaseMs?: number;
  waitTimeoutMs?: number;
  pollMs?: number;
};

async function tryAcquire({
  shop,
  resource,
  ownerToken,
  leaseMs,
}: {
  shop: string;
  resource: string;
  ownerToken: string;
  leaseMs: number;
}) {
  const now = new Date();
  const leaseUntil = new Date(now.getTime() + leaseMs);

  // UPSERT only steals an existing lock after its lease has expired. This is
  // atomic in SQLite and also maps cleanly to PostgreSQL's ON CONFLICT model
  // when production storage is migrated later.
  await db.$executeRaw`
    INSERT INTO "AiSearchLeaseLock" (
      "shop", "resource", "ownerToken", "leaseUntil", "createdAt", "updatedAt"
    ) VALUES (
      ${shop}, ${resource}, ${ownerToken}, ${leaseUntil}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    )
    ON CONFLICT("shop", "resource") DO UPDATE SET
      "ownerToken" = excluded."ownerToken",
      "leaseUntil" = excluded."leaseUntil",
      "updatedAt" = CURRENT_TIMESTAMP
    WHERE "AiSearchLeaseLock"."leaseUntil" <= ${now}
  `;

  const rows = await db.$queryRaw<Array<{ ownerToken: string }>>`
    SELECT "ownerToken"
    FROM "AiSearchLeaseLock"
    WHERE "shop" = ${shop} AND "resource" = ${resource}
    LIMIT 1
  `;

  return rows[0]?.ownerToken === ownerToken;
}

async function renewLease({
  shop,
  resource,
  ownerToken,
  leaseMs,
}: {
  shop: string;
  resource: string;
  ownerToken: string;
  leaseMs: number;
}) {
  const leaseUntil = new Date(Date.now() + leaseMs);

  return db.$executeRaw`
    UPDATE "AiSearchLeaseLock"
    SET "leaseUntil" = ${leaseUntil}, "updatedAt" = CURRENT_TIMESTAMP
    WHERE
      "shop" = ${shop}
      AND "resource" = ${resource}
      AND "ownerToken" = ${ownerToken}
  `;
}

async function releaseLease({
  shop,
  resource,
  ownerToken,
}: {
  shop: string;
  resource: string;
  ownerToken: string;
}) {
  await db.$executeRaw`
    DELETE FROM "AiSearchLeaseLock"
    WHERE
      "shop" = ${shop}
      AND "resource" = ${resource}
      AND "ownerToken" = ${ownerToken}
  `;
}

async function stillOwnsLease({
  shop,
  resource,
  ownerToken,
}: {
  shop: string;
  resource: string;
  ownerToken: string;
}) {
  const rows = await db.$queryRaw<
    Array<{ ownerToken: string; leaseUntil: Date }>
  >`
    SELECT "ownerToken", "leaseUntil"
    FROM "AiSearchLeaseLock"
    WHERE "shop" = ${shop} AND "resource" = ${resource}
    LIMIT 1
  `;
  const row = rows[0];
  return Boolean(
    row &&
    row.ownerToken === ownerToken &&
    new Date(row.leaseUntil).getTime() > Date.now(),
  );
}

export async function withDistributedLease<T>({
  shop,
  resource,
  task,
  leaseMs = readPositiveInteger("AI_SEARCH_DISTRIBUTED_LOCK_LEASE_MS", 300_000),
  waitTimeoutMs = readPositiveInteger(
    "AI_SEARCH_DISTRIBUTED_LOCK_WAIT_MS",
    180_000,
  ),
  pollMs = readPositiveInteger("AI_SEARCH_DISTRIBUTED_LOCK_POLL_MS", 150),
}: LeaseOptions<T>): Promise<T> {
  const ownerToken = randomUUID();
  const deadline = Date.now() + waitTimeoutMs;
  const safeLeaseMs = Math.max(10_000, leaseMs);
  const safePollMs = Math.max(25, Math.min(pollMs, 5_000));

  for (;;) {
    if (
      await tryAcquire({
        shop,
        resource,
        ownerToken,
        leaseMs: safeLeaseMs,
      })
    ) {
      break;
    }

    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for distributed lock: ${resource}`);
    }

    await sleep(safePollMs);
  }

  let heartbeatRunning = false;
  let leaseLost = false;
  const heartbeatMs = Math.max(2_000, Math.floor(safeLeaseMs / 3));
  const heartbeat = setInterval(() => {
    if (heartbeatRunning) return;
    heartbeatRunning = true;

    void renewLease({
      shop,
      resource,
      ownerToken,
      leaseMs: safeLeaseMs,
    })
      .then((updated) => {
        if (updated !== 1) {
          leaseLost = true;
          console.error("[AI Search] Distributed lock lease was lost:", {
            shop,
            resource,
          });
        }
      })
      .catch((error) => {
        console.error("[AI Search] Distributed lock heartbeat failed:", {
          shop,
          resource,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        heartbeatRunning = false;
      });
  }, heartbeatMs);
  heartbeat.unref?.();

  try {
    const result = await task();

    // Do not let a worker report success after another process has already
    // reclaimed its lease. Most core operations are idempotent, so surfacing
    // lease loss lets the durable job retry/reconcile instead of committing a
    // stale attempt as successful.
    if (leaseLost || !(await stillOwnsLease({ shop, resource, ownerToken }))) {
      throw new Error(`Distributed lock lease lost: ${resource}`);
    }

    return result;
  } finally {
    clearInterval(heartbeat);
    await releaseLease({ shop, resource, ownerToken }).catch((error) => {
      console.error("[AI Search] Distributed lock release failed:", {
        shop,
        resource,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
}

export async function deleteShopLeaseLocks(shop: string) {
  await db.$executeRaw`
    DELETE FROM "AiSearchLeaseLock"
    WHERE "shop" = ${shop}
  `;
}

export async function deleteExpiredLeaseLocks(now = new Date()) {
  return db.$executeRaw`
    DELETE FROM "AiSearchLeaseLock"
    WHERE "leaseUntil" <= ${now}
  `;
}

const leaseCleanupGlobal = globalThis as typeof globalThis & {
  aiSearchLeaseCleanupStarted?: boolean;
};

export function startDistributedLeaseCleanupWorker() {
  if (leaseCleanupGlobal.aiSearchLeaseCleanupStarted) return;
  leaseCleanupGlobal.aiSearchLeaseCleanupStarted = true;

  const intervalMs = readPositiveInteger(
    "AI_SEARCH_LEASE_CLEANUP_MS",
    10 * 60_000,
  );

  const cleanup = () => {
    void deleteExpiredLeaseLocks().catch((error) => {
      console.error("[AI Search] Expired lease cleanup failed:", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };

  const timer = setInterval(cleanup, Math.max(60_000, intervalMs));
  timer.unref?.();
  cleanup();
}
