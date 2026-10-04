import fs from "node:fs";
import path from "node:path";

const baseUrl = process.env.AI_SEARCH_NEGATIVE_TEST_URL || "http://localhost:57300/dev/proxy-e2e";

const directQueries = [
  "mechanical keyboard",
  "gaming mouse",
  "computer monitor",
  "printer",
  "scanner",
  "webcam",
  "wifi router",
  "external hard drive",
  "camera lens",
  "smart speaker",
  "projector",
  "gaming chair",
  "desk lamp",
  "air fryer",
  "microwave oven",
  "refrigerator",
  "rice cooker",
  "vacuum cleaner",
  "hair dryer",
  "electric toothbrush",
];

const semanticQueries = [
  "I need to print paper documents from my computer at home",
  "I want to scan paper receipts and save them as digital files",
  "I need a screen for my desktop computer so I can work with a larger display",
  "I need a camera for video calls on my desktop computer",
  "I want to project a movie onto a blank wall in my living room",
  "I need a device that stores computer files externally and connects by USB",
  "I want to take aerial photos with a remotely controlled flying camera",
  "I need a speaker that can play music wirelessly and respond to voice commands",
  "I need a chair with strong lumbar support for sitting at my desk for eight hours",
  "I need a small light for my work desk so I can read at night",
  "I want a countertop appliance that cooks fries with circulating hot air and very little oil",
  "I need to heat leftover food quickly without using a stove",
  "I need an appliance that keeps fresh food cold and frozen food below freezing",
  "I want something that cooks rice automatically and switches to keep-warm when finished",
  "I need a machine that removes dust and crumbs from floors using suction",
  "I need something that dries wet hair quickly after a shower",
  "I want to clean my teeth with a rechargeable vibrating brush",
  "I need a device that adds moisture to dry bedroom air while I sleep",
  "I want to remove smoke pollen and fine particles from the air inside my room",
  "I need a machine that washes dirty clothes automatically with water and detergent",
];

type Row = {
  kind: "DIRECT" | "SEMANTIC";
  query: string;
  status: string;
  total: number | null;
  searchLogId: string | null;
  reason: string | null;
  ms: number;
  pass: boolean;
};

async function run(kind: Row["kind"], query: string): Promise<Row> {
  const startedAt = Date.now();
  try {
    const response = await fetch(baseUrl + "?q=" + encodeURIComponent(query));
    const body = await response.json() as any;
    const total = Number.isFinite(body?.pagination?.total_products)
      ? Number(body.pagination.total_products)
      : null;
    return {
      kind,
      query,
      status: body?.status ?? String(response.status),
      total,
      searchLogId: body?.search_log_id ?? null,
      reason: body?.reason ?? null,
      ms: Date.now() - startedAt,
      pass: response.ok && total === 0,
    };
  } catch (error) {
    return {
      kind,
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
for (const query of directQueries) {
  const row = await run("DIRECT", query);
  rows.push(row);
  console.log(JSON.stringify(row));
}
for (const query of semanticQueries) {
  const row = await run("SEMANTIC", query);
  rows.push(row);
  console.log(JSON.stringify(row));
}

const directPass = rows.filter((row) => row.kind === "DIRECT" && row.pass).length;
const semanticPass = rows.filter((row) => row.kind === "SEMANTIC" && row.pass).length;
const summary = {
  total: rows.length,
  passed: rows.filter((row) => row.pass).length,
  failed: rows.filter((row) => !row.pass).length,
  direct: { passed: directPass, total: directQueries.length },
  semantic: { passed: semanticPass, total: semanticQueries.length },
  falsePositives: rows
    .filter((row) => !row.pass && (row.total ?? 0) > 0)
    .map((row) => ({ kind: row.kind, query: row.query, total: row.total, searchLogId: row.searchLogId })),
};
console.log("SUMMARY " + JSON.stringify(summary));

const outputPath = path.resolve(".tmp/search-negative-control-live-results.json");
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, JSON.stringify({ summary, rows }, null, 2), "utf8");

if (summary.failed > 0) process.exitCode = 1;
