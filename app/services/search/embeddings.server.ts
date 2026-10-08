import OpenAI from "openai";
import { Agent, fetch as undiciFetch } from "undici";
import { recordOpenAiUsageSafe } from "../ai/provider-usage.server";

let openaiClient: OpenAI | null = null;
let openaiApiKey: string | null = null;
let openaiClientCreatedAt = 0;
let openaiRequestCount = 0;
let openaiWarmupPromise: Promise<void> | null = null;
let openaiWarmupCompletedAt = 0;
let openaiWarmupAttemptedAt = 0;
const openaiDispatcher = new Agent({
  connections: 8,
  pipelining: 1,
  keepAliveTimeout: 60_000,
  keepAliveMaxTimeout: 10 * 60_000,
  connect: {
    autoSelectFamily: true,
    autoSelectFamilyAttemptTimeout: 250,
  },
});

export function isOpenAiConfigured() {
  return Boolean(process.env.OPENAI_API_KEY?.trim());
}

export function getOpenAiClient() {
  const apiKey = process.env.OPENAI_API_KEY?.trim();

  if (!apiKey) {
    throw new Error("Missing OPENAI_API_KEY environment variable");
  }

  // Shopify CLI can reload .env during development. Recreate the client when
  // the key changes instead of freezing the value at module-import time.
  if (!openaiClient || openaiApiKey !== apiKey) {
    openaiClient = new OpenAI({
      apiKey,
      fetch: undiciFetch as unknown as typeof globalThis.fetch,
      fetchOptions: { dispatcher: openaiDispatcher },
      maxRetries: 0,
    });
    openaiApiKey = apiKey;
    openaiClientCreatedAt = Date.now();
    openaiRequestCount = 0;
  }

  return openaiClient;
}

export function getEmbeddingModel() {
  return process.env.OPENAI_EMBEDDING_MODEL?.trim() || "text-embedding-3-small";
}

export function getEmbeddingDimensions() {
  const model = getEmbeddingModel();
  if (model === "text-embedding-3-large") return 3_072;
  if (model === "text-embedding-3-small" || model === "text-embedding-ada-002") {
    return 1_536;
  }

  // AI-Buyense currently supports OpenAI embedding models whose native vector
  // width is known above. Unknown models fail closed instead of silently
  // creating/searching a Qdrant collection with the wrong vector width.
  throw new Error(
    `Unsupported embedding model for native dimensions: ${model}`,
  );
}

