import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { csvCell, csvRow, historyFilters } from "../app/services/admin/search-history-export";
import { workerCheck, readinessState } from "../app/services/maintenance/readiness-policy";
import { cursorBatches } from "../app/services/search/analytics-batches.server";
import { modelCostMicros } from "../app/services/ai/model-cost-rates";
import { enqueueTelemetry, replayTelemetry, telemetryKey } from "../app/services/ai/telemetry-outbox.server";
import { withSearchAttempt, currentSearchAttempt, patchSearchAttempt, attemptStatus } from "../app/services/search/search-attempt-context.server";
import db from "../app/db.server";
import { getMerchantSearchClusters } from "../app/services/search/search-analytics.server";
import { getSearchImpactSnapshot } from "../app/services/search/search-impact.server";
import { getDevDashboardData } from "../app/services/admin/dev-dashboard.server";

for (const value of ["=SUM(A1)", "+1", "-1", "@SUM(A1)", " \t=HYPERLINK()", "\nhello"]) assert.ok(csvCell(value).startsWith('"\''));
assert.equal(csvCell('normal "quoted" text'), '"normal ""quoted"" text"');
assert.equal(csvRow(["a", null]), '"a",""\r\n');
const filtered = historyFilters(new URLSearchParams("shop=a.myshopify.com&from=2026-10-01&to=2026-10-10&resultStatus=ZERO_RESULTS"));
assert.equal(filtered.where.shop, "a.myshopify.com");
assert.equal(filtered.where.resultCount, 0);
assert.equal((filtered.where.createdAt as { lt: Date }).lt.toISOString(), "2026-10-11T00:00:00.000Z");
for (const invalid of ["from=2026-02-30", "from=abc", "from=2026-10-11&to=2026-10-10", "resultStatus=native"]) assert.throws(() => historyFilters(new URLSearchParams(invalid)), (error) => error instanceof Response && error.status === 400);
assert.equal(workerCheck(true, new Date(Date.now() + 1000), new Date()), "DISABLED");
assert.equal(workerCheck(false, undefined, new Date()), "UNKNOWN");
assert.equal(workerCheck(false, new Date(0), new Date()), "DEGRADED");
assert.equal(readinessState(["PASS", "UNKNOWN"]), "UNKNOWN");
assert.equal(readinessState(["PASS", "DEGRADED", "UNKNOWN"]), "NOT_READY");
assert.equal(readinessState(["PASS", "DISABLED"]), "NOT_READY");
assert.equal(readinessState(["PASS", "PASS"]), "READY");

let processed = 0; let pages = 0;
for await (const rows of cursorBatches(async (cursor) => {
  const offset = cursor ? Number(cursor.id) + 1 : 0;
  return Array.from({ length: Math.max(0, Math.min(250, 20501 - offset)) }, (_, i) => ({ id: String(offset + i), createdAt: new Date("2026-10-01") }));
})) { assert.ok(rows.length <= 250); processed += rows.length; pages += 1; }
assert.equal(processed, 20501); assert.equal(pages, 83);

process.env.AI_SEARCH_MODEL_COST_RATES_JSON = JSON.stringify({ "OPENAI:test-model": { input: 1, cachedInput: 0.25, output: 2 } });
assert.equal(modelCostMicros("OPENAI", "test-model", 100, 20, 30), 145);
assert.equal(modelCostMicros("OPENAI", "unknown", 100, 0, 30), null);
assert.equal(modelCostMicros("GOOGLE_GEMINI", "test-model", 100, 0, 30), null);
process.env.AI_SEARCH_MODEL_COST_RATES_JSON = "invalid";
assert.equal(modelCostMicros("OPENAI", "test-model", 100, 0, 30), null);

