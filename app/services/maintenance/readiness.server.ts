import db from "../../db.server";
import { QDRANT_COLLECTION, VECTOR_SIZE } from "../search/qdrant.server";
import { positiveMs, readinessState, workerCheck, type ReadinessCheck } from "./readiness-policy";

type Status = ReadinessCheck;
let cached: { expires: number; status: Status } | null = null;
let inFlight: Promise<Status> | null = null;
async function qdrantStatus(): Promise<Status> {
  if (cached && cached.expires > Date.now()) return cached.status;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    let status: Status = "UNKNOWN";
    try {
      const url = process.env.QDRANT_URL;
      if (url) {
        const response = await fetch(`${url.replace(/\/$/, "")}/collections/${encodeURIComponent(QDRANT_COLLECTION)}`, { headers: { "api-key": process.env.QDRANT_API_KEY ?? "" }, signal: AbortSignal.timeout(2500) });
        if (response.ok) {
          const body = await response.json() as { result?: { status?: string; config?: { params?: { vectors?: { dense?: { size?: number; distance?: string } }; sparse_vectors?: { bm25?: { modifier?: string } } } } } };
          const params = body.result?.config?.params;
          status = body.result?.status !== "red" && params?.vectors?.dense?.size === VECTOR_SIZE
            && params.vectors.dense.distance === "Cosine" && params.sparse_vectors?.bm25?.modifier?.toLowerCase() === "idf" ? "PASS" : "DEGRADED";
        } else { status = "DEGRADED"; }
      }
    } catch { status = "DEGRADED"; }
    cached = { status, expires: Date.now() + 30000 };
    return status;
  })();
  try { return await inFlight; } finally { inFlight = null; }
}

export async function getReadiness() {
  let database: Status = "DEGRADED";
  let productWorker: Status = "UNKNOWN";
  let catalogWorker: Status = "UNKNOWN";
  let queue: Status = "UNKNOWN";
  let queueEvidence: { productPending: number; catalogPending: number; productStaleProcessing: number; catalogStaleProcessing: number } | null = null;
  const workersDisabled = ["0", "false", "off", "no"].includes(process.env.AI_SEARCH_BACKGROUND_WORKERS_ENABLED?.trim().toLowerCase() ?? "");
  try {
    await db.$queryRaw`SELECT 1`;
    database = "PASS";
    const now = new Date();
    const leases = await db.aiSearchLeaseLock.findMany({ where: { shop: "__system__", resource: { in: ["health:worker:product", "health:worker:catalog"] } }, select: { resource: true, leaseUntil: true } });
    const status = (name: string): Status => {
      const lease = leases.find((row) => row.resource === `health:worker:${name}`);
      return workerCheck(workersDisabled, lease?.leaseUntil, now);
    };
    productWorker = status("product"); catalogWorker = status("catalog");
    const cutoff = new Date(Date.now() - 15 * 60000);
    const stuck = await Promise.all([
      db.aiSearchSyncJob.count({ where: { status: "PENDING", createdAt: { lt: cutoff } } }),
      db.aiSearchCatalogSyncJob.count({ where: { status: "PENDING", createdAt: { lt: cutoff } } }),
      db.aiSearchSyncJob.count({ where: { status: "PROCESSING", updatedAt: { lte: new Date(now.getTime() - positiveMs(process.env.AI_SEARCH_SYNC_LEASE_MS, 120000)) } } }),
      db.aiSearchCatalogSyncJob.count({ where: { status: "PROCESSING", updatedAt: { lte: new Date(now.getTime() - positiveMs(process.env.AI_SEARCH_CATALOG_LEASE_MS, 300000)) } } }),
    ]);
    queueEvidence = { productPending: stuck[0], catalogPending: stuck[1], productStaleProcessing: stuck[2], catalogStaleProcessing: stuck[3] };
    queue = stuck.some((count) => count > 0) ? "DEGRADED" : "PASS";
  } catch { /* Never claim health when dependency checks failed. */ }
  const qdrant = await qdrantStatus();
  const checks = { database, qdrant, productWorker, catalogWorker, queue, shopify: "UNKNOWN", aiProviders: "UNKNOWN" };
  const status = readinessState([database, qdrant, productWorker, catalogWorker, queue]);
  return { status, checks, queueEvidence, processRole: process.env.AI_SEARCH_PROCESS_ROLE ?? "all", timestamp: new Date().toISOString(), scope: "Persisted worker poll leases (including separate workers), pending age and stale processing checkpoints. Polling is not proof of job completion. Missing leases may mean an old process needs restart. Shopify/provider health is not actively probed." };
}
