import { QdrantClient } from "@qdrant/js-client-rest";
import { getEmbeddingDimensions } from "./embeddings.server";

export const VECTOR_SIZE = getEmbeddingDimensions();

export function buildQdrantV9CollectionName(
  baseCollection: string,
  vectorSize: number,
) {
  const base = baseCollection.trim() || "ai_search_products";
  if (!Number.isSafeInteger(vectorSize) || vectorSize <= 0) {
    throw new Error(`Invalid Qdrant vector size: ${vectorSize}`);
  }
  return `${base}_v9_${vectorSize}_bm25`;
}

// QDRANT_COLLECTION remains the legacy/base collection name for compatibility
// with existing environments. V9 writes to a schema-versioned collection so a
// live 768D unnamed-vector collection can never be mutated in place into the
// 1536D/3072D named dense + BM25 schema.
const QDRANT_COLLECTION_BASE =
  process.env.QDRANT_COLLECTION?.trim() || "ai_search_products";

export const QDRANT_COLLECTION =
  process.env.QDRANT_COLLECTION_V9?.trim() ||
  buildQdrantV9CollectionName(QDRANT_COLLECTION_BASE, VECTOR_SIZE);
export const DENSE_VECTOR_NAME = "dense";
export const BM25_VECTOR_NAME = "bm25";
export const BM25_MODEL = "qdrant/bm25";
export const BM25_OPTIONS = {
  tokenizer: "multilingual" as const,
  lowercase: true,
  ascii_folding: true,
  stopwords: { languages: [], custom: [] },
  stemmer: { type: "none" as const },
};

let qdrantClient: QdrantClient | null = null;
let qdrantFingerprint = "";

export function isQdrantConfigured() {
  return Boolean(
    process.env.QDRANT_URL?.trim() && process.env.QDRANT_API_KEY?.trim(),
  );
}

export function getQdrantClient() {
  const url = process.env.QDRANT_URL?.trim();
  const apiKey = process.env.QDRANT_API_KEY?.trim();

  if (!url) {
    throw new Error("Missing QDRANT_URL environment variable");
  }

  if (!apiKey) {
    throw new Error("Missing QDRANT_API_KEY environment variable");
  }

  const fingerprint = `${url}\u0000${apiKey}`;

  if (!qdrantClient || qdrantFingerprint !== fingerprint) {
    qdrantClient = new QdrantClient({ url, apiKey });
    qdrantFingerprint = fingerprint;
    // A different endpoint/key must be re-validated even in the same dev
    // process after Shopify CLI reloads environment variables.
    ensuredAt = 0;
  }

  return qdrantClient;
}

function readPositiveInteger(name: string, fallback: number) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

const ENSURE_TTL_MS = readPositiveInteger(
  "AI_SEARCH_QDRANT_ENSURE_TTL_MS",
  6 * 60 * 60_000,
);

let ensuredAt = 0;
let ensurePromise: Promise<{
  created: boolean;
  collection: string;
}> | null = null;

function validateCollectionVectorConfig(
  info: Awaited<ReturnType<QdrantClient["getCollection"]>>,
) {
  const vectors = info.config?.params?.vectors;
  const sparseVectors = info.config?.params?.sparse_vectors;
  if (!vectors || !("dense" in vectors)) {
    throw new Error(
      `Qdrant collection ${QDRANT_COLLECTION} must expose named dense vector "${DENSE_VECTOR_NAME}"`,
    );
  }
  const dense = vectors[DENSE_VECTOR_NAME];
  if (!dense || dense.size !== VECTOR_SIZE || dense.distance !== "Cosine") {
    throw new Error(
      `Qdrant collection ${QDRANT_COLLECTION} has incompatible dense config; expected ${DENSE_VECTOR_NAME}=${VECTOR_SIZE}D Cosine`,
    );
  }
  const sparse = sparseVectors?.[BM25_VECTOR_NAME];
  if (!sparse || sparse.modifier !== "idf") {
    throw new Error(
      `Qdrant collection ${QDRANT_COLLECTION} must expose sparse vector "${BM25_VECTOR_NAME}" with IDF modifier`,
    );
  }
}

function payloadIndexDataType(value: unknown): string | null {
  if (typeof value === "string") return value.toLowerCase();
  if (!value || typeof value !== "object") return null;

  const record = value as Record<string, unknown>;
  const dataType = record.data_type ?? record.type;
  return typeof dataType === "string" ? dataType.toLowerCase() : null;
}

async function ensureKeywordPayloadIndex(
  fieldName: "shop" | "productId" | "semanticTerms" | "semanticKinds",
  existingSchema: unknown,
) {
  if (existingSchema) {
    const dataType = payloadIndexDataType(existingSchema);
    if (dataType === "keyword") return;

    // A filterable field with the wrong index type is not equivalent to a
    // keyword index. Failing here produces a deterministic configuration error
    // instead of the much less useful runtime Qdrant "index required" search
    // failure that originally occurred for the shop tenant filter.
    throw new Error(
      `Qdrant payload index ${fieldName} has incompatible type ${dataType ?? "unknown"}; expected keyword`,
    );
  }

  const qdrant = getQdrantClient();
  console.log(`[AI Search] Creating Qdrant payload index: ${fieldName}`);

  try {
    await qdrant.createPayloadIndex(QDRANT_COLLECTION, {
      field_name: fieldName,
      field_schema: "keyword",
    });
  } catch (error) {
    // Two processes can race to create the same payload index. Only pay for a
    // second collection read on the exceptional/racing path.
    const refreshed = await qdrant.getCollection(QDRANT_COLLECTION);
    if (!refreshed.payload_schema?.[fieldName]) throw error;
  }

  console.log(`[AI Search] Qdrant payload index ready: ${fieldName}`);
}

