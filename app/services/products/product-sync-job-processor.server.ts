import type { AiSearchSyncJob } from "@prisma/client";

import db from "../../db.server";
import {
  deleteProductFromWebhook,
  syncProductFromWebhook,
} from "./product-webhook-sync.server";
import {
  claimProductSyncJob,
  getProductSyncJob,
  heartbeatProductSyncJob,
  markProductSyncJobDone,
  markProductSyncJobFailed,
  PRODUCT_SYNC_JOB_STATUS,
} from "./product-sync-job.server";
import { withProductSyncLock } from "./product-sync-lock.server";
import { ensureShopForBackgroundWork } from "../commerce/shop-registry.server";
import { withDistributedLease } from "../commerce/lease-lock.server";

type AdminGraphqlClient = {
  graphql: (
    query: string,
    options?: {
      variables?: Record<string, unknown>;
    },
  ) => Promise<Response>;
};

export type ProcessProductSyncJobInput = {
  jobId: number;
  admin?: AdminGraphqlClient | null;
};

export type ProcessClaimedProductSyncJobInput = {
  job: AiSearchSyncJob;
  admin?: AdminGraphqlClient | null;
};

function requiresAdmin(topic: string) {
  return topic === "PRODUCTS_CREATE" || topic === "PRODUCTS_UPDATE" || topic === "REINDEX_PRODUCT";
}

async function runJobWorkWithPolicyStable({ job, admin }: ProcessClaimedProductSyncJobInput) {
  if (job.topic === "REINDEX_PRODUCT") {
    const policyRows = await db.$queryRaw<Array<{ productPolicyVersion: number }>>`
      SELECT \`productPolicyVersion\` FROM \`AiSearchShopSettings\`
      WHERE \`shop\` = ${job.shop} LIMIT 1
    `;
    const productRows = await db.$queryRaw<Array<{
      blockedReason: string | null; vectorStatus: string; searchable: boolean | number;
    }>>`
      SELECT \`blockedReason\`, \`vectorStatus\`, \`searchable\`
      FROM \`AiSearchIndexedProduct\`
      WHERE \`shop\` = ${job.shop} AND \`productId\` = ${job.productId} LIMIT 1
    `;
    const jobRows = await db.$queryRaw<Array<{ policyVersion: number | null }>>`
      SELECT \`policyVersion\` FROM \`AiSearchSyncJob\` WHERE \`id\` = ${job.id} LIMIT 1
    `;
    const policy = policyRows[0];
    const product = productRows[0];
    const jobPolicyVersion = jobRows[0]?.policyVersion ?? null;
    const currentPolicyVersion = policy?.productPolicyVersion ?? 0;
    const eligible = Boolean(product) && product?.blockedReason === null;
    console.log("[AI Search] Product policy job check", {
      jobId: job.id, jobKind: job.topic, productId: job.productId,
      jobPolicyVersion, currentPolicyVersion,
      currentEligibility: eligible, vectorStatus: product?.vectorStatus ?? "MISSING",
      requiresAI: eligible && product?.vectorStatus !== "READY",
    });
    if (!eligible || jobPolicyVersion !== currentPolicyVersion) {
      return { action: "skipped", productId: job.productId } as const;
    }
  }

  if (requiresAdmin(job.topic)) {
    if (!admin) {
      throw new Error(`Admin API client required for ${job.topic}`);
    }

    return syncProductFromWebhook({
      admin,
      shop: job.shop,
      productId: job.productId,
    });
  }

  if (job.topic === "PRODUCTS_DELETE") {
    return deleteProductFromWebhook({
      shop: job.shop,
      productId: job.productId,
    });
  }

  throw new Error(`Unsupported AI Search sync topic: ${job.topic}`);
}

async function runJobWork(input: ProcessClaimedProductSyncJobInput) {
  if (input.job.topic !== "REINDEX_PRODUCT") {
    return runJobWorkWithPolicyStable(input);
  }

  // Keep the policy generation stable from the stale-job check through the
  // actual vector write and registry activation. A downgrade cannot race the
  // job and be overwritten after the initial version check.
  return withDistributedLease({
    shop: input.job.shop,
    resource: "product-policy:reconcile",
    task: () => runJobWorkWithPolicyStable(input),
  });
}

// =====================================================
// PROCESS AN ALREADY-CLAIMED JOB
//
// Job phải ở PROCESSING và đã có lease trong DB.
// Queue worker dùng entry point này để tránh tăng attempts hai lần.
// =====================================================

