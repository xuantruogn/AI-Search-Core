import { QdrantClient } from "@qdrant/js-client-rest";

export const QDRANT_COLLECTION =
  process.env.QDRANT_COLLECTION?.trim() || "ai_search_products";

export const VECTOR_SIZE = 768;

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
  if (!vectors || !("size" in vectors) || !("distance" in vectors)) {
    throw new Error(
      `Qdrant collection ${QDRANT_COLLECTION} uses a named/unsupported vector configuration; AI Search expects one unnamed ${VECTOR_SIZE}-dimension Cosine vector`,
    );
  }

  if (vectors.size !== VECTOR_SIZE || vectors.distance !== "Cosine") {
    throw new Error(
      `Qdrant collection ${QDRANT_COLLECTION} has incompatible vector config: size=${vectors.size}, distance=${vectors.distance}; expected size=${VECTOR_SIZE}, distance=Cosine`,
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
  fieldName: "shop" | "productId",
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
          size: VECTOR_SIZE,
          distance: "Cosine",
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
