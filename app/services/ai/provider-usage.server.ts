import { randomUUID } from "node:crypto";
import { enqueueTelemetry, telemetryKey } from "./telemetry-outbox.server";
import { modelCostMicros } from "./model-cost-rates";

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

type RecordGeminiUsageInput = Omit<RecordOpenAiUsageInput, "headers">;

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

export async function recordOpenAiUsage(input: RecordOpenAiUsageInput) {
  const inputTokens = safeTokenCount(input.inputTokens);
  const cachedInputTokens = safeTokenCount(input.cachedInputTokens);
  const outputTokens = safeTokenCount(input.outputTokens);
  const totalTokens = safeTokenCount(
    input.totalTokens ?? inputTokens + outputTokens,
  );

  const requestId = input.requestId ?? input.headers?.get("x-request-id") ?? `local:${randomUUID()}`;
  const cost = modelCostMicros("OPENAI", input.model, inputTokens, cachedInputTokens, outputTokens);
  await enqueueTelemetry({
      idempotencyKey: telemetryKey("OPENAI", input.operation, requestId),
      costEstimateStatus: cost === null ? "UNKNOWN_RATE" : "CONFIGURED_ESTIMATE",
      shop: input.shop?.trim() || null,
      provider: "OPENAI",
      operation: input.operation,
      model: input.model,
      requestId,
      inputTokens,
      cachedInputTokens,
      outputTokens,
      totalTokens,
      estimatedCostMicros: cost ?? 0,
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
  });
}

/**
 * Telemetry must never turn a successful customer search/index operation into
 * an error. Callers await the durable local write, not the database retry.
 * A disk failure is explicitly logged; it is never fabricated into usage.
 */
export async function recordOpenAiUsageSafe(input: RecordOpenAiUsageInput) {
  await recordOpenAiUsage(input).catch(() => {
    console.error("[AI Search] OpenAI usage telemetry write failed", {
      shop: input.shop ?? null,
      operation: input.operation,
      model: input.model,
      state: "DURABLE_WRITE_FAILED",
    });
  });
}

export async function recordGeminiUsage(input: RecordGeminiUsageInput) {
  const inputTokens = safeTokenCount(input.inputTokens);
  const cachedInputTokens = safeTokenCount(input.cachedInputTokens);
  const outputTokens = safeTokenCount(input.outputTokens);
  const totalTokens = safeTokenCount(
    input.totalTokens ?? inputTokens + outputTokens,
  );

  const requestId = input.requestId ?? `local:${randomUUID()}`;
  const cost = modelCostMicros("GOOGLE_GEMINI", input.model, inputTokens, cachedInputTokens, outputTokens);
  await enqueueTelemetry({
      idempotencyKey: telemetryKey("GOOGLE_GEMINI", input.operation, requestId),
      costEstimateStatus: cost === null ? "UNKNOWN_RATE" : "CONFIGURED_ESTIMATE",
      shop: input.shop?.trim() || null,
      provider: "GOOGLE_GEMINI",
      operation: input.operation,
      model: input.model,
      requestId,
      inputTokens,
      cachedInputTokens,
      outputTokens,
      totalTokens,
      estimatedCostMicros: cost ?? 0,
      remainingRequests: null,
      remainingTokens: null,
      resetRequests: null,
      resetTokens: null,
  });
}

export async function recordGeminiUsageSafe(input: RecordGeminiUsageInput) {
  await recordGeminiUsage(input).catch(() => {
    console.error("[AI Search] Gemini usage telemetry write failed", {
      shop: input.shop ?? null,
      operation: input.operation,
      model: input.model,
      state: "DURABLE_WRITE_FAILED",
    });
  });
}
