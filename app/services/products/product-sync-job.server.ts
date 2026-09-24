import { Prisma } from "@prisma/client";

import db from "../../db.server";
import { normalizeProductGid } from "./product-id.server";

export const PRODUCT_SYNC_JOB_STATUS = {
  pending: "PENDING",
  processing: "PROCESSING",
  done: "DONE",
  failed: "FAILED",
} as const;

export type ProductSyncJobStatus =
  (typeof PRODUCT_SYNC_JOB_STATUS)[keyof typeof PRODUCT_SYNC_JOB_STATUS];

export type EnqueueProductSyncJobInput = {
  shop: string;
  webhookId: string;
  topic: string;
  productId: string | number;
  policyVersion?: number | null;
};

export type EnqueueProductSyncJobResult =
  | {
      created: true;
      duplicate: false;
      jobId: number;
    }
  | {
      created: false;
      duplicate: true;
      jobId: number | null;
    };

function readPositiveInteger(name: string, fallback: number) {
  const raw = process.env[name];

  if (!raw) {
    return fallback;
  }

  const value = Number.parseInt(raw, 10);

  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export const PRODUCT_SYNC_MAX_ATTEMPTS = readPositiveInteger(
  "AI_SEARCH_SYNC_MAX_ATTEMPTS",
  5,
);

const PRODUCT_SYNC_RETRY_BASE_MS = readPositiveInteger(
  "AI_SEARCH_SYNC_RETRY_BASE_MS",
  5_000,
);

const PRODUCT_SYNC_RETRY_MAX_MS = readPositiveInteger(
  "AI_SEARCH_SYNC_RETRY_MAX_MS",
  5 * 60_000,
);

const PRODUCT_SYNC_LEASE_MS = readPositiveInteger(
  "AI_SEARCH_SYNC_LEASE_MS",
  2 * 60_000,
);

function getRetryDelayMs(attempts: number) {
  const exponent = Math.max(0, attempts - 1);
  const delay = PRODUCT_SYNC_RETRY_BASE_MS * 2 ** exponent;

  return Math.min(delay, PRODUCT_SYNC_RETRY_MAX_MS);
}

type ClaimCandidate = {
  id: number;
  status: string;
  attempts: number;
  updatedAt: Date;
  startedAt: Date | null;
  processedAt: Date | null;
};

function isClaimable(job: ClaimCandidate, now: Date) {
  if (job.attempts >= PRODUCT_SYNC_MAX_ATTEMPTS) {
    return false;
  }

  if (job.status === PRODUCT_SYNC_JOB_STATUS.pending) {
    return true;
  }

  if (job.status === PRODUCT_SYNC_JOB_STATUS.failed) {
    if (!job.processedAt) {
      return true;
    }

    const retryAt = job.processedAt.getTime() + getRetryDelayMs(job.attempts);

    return retryAt <= now.getTime();
  }

  if (job.status === PRODUCT_SYNC_JOB_STATUS.processing) {
    // updatedAt is a renewable worker heartbeat. startedAt is fixed for an
    // attempt and must not make a healthy long-running job look abandoned.
    return job.updatedAt.getTime() + PRODUCT_SYNC_LEASE_MS <= now.getTime();
  }

  return false;
}

// =====================================================
// ENQUEUE WEBHOOK JOB
//
// webhookId có UNIQUE constraint trong Prisma.
// Shopify retry cùng webhookId -> chỉ còn một job.
// =====================================================

export async function enqueueProductSyncJob({
  shop,
  webhookId,
  topic,
  productId,
  policyVersion = null,
}: EnqueueProductSyncJobInput): Promise<EnqueueProductSyncJobResult> {
  const cleanShop = shop.trim();
  const cleanWebhookId = webhookId.trim();
  const cleanTopic = topic.trim();

  if (!cleanShop) {
    throw new Error("Shop cannot be empty");
  }

  if (!cleanWebhookId) {
    throw new Error("Webhook ID cannot be empty");
  }

  if (!cleanTopic) {
    throw new Error("Webhook topic cannot be empty");
  }

  const gid = normalizeProductGid(productId);

  if (cleanTopic === "REINDEX_PRODUCT") {
    const existingWork = await db.aiSearchSyncJob.findFirst({
      where: {
        shop: cleanShop,
        productId: gid,
        status: { in: [PRODUCT_SYNC_JOB_STATUS.pending, PRODUCT_SYNC_JOB_STATUS.processing] },
      },
      select: { id: true },
    });
    if (existingWork) {
      return { created: false, duplicate: true, jobId: existingWork.id };
    }
  }

  try {
    const job = await db.aiSearchSyncJob.create({
      data: {
        shop: cleanShop,
        webhookId: cleanWebhookId,
        topic: cleanTopic,
        productId: gid,
        status: PRODUCT_SYNC_JOB_STATUS.pending,
      },
    });
    if (policyVersion !== null) {
      await db.$executeRaw`
        UPDATE \`AiSearchSyncJob\` SET \`policyVersion\` = ${policyVersion}
        WHERE \`id\` = ${job.id}
      `;
    }

    console.log("[AI Search] Sync job queued:", {
      jobId: job.id,
      webhookId: cleanWebhookId,
      topic: cleanTopic,
      productId: gid,
    });

    return {
      created: true,
      duplicate: false,
      jobId: job.id,
    };
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      const existing = await db.aiSearchSyncJob.findUnique({
        where: {
          webhookId: cleanWebhookId,
        },
        select: {
          id: true,
        },
      });

      console.log("[AI Search] Duplicate webhook ignored:", {
        webhookId: cleanWebhookId,
        existingJobId: existing?.id ?? null,
      });

      return {
        created: false,
        duplicate: true,
        jobId: existing?.id ?? null,
      };
    }

    throw error;
  }
}

