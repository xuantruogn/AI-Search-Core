import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { catalogPage, quotaPercentage } from "../app/services/admin/data-presentation";
import { getDailySearchMetrics, sumSearchMetrics } from "../app/services/search/search-metrics.server";
import { formatPlanMoney } from "../app/services/commerce/money";
import db from "../app/db.server";

for (const bad of ["NaN", "abc", "1.5", "1x", "-1", "0", "Infinity", "9007199254740992"]) assert.equal(catalogPage(bad, 200, 50), 1);
assert.equal(catalogPage("999", 121, 50), 3);
assert.equal(catalogPage("2", 0, 50), 1);
assert.equal(quotaPercentage(0, 0), 100);
assert.equal(quotaPercentage(50, 0), 100);
assert.equal(quotaPercentage(150, 100), 100);
assert.equal(quotaPercentage(25, 100), 25);
assert.equal(formatPlanMoney(9.9, "USD"), "$9.90");
const aggregate = sumSearchMetrics([{ date: "2026-10-01", searches: 20001, clickedSearches: 501, clicks: 750, rankTotal: 1500 }, { date: "2026-10-02", searches: 30, clickedSearches: 5, clicks: 7, rankTotal: 10 }]);
assert.equal(aggregate.searches, 20031);
assert.equal(aggregate.clickedSearches, 506);
assert.equal(sumSearchMetrics([]).searches, 0);
const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const analytics = source("app/routes/app.search-analytics.tsx");
assert.ok(analytics.indexOf("await authenticate.admin(request)") < analytics.indexOf("  try {", analytics.indexOf("export const loader")));
assert.ok(analytics.includes('dataState: "UNAVAILABLE"'));
assert.ok(analytics.includes("if (error instanceof Response) throw error"));
assert.ok(analytics.includes('status: 503'));
assert.ok(analytics.includes('role="alert"'));
const catalog = source("app/routes/app.catalog-sync.tsx");
assert.ok(!catalog.includes("initialData.job.status"));
assert.ok(!catalog.includes("initialData.job.lastError"));
assert.ok(catalog.includes("statusFetcher.data ? statusFetcher.data.job : initialData.job"));
assert.ok(source("app/routes/app.usage.tsx").includes("periodId: entitlement.usage.id"));
assert.ok(!source("app/routes/app._index.tsx").includes('vip-alert-check-item__ok">✓'));
assert.ok(!source("app/routes/_index/route.tsx").includes('price: "$9.90"'));
console.log("PASS data-bound UI fixture/source regressions (not browser chaos tests)");

const liveShop = process.argv.find((arg) => arg.startsWith("--shop="))?.slice(7);
if (liveShop) {
  try {
    const start = new Date("2026-01-01T00:00:00Z"); const end = new Date();
    const metrics = sumSearchMetrics(await getDailySearchMetrics(liveShop, start, end));
    const where = { shop: liveShop, createdAt: { gte: start, lte: end } };
    const [count, clicked] = await Promise.all([db.aiSearchQueryLog.count({ where }), db.aiSearchQueryLog.count({ where: { ...where, clicks: { some: { shop: liveShop } } } })]);
    assert.equal(metrics.searches, count);
    assert.equal(metrics.clickedSearches, clicked);
    console.log("PASS read-only live SQL/Prisma count parity", { searches: count, clickedSearches: clicked });
  } finally { await db.$disconnect(); }
}