async function ensureIntegerPayloadIndex(
  fieldName: "semanticPayloadVersion",
  existingSchema: unknown,
) {
  if (existingSchema) {
    const dataType = payloadIndexDataType(existingSchema);
    if (dataType === "integer") return;
    throw new Error(
      `Qdrant payload index ${fieldName} has incompatible type ${dataType ?? "unknown"}; expected integer`,
    );
  }

  const qdrant = getQdrantClient();
  console.log(`[AI Search] Creating Qdrant payload index: ${fieldName}`);
  try {
    await qdrant.createPayloadIndex(QDRANT_COLLECTION, {
      field_name: fieldName,
      field_schema: "integer",
    });
  } catch (error) {
    const refreshed = await qdrant.getCollection(QDRANT_COLLECTION);
    if (!refreshed.payload_schema?.[fieldName]) throw error;
  }
  console.log(`[AI Search] Qdrant payload index ready: ${fieldName}`);
}

async function ensureBooleanPayloadIndex(
  fieldName: "searchable" | "semanticPayloadComplete",
  existingSchema: unknown,
) {
  if (existingSchema) {
    const dataType = payloadIndexDataType(existingSchema);
    if (dataType === "bool" || dataType === "boolean") return;
    throw new Error(
      `Qdrant payload index ${fieldName} has incompatible type ${dataType ?? "unknown"}; expected bool`,
    );
  }

  const qdrant = getQdrantClient();
  console.log(`[AI Search] Creating Qdrant payload index: ${fieldName}`);
  try {
    await qdrant.createPayloadIndex(QDRANT_COLLECTION, {
      field_name: fieldName,
      field_schema: "bool",
    });
  } catch (error) {
    const refreshed = await qdrant.getCollection(QDRANT_COLLECTION);
    if (!refreshed.payload_schema?.[fieldName]) throw error;
  }
  console.log(`[AI Search] Qdrant payload index ready: ${fieldName}`);
}

async function ensureProductCollectionFresh() {
  const qdrant = getQdrantClient();
  const collections = await qdrant.getCollections();
  const exists = collections.collections.some(
    (collection) => collection.name === QDRANT_COLLECTION,
  );

  let created = false;

  if (!exists) {
    try {
      await qdrant.createCollection(QDRANT_COLLECTION, {
        vectors: {
          [DENSE_VECTOR_NAME]: {
            size: VECTOR_SIZE,
            distance: "Cosine",
          },
        },
        sparse_vectors: {
          [BM25_VECTOR_NAME]: {
            modifier: "idf",
          },
        },
      });
      created = true;
      console.log("[AI Search] Qdrant collection created:", QDRANT_COLLECTION);
    } catch (error) {
      // Collection creation is also safe to race across app instances. If a
      // sibling process won the race, continue after verifying existence.
      const afterRace = await qdrant.getCollections();
      const nowExists = afterRace.collections.some(
        (collection) => collection.name === QDRANT_COLLECTION,
      );
      if (!nowExists) throw error;
    }
  }

  const info = await qdrant.getCollection(QDRANT_COLLECTION);
  validateCollectionVectorConfig(info);

  const payloadSchema = info.payload_schema ?? {};
  await Promise.all([
    ensureKeywordPayloadIndex("shop", payloadSchema.shop),
    ensureKeywordPayloadIndex("productId", payloadSchema.productId),
    ensureKeywordPayloadIndex("semanticTerms", payloadSchema.semanticTerms),
    ensureKeywordPayloadIndex("semanticKinds", payloadSchema.semanticKinds),
    ensureIntegerPayloadIndex(
      "semanticPayloadVersion",
      payloadSchema.semanticPayloadVersion,
    ),
    ensureBooleanPayloadIndex("searchable", payloadSchema.searchable),
    ensureBooleanPayloadIndex(
      "semanticPayloadComplete",
      payloadSchema.semanticPayloadComplete,
    ),
  ]);
  ensuredAt = Date.now();

  return {
    created,
    collection: QDRANT_COLLECTION,
  };
}

export async function ensureProductCollection(options?: { force?: boolean }) {
  const force = options?.force ?? false;

  if (!force && ensuredAt > 0 && Date.now() - ensuredAt < ENSURE_TTL_MS) {
    return { created: false, collection: QDRANT_COLLECTION };
  }

  if (ensurePromise) return ensurePromise;

  ensurePromise = ensureProductCollectionFresh();

  try {
    return await ensurePromise;
  } catch (error) {
    ensuredAt = 0;
    throw error;
  } finally {
    ensurePromise = null;
  }
}
