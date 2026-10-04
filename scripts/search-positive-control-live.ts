import fs from "node:fs";
import path from "node:path";

const baseUrl = process.env.AI_SEARCH_POSITIVE_TEST_URL || "http://localhost:57300/dev/proxy-e2e";
const queries = [
  "waterproof jacket",
  "fixed gear bicycle",
  "power bank",
  "analog watch",
  "digital watch",
  "cycling computer",
  "bluetooth speaker",
  "headlamp",
  "camp stool",
  "mug",
  "backpack",
  "scarf",
  "hoodie",
  "loafers",
  "running shoes",
  "sunglasses",
  "dress",
  "tote bag",
  "necklace",
  "bracelet",
];

type Row = {
  query: string;
  status: string;
  total: number | null;
  searchLogId: string | null;
  reason: string | null;
  ms: number;
  pass: boolean;
};

async function run(query: string): Promise<Row> {
  const startedAt = Date.now();
  try {
    const response = await fetch(baseUrl + "?q=" + encodeURIComponent(query));
    const body = await response.json() as any;
    const total = Number.isFinite(body?.pagination?.total_products)
      ? Number(body.pagination.total_products)
      : null;
    return {
      query,
      status: body?.status ?? String(response.status),
      total,
      searchLogId: body?.search_log_id ?? null,
      reason: body?.reason ?? null,
      ms: Date.now() - startedAt,
      pass: response.ok && typeof total === "number" && total > 0,
    };
  } catch (error) {
    return {
      query,
      status: "ERROR",
      total: null,
      searchLogId: null,
      reason: error instanceof Error ? error.message : String(error),
      ms: Date.now() - startedAt,
      pass: false,
    };
  }
}

const rows: Row[] = [];
for (const query of queries) {
  const row = await run(query);
  rows.push(row);
  console.log(JSON.stringify(row));
}

const summary = {
  total: rows.length,
  passed: rows.filter((row) => row.pass).length,
  failed: rows.filter((row) => !row.pass).length,
  failures: rows.filter((row) => !row.pass),
};
console.log("SUMMARY " + JSON.stringify(summary));

const outputPath = path.resolve(".tmp/search-positive-control-live-results.json");
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, JSON.stringify({ summary, rows }, null, 2), "utf8");

if (summary.failed > 0) process.exitCode = 1;