export async function warmOpenAiConnection() {
  if (!isOpenAiConfigured()) return;

  const now = Date.now();
  // Rate-limit failed bootstrap warmups too: an unavailable provider must not
  // trigger a new network request on every storefront runtime-config load.
  if (now - openaiWarmupAttemptedAt < 5 * 60_000) {
    return Promise.resolve();
  }
  openaiWarmupAttemptedAt = now;
  if (openaiWarmupCompletedAt > 0 && now - openaiWarmupCompletedAt < 5 * 60_000) {
    return;
  }

  if (openaiWarmupPromise) {
    return openaiWarmupPromise;
  }

  const startedAt = now;
  const client = getOpenAiClient();

  // Warm the exact embeddings endpoint used by storefront search. A models
  // metadata request can leave the first embeddings POST paying a separate
  // connection/TLS path.
  const warmupRequest = client.embeddings.create(
    {
      model: getEmbeddingModel(),
      input: "warmup",
      dimensions: getEmbeddingDimensions(),
      encoding_format: "base64",
    },
    {
      timeout: 2_500,
      maxRetries: 0,
    },
  );

  openaiWarmupPromise = warmupRequest
    .withResponse()
    .then(() => {
      openaiWarmupCompletedAt = Date.now();
      console.log("[AI Search][PERF] OpenAI embedding endpoint warmup complete", {
        durationMs: openaiWarmupCompletedAt - startedAt,
      });
    })
    .catch((error) => {
      console.warn("[AI Search][PERF] OpenAI connection warmup failed", {
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
    })
    .finally(() => {
      openaiWarmupPromise = null;
    });

  return openaiWarmupPromise;
}

export type EmbeddingRequestDiagnostics = {
  clientRequestId: string;
  requestId: string | null;
  endToEndMs: number;
  openAiProcessingMs: number | null;
  networkAndSdkMs: number | null;
  timeoutMs: number;
  maxRetries: number;
  remainingRequests: string | null;
  remainingTokens: string | null;
  resetRequests: string | null;
  resetTokens: string | null;
  responseEncoding: "base64";
  clientAgeMs: number;
  clientRequestOrdinal: number;
};

type CreateEmbeddingOptions = {
  maxRetries?: number;
  timeoutMs?: number;
  onDiagnostics?: (diagnostics: EmbeddingRequestDiagnostics) => void;
  usageContext?: {
    shop?: string | null;
    operation?: "QUERY_EMBEDDING" | "PRODUCT_EMBEDDING" | "EMBEDDING";
  };
};

function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export async function createEmbedding(
  input: string,
  options: CreateEmbeddingOptions = {},
): Promise<number[]> {
  const text = input.trim();

  if (!text) {
    throw new Error("Embedding input cannot be empty");
  }

  const timeoutMs = options.timeoutMs ?? positiveInteger(
    process.env.AI_SEARCH_EMBEDDING_TIMEOUT_MS,
    3_000,
  );
  const maxRetries = options.maxRetries ?? 2;
  const clientRequestId = crypto.randomUUID();
  const client = getOpenAiClient();
  const clientRequestOrdinal = ++openaiRequestCount;
  const startedAt = Date.now();
  const embeddingRequest = client.embeddings.create(
    {
      model: getEmbeddingModel(),
      input: text,
      dimensions: getEmbeddingDimensions(),
      // Base64 carries the same float32 vector in a substantially smaller
      // response than a JSON array containing hundreds of decimal strings.
      encoding_format: "base64",
    },
    {
      timeout: timeoutMs,
      maxRetries,
      headers: { "X-Client-Request-Id": clientRequestId },
    },
  );
  let apiResult: Awaited<ReturnType<typeof embeddingRequest.withResponse>>;
  try {
    apiResult = await embeddingRequest.withResponse();
  } catch (error) {
    const failure = error as {
      name?: string;
      message?: string;
      status?: number;
      request_id?: string;
      requestID?: string;
    };
    console.error("[AI Search][PERF] OpenAI embedding request failed", {
      model: getEmbeddingModel(),
      inputLength: text.length,
      endToEndMs: Date.now() - startedAt,
      timeoutMs,
      maxRetries,
      clientRequestId,
      requestId: failure.request_id ?? failure.requestID ?? null,
      status: failure.status ?? null,
      errorName: failure.name ?? "Error",
      error: failure.message ?? "Unknown embedding error",
    });
    throw error;
  }

  const { data: response, response: rawResponse, request_id: requestId } =
    apiResult;

  const endToEndMs = Date.now() - startedAt;
  const processingHeader = rawResponse.headers.get("openai-processing-ms");
  const parsedProcessingMs = processingHeader === null
    ? Number.NaN
    : Number.parseFloat(processingHeader);
  const openAiProcessingMs = Number.isFinite(parsedProcessingMs)
    ? parsedProcessingMs
    : null;

  options.onDiagnostics?.({
    clientRequestId,
    requestId,
    endToEndMs,
    openAiProcessingMs,
    networkAndSdkMs: openAiProcessingMs === null
      ? null
      : Math.max(0, Math.round(endToEndMs - openAiProcessingMs)),
    timeoutMs,
    maxRetries,
    remainingRequests: rawResponse.headers.get("x-ratelimit-remaining-requests"),
    remainingTokens: rawResponse.headers.get("x-ratelimit-remaining-tokens"),
    resetRequests: rawResponse.headers.get("x-ratelimit-reset-requests"),
    resetTokens: rawResponse.headers.get("x-ratelimit-reset-tokens"),
    responseEncoding: "base64",
    clientAgeMs: Math.max(0, Date.now() - openaiClientCreatedAt),
    clientRequestOrdinal,
  });

  recordOpenAiUsageSafe({
    shop: options.usageContext?.shop ?? null,
    operation: options.usageContext?.operation ?? "EMBEDDING",
    model: getEmbeddingModel(),
    requestId,
    inputTokens: response.usage?.prompt_tokens ?? response.usage?.total_tokens ?? 0,
    outputTokens: 0,
    totalTokens: response.usage?.total_tokens ?? response.usage?.prompt_tokens ?? 0,
    headers: rawResponse.headers,
  });

  const encodedEmbedding = response.data[0]?.embedding as unknown;
  const embedding = typeof encodedEmbedding === "string"
    ? decodeBase64Float32(encodedEmbedding)
    : Array.isArray(encodedEmbedding)
      ? encodedEmbedding.filter((value): value is number => typeof value === "number")
      : null;

  if (!embedding) {
    throw new Error("OpenAI did not return an embedding");
  }

  return embedding;
}

export async function createEmbeddings(
  inputs: string[],
  options: CreateEmbeddingOptions = {},
): Promise<number[][]> {
  const texts = inputs.map((input) => input.trim());
  if (texts.length === 0 || texts.some((text) => !text)) {
    throw new Error("Embedding inputs cannot be empty");
  }
  if (texts.length === 1) {
    return [await createEmbedding(texts[0], options)];
  }

  const timeoutMs = options.timeoutMs ?? positiveInteger(
    process.env.AI_SEARCH_EMBEDDING_TIMEOUT_MS,
    3_000,
  );
  const maxRetries = options.maxRetries ?? 2;
  const clientRequestId = crypto.randomUUID();
  const client = getOpenAiClient();
  const clientRequestOrdinal = ++openaiRequestCount;
  const startedAt = Date.now();
  const embeddingRequest = client.embeddings.create(
    {
      model: getEmbeddingModel(),
      input: texts,
      dimensions: getEmbeddingDimensions(),
      encoding_format: "base64",
    },
    {
      timeout: timeoutMs,
      maxRetries,
      headers: { "X-Client-Request-Id": clientRequestId },
    },
  );

  let apiResult: Awaited<ReturnType<typeof embeddingRequest.withResponse>>;
  try {
    apiResult = await embeddingRequest.withResponse();
  } catch (error) {
    const failure = error as {
      name?: string;
      message?: string;
      status?: number;
      request_id?: string;
      requestID?: string;
    };
    console.error("[AI Search][PERF] OpenAI batch embedding request failed", {
      model: getEmbeddingModel(),
      inputCount: texts.length,
      inputLength: texts.reduce((sum, text) => sum + text.length, 0),
      endToEndMs: Date.now() - startedAt,
      timeoutMs,
      maxRetries,
      clientRequestId,
      requestId: failure.request_id ?? failure.requestID ?? null,
      status: failure.status ?? null,
      errorName: failure.name ?? "Error",
      error: failure.message ?? "Unknown embedding error",
    });
    throw error;
  }

  const { data: response, response: rawResponse, request_id: requestId } =
    apiResult;
  const endToEndMs = Date.now() - startedAt;
  const processingHeader = rawResponse.headers.get("openai-processing-ms");
  const parsedProcessingMs = processingHeader === null
    ? Number.NaN
    : Number.parseFloat(processingHeader);
  const openAiProcessingMs = Number.isFinite(parsedProcessingMs)
    ? parsedProcessingMs
    : null;

  options.onDiagnostics?.({
    clientRequestId,
    requestId,
    endToEndMs,
    openAiProcessingMs,
    networkAndSdkMs: openAiProcessingMs === null
      ? null
      : Math.max(0, Math.round(endToEndMs - openAiProcessingMs)),
    timeoutMs,
    maxRetries,
    remainingRequests: rawResponse.headers.get("x-ratelimit-remaining-requests"),
    remainingTokens: rawResponse.headers.get("x-ratelimit-remaining-tokens"),
    resetRequests: rawResponse.headers.get("x-ratelimit-reset-requests"),
    resetTokens: rawResponse.headers.get("x-ratelimit-reset-tokens"),
    responseEncoding: "base64",
    clientAgeMs: Math.max(0, Date.now() - openaiClientCreatedAt),
    clientRequestOrdinal,
  });

  recordOpenAiUsageSafe({
    shop: options.usageContext?.shop ?? null,
    operation: options.usageContext?.operation ?? "EMBEDDING",
    model: getEmbeddingModel(),
    requestId,
    inputTokens: response.usage?.prompt_tokens ?? response.usage?.total_tokens ?? 0,
    outputTokens: 0,
    totalTokens: response.usage?.total_tokens ?? response.usage?.prompt_tokens ?? 0,
    headers: rawResponse.headers,
  });

  const embeddings = [...response.data]
    .sort((left, right) => left.index - right.index)
    .map((item) => {
      const encodedEmbedding = item.embedding as unknown;
      if (typeof encodedEmbedding === "string") {
        return decodeBase64Float32(encodedEmbedding);
      }
      if (Array.isArray(encodedEmbedding)) {
        return encodedEmbedding.filter(
          (value): value is number => typeof value === "number",
        );
      }
      throw new Error("OpenAI did not return a valid batch embedding");
    });
  if (embeddings.length !== texts.length) {
    throw new Error(
      `OpenAI returned ${embeddings.length} embeddings for ${texts.length} inputs`,
    );
  }
  return embeddings;
}

function decodeBase64Float32(value: string) {
  const bytes = Buffer.from(value, "base64");
  if (bytes.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) {
    throw new Error("OpenAI returned an invalid base64 embedding");
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const vector = new Array<number>(bytes.byteLength / Float32Array.BYTES_PER_ELEMENT);
  for (let index = 0; index < vector.length; index += 1) {
    vector[index] = view.getFloat32(
      index * Float32Array.BYTES_PER_ELEMENT,
      true,
    );
  }
  return vector;
}
