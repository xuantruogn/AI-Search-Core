import { getOpenAiClient, isOpenAiConfigured } from "./embeddings.server";

export type OpenAiQueryRewriteResult = {
  status: "completed" | "incomplete";
  outputText: string;
  finishReason: string | null;
  requestId: string | null;
  headers: Headers | null;
  usage: {
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
};

function safeTokenCount(value: number | null | undefined) {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value ?? 0)) : 0;
}

export function getOpenAiQueryRewriteModel() {
  return (
    process.env.OPENAI_QUERY_REWRITE_MODEL?.trim() ||
    "gpt-4.1-mini"
  );
}

export function isOpenAiQueryRewriteConfigured() {
  return isOpenAiConfigured() && Boolean(getOpenAiQueryRewriteModel());
}

export async function generateOpenAiQueryRewrite({
  model,
  instructions,
  input,
  schema,
  maxOutputTokens,
  timeoutMs,
}: {
  model: string;
  instructions: string;
  input: string;
  schema: Record<string, unknown>;
  maxOutputTokens: number;
  timeoutMs: number;
}): Promise<OpenAiQueryRewriteResult> {
  if (!model) {
    throw new Error("OPENAI_QUERY_REWRITE_MODEL is not configured.");
  }

  const request = getOpenAiClient().responses.create(
    {
      model,
      instructions,
      input,
      max_output_tokens: maxOutputTokens,
      store: false,
      text: {
        format: {
          type: "json_schema",
          name: "shop_search_query_rewrite",
          strict: true,
          schema,
        },
      },
    },
    {
      timeout: timeoutMs,
      maxRetries: 0,
    },
  );

  const {
    data: response,
    response: rawResponse,
    request_id: requestId,
  } = await request.withResponse();

  const inputTokens = safeTokenCount(response.usage?.input_tokens);
  const outputTokens = safeTokenCount(response.usage?.output_tokens);
  const cachedInputTokens = safeTokenCount(
    response.usage?.input_tokens_details?.cached_tokens,
  );
  const incompleteReason =
    response.status === "incomplete"
      ? response.incomplete_details?.reason ?? "incomplete"
      : null;

  return {
    status:
      response.status === "completed" && response.output_text.trim()
        ? "completed"
        : "incomplete",
    outputText: response.output_text.trim(),
    finishReason: incompleteReason,
    requestId: requestId ?? null,
    headers: rawResponse.headers,
    usage: {
      inputTokens,
      cachedInputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
    },
  };
}