export async function getProductSyncJob(jobId: number) {
  return db.aiSearchSyncJob.findUnique({
    where: {
      id: jobId,
    },
  });
}

// =====================================================
// ATOMIC CLAIM
//
// updatedAt + status là optimistic lock.
// Hai worker có thể cùng nhìn thấy candidate nhưng chỉ một worker
// updateMany thành công.
//
// startedAt đồng thời là lease timestamp. Nếu process chết, job
// PROCESSING sẽ được reclaim sau AI_SEARCH_SYNC_LEASE_MS.
// =====================================================

export async function claimProductSyncJob(jobId: number) {
  const current = await db.aiSearchSyncJob.findUnique({
    where: {
      id: jobId,
    },
  });

  if (!current || !isClaimable(current, new Date())) {
    return null;
  }

  const now = new Date();

  const claimed = await db.aiSearchSyncJob.updateMany({
    where: {
      id: current.id,
      status: current.status,
      updatedAt: current.updatedAt,
      attempts: {
        lt: PRODUCT_SYNC_MAX_ATTEMPTS,
      },
    },
    data: {
      status: PRODUCT_SYNC_JOB_STATUS.processing,
      attempts: {
        increment: 1,
      },
      startedAt: now,
      processedAt: null,
      lastError: null,
    },
  });

  if (claimed.count !== 1) {
    return null;
  }

  return db.aiSearchSyncJob.findUnique({
    where: {
      id: jobId,
    },
  });
}

