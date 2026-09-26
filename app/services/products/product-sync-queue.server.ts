import { unauthenticated } from "../../shopify.server";
import {
  claimNextProductSyncJob,
  getProductSyncJob,
  markProductSyncJobFailed,
  PRODUCT_SYNC_JOB_STATUS,
} from "./product-sync-job.server";

type ProductSyncQueueState = {
  running: boolean;
  scheduled: boolean;
  rerunRequested: boolean;
  timerStarted: boolean;
};

const globalQueue = globalThis as typeof globalThis & {
  aiSearchProductSyncQueueState?: ProductSyncQueueState;
};

const queueState =
  globalQueue.aiSearchProductSyncQueueState ??
  (globalQueue.aiSearchProductSyncQueueState = {
    running: false,
    scheduled: false,
    rerunRequested: false,
    timerStarted: false,
  });

function readPositiveInteger(name: string, fallback: number) {
  const raw = process.env[name];

  if (!raw) {
    return fallback;
  }

  const value = Number.parseInt(raw, 10);

  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

const QUEUE_POLL_MS = readPositiveInteger(
  "AI_SEARCH_SYNC_QUEUE_POLL_MS",
  60_000,
);

const QUEUE_MAX_JOBS_PER_DRAIN = readPositiveInteger(
  "AI_SEARCH_SYNC_QUEUE_BATCH_SIZE",
  10,
);

async function processNextProductSyncJob() {
  const job = await claimNextProductSyncJob();

  if (!job) {
    return false;
  }

  try {
    let admin = null;

    if (job.topic !== "PRODUCTS_DELETE") {
      const context = await unauthenticated.admin(job.shop);
      admin = context.admin;
    }

    // Lazy-load phần Shopify product/Qdrant/OpenAI chỉ khi thực sự có job.
    // Nhờ vậy worker bootstrap không làm app fail startup chỉ vì một service
    // downstream tạm thời chưa sẵn sàng.
    const { processClaimedProductSyncJob } =
      await import("./product-sync-job-processor.server");

    await processClaimedProductSyncJob({
      job,
      admin,
    });
  } catch (error) {
    // processClaimedProductSyncJob tự mark FAILED khi lỗi trong work.
    // Lỗi tạo offline Admin context xảy ra trước processor nên phải
    // chuyển job về FAILED ở đây để lease không bị kẹt.
    const latest = await getProductSyncJob(job.id);

    let latestStatus = latest?.status ?? null;

    if (latest?.status === PRODUCT_SYNC_JOB_STATUS.processing) {
      await markProductSyncJobFailed(job.id, job.attempts, error);
      latestStatus = PRODUCT_SYNC_JOB_STATUS.failed;
    }

    console.error("[AI Search] Queue job execution failed:", {
      jobId: job.id,
      shop: job.shop,
      topic: job.topic,
      productId: job.productId,
      status: latestStatus,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return true;
}

export async function drainProductSyncQueue(options?: { maxJobs?: number }) {
  if (queueState.running) {
    queueState.rerunRequested = true;

    return {
      processed: 0,
      alreadyRunning: true,
    };
  }

  queueState.running = true;

  const maxJobs = Math.max(
    1,
    Math.min(options?.maxJobs ?? QUEUE_MAX_JOBS_PER_DRAIN, 100),
  );

  let processed = 0;
  let hitBatchLimit = false;

  try {
    while (processed < maxJobs) {
      const foundJob = await processNextProductSyncJob();

      if (!foundJob) {
        break;
      }

      processed += 1;
    }

    hitBatchLimit = processed >= maxJobs;

    return {
      processed,
      alreadyRunning: false,
    };
  } finally {
    queueState.running = false;

    const shouldRerun = queueState.rerunRequested || hitBatchLimit;

    queueState.rerunRequested = false;

    if (shouldRerun) {
      kickProductSyncQueue();
    }
  }
}

export function kickProductSyncQueue() {
  if (queueState.running) {
    queueState.rerunRequested = true;
    return;
  }

  if (queueState.scheduled) {
    return;
  }

  queueState.scheduled = true;

  const timer = setTimeout(() => {
    queueState.scheduled = false;

    void drainProductSyncQueue().catch((error) => {
      console.error(
        "[AI Search] Queue drain failed:",
        error instanceof Error ? error.message : String(error),
      );
    });
  }, 0);

  timer.unref?.();
}

export function startProductSyncQueueWorker() {
  if (queueState.timerStarted) {
    return;
  }

  queueState.timerStarted = true;

  const timer = setInterval(() => {
    kickProductSyncQueue();
  }, QUEUE_POLL_MS);

  timer.unref?.();

  // Recover PENDING / FAILED / stale PROCESSING jobs as soon as this
  // server process is ready, không cần chờ webhook mới.
  kickProductSyncQueue();
}
