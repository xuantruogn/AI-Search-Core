const GEMINI_GENERATE_CONTENT_BASE =
  "https://generativelanguage.googleapis.com/v1beta/models";

type GeminiPart = {
  text?: string;
  thought?: boolean;
};

type GeminiGenerateContentResponse = {
  candidates?: Array<{
    content?: { parts?: GeminiPart[] };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    cachedContentTokenCount?: number;
    totalTokenCount?: number;
  };
  responseId?: string;
};

export type GeminiStructuredResult = {
  status: "completed" | "incomplete";
  outputText: string;
  finishReason: string | null;
  requestId: string | null;
  usage: {
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
};

function readNonNegativeInteger(name: string, fallback: number) {
  const value = Number.parseInt(process.env[name] || "", 10);
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

type GeminiThinkingLevel = "minimal" | "low" | "medium" | "high";

function readThinkingLevel(): GeminiThinkingLevel {
  const value = process.env.GEMINI_QUERY_THINKING_LEVEL?.trim().toLowerCase();
  return value === "low" || value === "medium" || value === "high"
    ? value
    : "minimal";
}

function safeTokenCount(value: number | null | undefined) {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value ?? 0)) : 0;
}

function assertSafeModelName(model: string) {
  if (!/^[a-zA-Z0-9._-]+$/.test(model)) {
    throw new Error("Invalid Gemini query rewrite model name.");
  }
}

export function getGeminiQueryRewriteModel() {
  return (
    process.env.GEMINI_QUERY_REWRITE_MODEL?.trim() ||
    "gemini-3.5-flash-lite"
  );
}

let geminiWarmupPromise: Promise<void> | null = null;
let geminiWarmupCompletedAt = 0;

export function warmGeminiConnection() {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) return Promise.resolve();

  const now = Date.now();
  if (now - geminiWarmupCompletedAt < 5 * 60 * 1000) {
    return Promise.resolve();
  }
  if (geminiWarmupPromise) return geminiWarmupPromise;

  const model = getGeminiQueryRewriteModel();
  assertSafeModelName(model);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2_000);
  const startedAt = now;

  geminiWarmupPromise = fetch(
    `${GEMINI_GENERATE_CONTENT_BASE}/${model}`,
    {
      method: "GET",
      headers: { "x-goog-api-key": apiKey },
      signal: controller.signal,
    },
  )
    .then(async (response) => {
      if (!response.ok) {
        const detail = await readGeminiError(response);
        throw new Error(`Gemini warmup ${response.status}: ${detail}`);
      }
      geminiWarmupCompletedAt = Date.now();
      console.log("[AI Search][PERF] Gemini connection warmup complete", {
        model,
        durationMs: geminiWarmupCompletedAt - startedAt,
      });
    })
    .catch((error) => {
      console.warn("[AI Search][PERF] Gemini connection warmup failed", {
        model,
        error: error instanceof Error ? error.message : String(error),
      });
    })
    .finally(() => {
      clearTimeout(timeout);
      geminiWarmupPromise = null;
    });

  return geminiWarmupPromise;
}

export function parseGeminiStructuredResponse(
  payload: GeminiGenerateContentResponse,
  requestId: string | null,
): GeminiStructuredResult {
  const candidate = payload.candidates?.[0];
  const finishReason = candidate?.finishReason ?? null;
  const outputText = (candidate?.content?.parts ?? [])
    .filter((part) => part.thought !== true && typeof part.text === "string")
    .map((part) => part.text ?? "")
    .join("")
    .trim();
  const usage = payload.usageMetadata;
  const inputTokens = safeTokenCount(usage?.promptTokenCount);
  const cachedInputTokens = safeTokenCount(usage?.cachedContentTokenCount);
  const outputTokens =
    safeTokenCount(usage?.candidatesTokenCount) +
    safeTokenCount(usage?.thoughtsTokenCount);

  return {
    status: finishReason === "STOP" && outputText ? "completed" : "incomplete",
    outputText,
    finishReason,
    requestId: payload.responseId ?? requestId,
    usage: {
      inputTokens,
      cachedInputTokens,
      outputTokens,
      totalTokens: safeTokenCount(
        usage?.totalTokenCount ?? inputTokens + outputTokens,
      ),
    },
  };
}

async function readGeminiError(response: Response) {
  const body = await response.text();
  try {
    const parsed = JSON.parse(body) as {
      error?: { message?: string; status?: string };
    };
    return parsed.error?.message || parsed.error?.status || body.slice(0, 500);
  } catch {
    return body.slice(0, 500);
  }
}

export async function generateGeminiQueryRewrite({
  model,
  instructions,
  input,
  schema,
  maxOutputTokens,
  timeoutMs,
  complexityRoute,
}: {
  model: string;
  instructions: string;
  input: string;
  schema: Record<string, unknown>;
  maxOutputTokens: number;
  timeoutMs: number;
  complexityRoute: "SIMPLE" | "COMPLEX";
}): Promise<GeminiStructuredResult> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not configured.");
  }
  assertSafeModelName(model);

  const isGemini3 = /^gemini-3(?:[._-]|$)/i.test(model);
  const thinkingBudget = readNonNegativeInteger(
    complexityRoute === "SIMPLE"
      ? "GEMINI_QUERY_SIMPLE_THINKING_BUDGET"
      : "GEMINI_QUERY_COMPLEX_THINKING_BUDGET",
    0,
  );
  const generationConfig: Record<string, unknown> = {
    responseMimeType: "application/json",
    responseJsonSchema: schema,
    maxOutputTokens: isGemini3
      ? maxOutputTokens
      : maxOutputTokens + thinkingBudget,
    thinkingConfig: isGemini3
      ? { thinkingLevel: readThinkingLevel() }
      : { thinkingBudget },
    // Query planning is a structured classification/extraction task. Keep
    // generation deterministic so identical shopper queries do not randomly
    // change expansions/MUST terms across otherwise identical searches.
    temperature: 0,
    seed: readNonNegativeInteger("GEMINI_QUERY_SEED", 17),
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(
      `${GEMINI_GENERATE_CONTENT_BASE}/${model}:generateContent`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{ text: instructions }],
          },
          contents: [
            {
              role: "user",
              parts: [{ text: input }],
            },
          ],
          generationConfig,
        }),
        signal: controller.signal,
      },
    );

    if (!response.ok) {
      const detail = await readGeminiError(response);
      throw new Error(`Gemini API ${response.status}: ${detail}`);
    }

    const payload = (await response.json()) as GeminiGenerateContentResponse;
    return parseGeminiStructuredResponse(
      payload,
      response.headers.get("x-request-id"),
    );
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      const timeoutError = new Error(`Gemini request timed out after ${timeoutMs}ms.`);
      timeoutError.name = "GeminiTimeoutError";
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