export async function claimNextProductSyncJob() {
  const now = new Date();
  const staleBefore = new Date(now.getTime() - PRODUCT_SYNC_LEASE_MS);

  // Fetch a bounded set from each class, then order by the moment that job
  // actually became eligible. This avoids starving due retries on busy stores
  // while still keeping newly-arrived webhooks responsive.
  const [pendingCandidates, staleProcessingCandidates, failedCandidates] =
    await Promise.all([
      db.aiSearchSyncJob.findMany({
        where: {
          status: PRODUCT_SYNC_JOB_STATUS.pending,
          attempts: { lt: PRODUCT_SYNC_MAX_ATTEMPTS },
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: 20,
      }),
      db.aiSearchSyncJob.findMany({
        where: {
          status: PRODUCT_SYNC_JOB_STATUS.processing,
          attempts: { lt: PRODUCT_SYNC_MAX_ATTEMPTS },
          updatedAt: { lte: staleBefore },
        },
        orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
        take: 20,
      }),
      db.aiSearchSyncJob.findMany({
        where: {
          status: PRODUCT_SYNC_JOB_STATUS.failed,
          attempts: { lt: PRODUCT_SYNC_MAX_ATTEMPTS },
        },
        orderBy: [{ processedAt: "asc" }, { id: "asc" }],
        take: 50,
      }),
    ]);

  const eligibleAt = (job: (typeof pendingCandidates)[number]) => {
    if (job.status === PRODUCT_SYNC_JOB_STATUS.pending) {
      return job.createdAt.getTime();
    }

    if (job.status === PRODUCT_SYNC_JOB_STATUS.processing) {
      return job.updatedAt.getTime() + PRODUCT_SYNC_LEASE_MS;
    }

    if (job.status === PRODUCT_SYNC_JOB_STATUS.failed) {
      return (job.processedAt?.getTime() ?? 0) + getRetryDelayMs(job.attempts);
    }

    return Number.POSITIVE_INFINITY;
  };

  const candidates = [
    ...pendingCandidates,
    ...staleProcessingCandidates,
    ...failedCandidates,
  ]
    .filter((candidate) => isClaimable(candidate, now))
    .sort((left, right) => {
      const byEligibility = eligibleAt(left) - eligibleAt(right);
      if (byEligibility !== 0) return byEligibility;
      const byCreated = left.createdAt.getTime() - right.createdAt.getTime();
      return byCreated !== 0 ? byCreated : left.id - right.id;
    });

  for (const candidate of candidates) {
    const claimed = await claimProductSyncJob(candidate.id);
    if (claimed) return claimed;
  }

  return null;
}

export async function heartbeatProductSyncJob(
  jobId: number,
  expectedAttempt: number,
) {
  const result = await db.aiSearchSyncJob.updateMany({
    where: {
      id: jobId,
      status: PRODUCT_SYNC_JOB_STATUS.processing,
      attempts: expectedAttempt,
    },
    data: {
      // Explicitly touch the renewable lease heartbeat without changing the
      // attempt's original startedAt timestamp.
      updatedAt: new Date(),
    },
  });

  return result.count === 1;
}

export async function markProductSyncJobDone(
  jobId: number,
  expectedAttempt: number,
) {
  const result = await db.aiSearchSyncJob.updateMany({
    where: {
      id: jobId,
      status: PRODUCT_SYNC_JOB_STATUS.processing,
      attempts: expectedAttempt,
    },
    data: {
      status: PRODUCT_SYNC_JOB_STATUS.done,
      processedAt: new Date(),
      lastError: null,
    },
  });

  return result.count === 1;
}

export async function markProductSyncJobFailed(
  jobId: number,
  expectedAttempt: number,
  error: unknown,
) {
  const message = error instanceof Error ? error.message : String(error);

  const result = await db.aiSearchSyncJob.updateMany({
    where: {
      id: jobId,
      status: PRODUCT_SYNC_JOB_STATUS.processing,
      attempts: expectedAttempt,
    },
    data: {
      status: PRODUCT_SYNC_JOB_STATUS.failed,
      processedAt: new Date(),
      lastError: message.slice(0, 8_000),
    },
  });

  if (result.count !== 1) {
    console.warn(
      "[AI Search] Product sync failure ignored for superseded attempt:",
      {
        jobId,
        expectedAttempt,
      },
    );
    return false;
  }

  const failed = await db.aiSearchSyncJob.findUnique({ where: { id: jobId } });
  const attempts = failed?.attempts ?? expectedAttempt;
  const willRetry = attempts < PRODUCT_SYNC_MAX_ATTEMPTS;
  const retryDelayMs = willRetry ? getRetryDelayMs(attempts) : null;

  console.error("[AI Search] Sync job marked failed:", {
    jobId,
    attempts,
    maxAttempts: PRODUCT_SYNC_MAX_ATTEMPTS,
    willRetry,
    retryInMs: retryDelayMs,
    error: message.slice(0, 2_000),
  });

  return true;
}

export async function getProductSyncQueueStats(shop?: string) {
  const [pending, processing, failed, done] = await Promise.all([
    db.aiSearchSyncJob.count({
      where: {
        status: PRODUCT_SYNC_JOB_STATUS.pending,
        ...(shop ? { shop } : {}),
      },
    }),
    db.aiSearchSyncJob.count({
      where: {
        status: PRODUCT_SYNC_JOB_STATUS.processing,
        ...(shop ? { shop } : {}),
      },
    }),
    db.aiSearchSyncJob.count({
      where: {
        status: PRODUCT_SYNC_JOB_STATUS.failed,
        ...(shop ? { shop } : {}),
      },
    }),
    db.aiSearchSyncJob.count({
      where: {
        status: PRODUCT_SYNC_JOB_STATUS.done,
        ...(shop ? { shop } : {}),
      },
    }),
  ]);

  return {
    pending,
    processing,
    failed,
    done,
  };
}

// =====================================================
// MANUAL OPERATOR RETRY
//
// Automatic retry stops after PRODUCT_SYNC_MAX_ATTEMPTS. This helper lets an
// authenticated merchant/admin explicitly requeue exhausted FAILED jobs
// without creating duplicate webhook rows.
// =====================================================

export async function retryFailedProductSyncJobs(shop: string, limit = 50) {
  const safeLimit = Math.max(1, Math.min(Math.trunc(limit), 200));

  const jobs = await db.aiSearchSyncJob.findMany({
    where: {
      shop,
      status: PRODUCT_SYNC_JOB_STATUS.failed,
    },
    orderBy: [{ processedAt: "asc" }, { id: "asc" }],
    take: safeLimit,
    select: { id: true },
  });

  if (jobs.length === 0) {
    return { requeued: 0 };
  }

  const result = await db.aiSearchSyncJob.updateMany({
    where: {
      shop,
      status: PRODUCT_SYNC_JOB_STATUS.failed,
      id: { in: jobs.map((job) => job.id) },
    },
    data: {
      status: PRODUCT_SYNC_JOB_STATUS.pending,
      attempts: 0,
      lastError: null,
      startedAt: null,
      processedAt: null,
    },
  });

  console.log("[AI Search] Failed product jobs manually requeued:", {
    shop,
    requeued: result.count,
  });

  return { requeued: result.count };
}
