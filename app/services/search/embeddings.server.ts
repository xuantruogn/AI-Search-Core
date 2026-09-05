import OpenAI from "openai";

let openaiClient: OpenAI | null = null;
let openaiApiKey: string | null = null;

export function isOpenAiConfigured() {
  return Boolean(process.env.OPENAI_API_KEY?.trim());
}

function getOpenAiClient() {
  const apiKey = process.env.OPENAI_API_KEY?.trim();

  if (!apiKey) {
    throw new Error("Missing OPENAI_API_KEY environment variable");
  }

  // Shopify CLI can reload .env during development. Recreate the client when
  // the key changes instead of freezing the value at module-import time.
  if (!openaiClient || openaiApiKey !== apiKey) {
    openaiClient = new OpenAI({ apiKey });
    openaiApiKey = apiKey;
  }

  return openaiClient;
}

export function getEmbeddingModel() {
  return process.env.OPENAI_EMBEDDING_MODEL?.trim() || "text-embedding-3-small";
}

export async function createEmbedding(input: string): Promise<number[]> {
  const text = input.trim();

  if (!text) {
    throw new Error("Embedding input cannot be empty");
  }

  const response = await getOpenAiClient().embeddings.create({
    model: getEmbeddingModel(),
    input: text,
    dimensions: 768,
    encoding_format: "float",
  });

  const embedding = response.data[0]?.embedding;

  if (!embedding) {
    throw new Error("OpenAI did not return an embedding");
  }

  return embedding;
}
