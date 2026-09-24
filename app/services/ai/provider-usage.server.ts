import db from "../../db.server";

export type OpenAiOperation =
  | "QUERY_REWRITE"
  | "QUERY_EMBEDDING"
  | "PRODUCT_ENRICHMENT"
  | "PRODUCT_EMBEDDING"
  | "EMBEDDING";

type RecordOpenAiUsageInput = {
  shop?: string | null;
  operation: OpenAiOperation;
  model: string;
  requestId?: string | null;
  inputTokens?: number | null;
  cachedInputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
  headers?: Headers | null;
};

function envPrice(name: string, fallback: number) {
  const value = Number.parseFloat(process.env[name] ?? "");
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function safeTokenCount(value: number | null | undefined) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value ?? 0));
}

function headerInteger(headers: Headers | null | undefined, name: string) {
  const raw = headers?.get(name);
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

export function estimateOpenAiCostMicros({
  operation,
  inputTokens,
  cachedInputTokens,
  outputTokens,
}: {
  operation: OpenAiOperation;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}) {
  if (operation === "QUERY_EMBEDDING" || operation === "PRODUCT_EMBEDDING" || operation === "EMBEDDING") {
    const inputPerMillion = envPrice("OPENAI_EMBEDDING_INPUT_USD_PER_1M", 0.02);
    return Math.max(0, Math.round((inputTokens / 1_000_000) * inputPerMillion * 1_000_000));
  }

  const normalInputPerMillion = envPrice("OPENAI_LLM_INPUT_USD_PER_1M", 0.40);
  const cachedInputPerMillion = envPrice("OPENAI_LLM_CACHED_INPUT_USD_PER_1M", 0.10);
  const outputPerMillion = envPrice("OPENAI_LLM_OUTPUT_USD_PER_1M", 1.60);

  const cached = Math.min(inputTokens, cachedInputTokens);
  const uncached = Math.max(0, inputTokens - cached);
  const usd =
    (uncached / 1_000_000) * normalInputPerMillion +
    (cached / 1_000_000) * cachedInputPerMillion +
    (outputTokens / 1_000_000) * outputPerMillion;

  return Math.max(0, Math.round(usd * 1_000_000));
}

export async function recordOpenAiUsage(input: RecordOpenAiUsageInput) {
  const inputTokens = safeTokenCount(input.inputTokens);
  const cachedInputTokens = safeTokenCount(input.cachedInputTokens);
  const outputTokens = safeTokenCount(input.outputTokens);
  const totalTokens = safeTokenCount(
    input.totalTokens ?? inputTokens + outputTokens,
  );

  await db.aiSearchApiUsageEvent.create({
    data: {
      shop: input.shop?.trim() || null,
      provider: "OPENAI",
      operation: input.operation,
      model: input.model,
      requestId: input.requestId ?? null,
      inputTokens,
      cachedInputTokens,
      outputTokens,
      totalTokens,
      estimatedCostMicros: estimateOpenAiCostMicros({
        operation: input.operation,
        inputTokens,
        cachedInputTokens,
        outputTokens,
      }),
      remainingRequests: headerInteger(
        input.headers,
        "x-ratelimit-remaining-requests",
      ),
      remainingTokens: headerInteger(
        input.headers,
        "x-ratelimit-remaining-tokens",
      ),
      resetRequests:
        input.headers?.get("x-ratelimit-reset-requests") ?? null,
      resetTokens:
        input.headers?.get("x-ratelimit-reset-tokens") ?? null,
    },
  });
}

/**
 * Telemetry must never turn a successful customer search/index operation into
 * an error. Fire-and-forget keeps the hot path fast; failures are visible in
 * server logs and can be reconciled later if needed.
 */
export function recordOpenAiUsageSafe(input: RecordOpenAiUsageInput) {
  void recordOpenAiUsage(input).catch((error) => {
    console.error("[AI Search] OpenAI usage telemetry write failed", {
      shop: input.shop ?? null,
      operation: input.operation,
      model: input.model,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}