export async function processClaimedProductSyncJob({
  job,
  admin,
}: ProcessClaimedProductSyncJobInput) {
  if (job.status === PRODUCT_SYNC_JOB_STATUS.done) {
    return {
      jobId: job.id,
      status: PRODUCT_SYNC_JOB_STATUS.done,
      skipped: true,
    } as const;
  }

  if (job.status !== PRODUCT_SYNC_JOB_STATUS.processing) {
    throw new Error(
      `AI Search sync job ${job.id} must be PROCESSING before execution; got ${job.status}`,
    );
  }

  return withProductSyncLock({
    shop: job.shop,
    productId: job.productId,
    task: async () => {
      const latestJob = await db.aiSearchSyncJob.findUnique({
        where: {
          id: job.id,
        },
      });

      if (!latestJob) {
        throw new Error(`AI Search sync job disappeared: ${job.id}`);
      }

      if (latestJob.status === PRODUCT_SYNC_JOB_STATUS.done) {
        return {
          jobId: latestJob.id,
          status: PRODUCT_SYNC_JOB_STATUS.done,
          skipped: true,
        } as const;
      }

      if (
        latestJob.status !== PRODUCT_SYNC_JOB_STATUS.processing ||
        latestJob.attempts !== job.attempts
      ) {
        throw new Error(
          `AI Search sync job ${latestJob.id} attempt was superseded; expected PROCESSING/${job.attempts}, got ${latestJob.status}/${latestJob.attempts}`,
        );
      }

      const shopActive = await ensureShopForBackgroundWork(latestJob.shop);
      if (!shopActive) {
        const committed = await markProductSyncJobDone(
          latestJob.id,
          latestJob.attempts,
        );

        console.log("[AI Search] Product sync skipped for inactive shop:", {
          jobId: latestJob.id,
          shop: latestJob.shop,
          committed,
        });

        return {
          jobId: latestJob.id,
          status: PRODUCT_SYNC_JOB_STATUS.done,
          skipped: true,
        } as const;
      }

      const heartbeatMs = Math.max(
        5_000,
        Math.min(
          30_000,
          Number.parseInt(
            process.env.AI_SEARCH_SYNC_HEARTBEAT_MS || "30000",
            10,
          ) || 30_000,
        ),
      );
      let heartbeatRunning = false;
      const heartbeat = setInterval(() => {
        if (heartbeatRunning) return;
        heartbeatRunning = true;
        void heartbeatProductSyncJob(latestJob.id, latestJob.attempts)
          .then((ok) => {
            if (!ok) {
              console.warn(
                "[AI Search] Product sync job lease heartbeat lost:",
                {
                  jobId: latestJob.id,
                  attempt: latestJob.attempts,
                },
              );
            }
          })
          .catch((error) => {
            console.error("[AI Search] Product sync job heartbeat failed:", {
              jobId: latestJob.id,
              attempt: latestJob.attempts,
              error: error instanceof Error ? error.message : String(error),
            });
          })
          .finally(() => {
            heartbeatRunning = false;
          });
      }, heartbeatMs);
      heartbeat.unref?.();

      try {
        console.log("[AI Search] Processing sync job:", {
          jobId: latestJob.id,
          topic: latestJob.topic,
          productId: latestJob.productId,
          attempt: latestJob.attempts,
        });

        const result = await runJobWork({
          job: latestJob,
          admin,
        });

        const committed = await markProductSyncJobDone(
          latestJob.id,
          latestJob.attempts,
        );

        if (!committed) {
          console.warn(
            "[AI Search] Product sync completion ignored for superseded attempt:",
            {
              jobId: latestJob.id,
              attempt: latestJob.attempts,
            },
          );
        }

        console.log("[AI Search] Sync job completed:", {
          jobId: latestJob.id,
          topic: latestJob.topic,
          productId: latestJob.productId,
          action: result.action,
        });

        return {
          jobId: latestJob.id,
          status: PRODUCT_SYNC_JOB_STATUS.done,
          skipped: false,
          result,
        } as const;
      } catch (error) {
        await markProductSyncJobFailed(latestJob.id, latestJob.attempts, error);
        throw error;
      } finally {
        clearInterval(heartbeat);
      }
    },
  });
}

// =====================================================
// COMPATIBILITY / MANUAL PROCESSING ENTRY POINT
//
// Nếu có code test gọi trực tiếp jobId, hàm này tự claim atomically.
// Webhook production không dùng hàm này nữa.
// =====================================================

export async function processProductSyncJob({
  jobId,
  admin,
}: ProcessProductSyncJobInput) {
  const claimedJob = await claimProductSyncJob(jobId);

  if (claimedJob) {
    return processClaimedProductSyncJob({
      job: claimedJob,
      admin,
    });
  }

  const current = await getProductSyncJob(jobId);

  if (!current) {
    throw new Error(`AI Search sync job not found: ${jobId}`);
  }

  if (current.status === PRODUCT_SYNC_JOB_STATUS.done) {
    return {
      jobId: current.id,
      status: PRODUCT_SYNC_JOB_STATUS.done,
      skipped: true,
    } as const;
  }

  return {
    jobId: current.id,
    status: current.status,
    skipped: true,
  } as const;
}
