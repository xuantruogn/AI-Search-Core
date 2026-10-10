import type { Prisma } from "@prisma/client";

export function historyFilters(params: URLSearchParams) {
  const shop = params.get("shop")?.trim() ?? "";
  const query = params.get("query")?.trim() ?? "";
  const llmStatus = params.get("llmStatus")?.trim() ?? "";
  const resultStatus = params.get("resultStatus") ?? "";
  const attemptStatus = params.get("attemptStatus") ?? "";
  if (!["", "STARTED", "SUCCESS", "CACHE_HIT", "ZERO_RESULTS", "NATIVE_FALLBACK", "QUOTA_BLOCKED", "AI_PROVIDER_ERROR", "RETRIEVAL_ERROR", "TIMEOUT", "PIPELINE_ERROR"].includes(attemptStatus)) throw new Response("Invalid attempt status", { status: 400 });
  if (!["", "HAS_RESULTS", "ZERO_RESULTS"].includes(resultStatus)) throw new Response("Invalid result status", { status: 400 });
  const date = (key: string) => {
    const raw = params.get(key) ?? "";
    if (!raw) return { raw, value: undefined };
    const value = new Date(`${raw}T00:00:00.000Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || !Number.isFinite(value.getTime()) || value.toISOString().slice(0, 10) !== raw) throw new Response("Invalid date", { status: 400 });
    return { raw, value };
  };
  const from = date("from"); const to = date("to");
  if (from.value && to.value && from.value > to.value) throw new Response("Invalid date range", { status: 400 });
  const where: Prisma.AiSearchQueryLogWhereInput = {
    ...(shop ? { shop } : {}), ...(llmStatus ? { llmStatus } : {}),
    ...(resultStatus ? { resultCount: resultStatus === "ZERO_RESULTS" ? 0 : { gt: 0 } } : {}),
    ...(from.value || to.value ? { createdAt: { gte: from.value, lt: to.value ? new Date(to.value.getTime() + 86400000) : undefined } } : {}),
    ...(query ? { OR: [{ query: { contains: query } }, { analyzedQuery: { contains: query } }, { llmExpandedQuery: { contains: query } }] } : {}),
  };
  return { shop, query, llmStatus, resultStatus, attemptStatus, from: from.raw, to: to.raw, where };
}

// Spreadsheet applications may interpret a quoted cell as a formula as well.
export function csvCell(value: unknown) {
  let text = value == null ? "" : String(value);
  if (/^[\s\uFEFF]*[=+\-@]/u.test(text) || /^[\t\r\n]/u.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
}

export function csvRow(values: unknown[]) { return values.map(csvCell).join(",") + "\r\n"; }