process.env.AI_SEARCH_TELEMETRY_OUTBOX_DIR = await mkdtemp(path.join(tmpdir(), "ai-buyense-telemetry-"));
const key = telemetryKey("OPENAI", "EMBEDDING", "request-fixture");
assert.equal(key, telemetryKey("OPENAI", "EMBEDDING", "request-fixture"));
assert.notEqual(key, telemetryKey("GOOGLE_GEMINI", "EMBEDDING", "request-fixture"));
const event = { idempotencyKey: key, provider: "OPENAI", operation: "EMBEDDING", model: "test", requestId: "request-fixture", costEstimateStatus: "UNKNOWN_RATE" };
await enqueueTelemetry(event, async () => { throw new Error("DB outage"); });
assert.ok((await readdir(process.env.AI_SEARCH_TELEMETRY_OUTBOX_DIR)).includes(`${key}.json`));
const writes = new Map<string, unknown>();
const persist = async (record: typeof event) => { if (!writes.has(record.idempotencyKey)) writes.set(record.idempotencyKey, record); };
await replayTelemetry(persist as Parameters<typeof replayTelemetry>[0]);
assert.equal(writes.size, 1);
assert.equal((await readdir(process.env.AI_SEARCH_TELEMETRY_OUTBOX_DIR)).length, 0);
await replayTelemetry(persist as Parameters<typeof replayTelemetry>[0]);
assert.equal(writes.size, 1);

await Promise.all(["a", "b"].map((shop) => withSearchAttempt(async () => {
  patchSearchAttempt({ shop });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(currentSearchAttempt(shop)?.shop, shop);
  assert.equal(currentSearchAttempt(shop === "a" ? "b" : "a"), undefined);
  patchSearchAttempt({ shop: undefined }); // No synthetic merchant-DB writes.
  return Response.json({ ok: true });
})));
assert.equal(attemptStatus({ reason: "SEARCH_QUOTA_EXCEEDED", nativeFallback: true, cacheHit: false }), "QUOTA_BLOCKED");
assert.equal(attemptStatus({ nativeFallback: true, cacheHit: false }), "NATIVE_FALLBACK");
assert.equal(attemptStatus({ failureKind: "RETRIEVAL_ERROR", nativeFallback: true, cacheHit: false }), "RETRIEVAL_ERROR");
assert.equal(attemptStatus({ nativeFallback: false, cacheHit: true, resultCount: 2 }), "CACHE_HIT");
assert.equal(attemptStatus({ nativeFallback: false, cacheHit: true, resultCount: 0 }), "ZERO_RESULTS");
await assert.rejects(withSearchAttempt(async () => { throw new Response("Forbidden", { status: 403 }); }), (error) => error instanceof Response && error.status === 403);

const source = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
assert.ok(!source("app/services/search/search-analytics.server.ts").includes("take: 2_000"));
assert.ok(source("app/routes/dev.search-history-export.ts").includes('requireDevPermission(request, "shops.read")'));
assert.ok(source("app/services/ai/telemetry-outbox.server.ts").includes("idempotencyKey: key"));
const housekeeping = source("app/services/maintenance/housekeeping.server.ts");
assert.match(housekeeping, /DELETE FROM \\`AiSearchAttempt\\`\s+WHERE \\`createdAt\\` < \$\{queryLogCutoff\}\s+LIMIT \$\{limit\}/);
assert.match(housekeeping, /DELETE FROM \\`AiSearchTelemetryReceipt\\`\s+WHERE \\`expiresAt\\` < NOW\(3\)\s+LIMIT \$\{limit\}/);
assert.ok(source("app/services/ai/telemetry-outbox.server.ts").includes('throw new Error("STALE_TELEMETRY_ENVELOPE")'));
console.log("PASS system audit: CSV, whole-period cursor >20k, readiness, model rates, filesystem outbox DB-outage replay, context isolation (mock DB persistence; no production changes)");
const liveShop = process.argv.find((arg) => arg.startsWith("--live-shop="))?.slice(12);
if (liveShop) {
  const to = new Date(); const from = new Date("2026-01-01");
  const clusters = await getMerchantSearchClusters(liveShop, 365, { from, to });
  const count = await db.aiSearchQueryLog.count({ where: { shop: liveShop, createdAt: { gte: from, lte: to } } });
  assert.equal(clusters.reduce((sum, cluster) => sum + cluster.searchCount, 0), count);
  const snapshot = await getSearchImpactSnapshot(liveShop, { windowDays: 90 });
  assert.equal(snapshot.series.reduce((sum, day) => sum + day.searches, 0), snapshot.ai.searches);
  const dashboard = await getDevDashboardData();
  console.log("PASS read-only local aggregation", { searches: count, clusters: clusters.length, anomalies: snapshot.anomalyCounts, readiness: dashboard.readiness.status, attemptRequests: dashboard.attemptMetrics.proxyRequests, unknownCostRequests: dashboard.provider.unknownCostRequests });
}
await db.$disconnect();
