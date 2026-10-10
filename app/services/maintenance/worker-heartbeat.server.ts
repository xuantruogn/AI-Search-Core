import db from "../../db.server";
const lastWrites = new Map<string, number>();

// System-only lease records, not per-shop work locks. Proves polling is alive,
// not that a job completed or an external provider is healthy.
export function recordWorkerPoll(worker: "product" | "catalog", pollMs = 60000) {
  const now = Date.now();
  if (now - (lastWrites.get(worker) ?? 0) < 15000) return;
  lastWrites.set(worker, now);
  const leaseUntil = new Date(now + Math.max(180000, pollMs * 3));
  void db.aiSearchLeaseLock.upsert({
    where: { shop_resource: { shop: "__system__", resource: `health:worker:${worker}` } },
    create: { shop: "__system__", resource: `health:worker:${worker}`, ownerToken: `pid:${process.pid}`, leaseUntil },
    update: { ownerToken: `pid:${process.pid}`, leaseUntil },
  }).catch(() => { lastWrites.delete(worker); console.error("[Worker health] Heartbeat write failed", { worker }); });
}
